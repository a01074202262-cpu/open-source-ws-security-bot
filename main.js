// main.js - 봇 시작점 + 자동 보안 시스템 (+ Render용 헬스체크 서버)
const http = require('http');
const { Client, GatewayIntentBits, Partials, AuditLogEvent, PermissionFlagsBits } = require('discord.js');
const { initStore, shutdownStore, onMemberJoined, trapCheck, gs, save, log, addWarn, isExempt, isWatched, addWatch, state, isBotAdmin, addGuildAuth } = require('./server');
const { handleCommand } = require('./cmd');
const guard = require('./guard');
const plus = require('./plus');
const fun = require('./fun');
const { startVerification, handleVerifyDM } = require('./verify');
const { extractUrls, isTrusted, scanUrl, defang } = require('./linkscan');
const { nameKeys, keysSimilar } = require('./namecheck');
const moderation = require('./moderation');
const antiNuke = require('./antinuke');

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('환경변수 DISCORD_TOKEN 이 없어요. Render > Environment 에서 설정하세요.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,       // 개발자 포털에서 SERVER MEMBERS INTENT 켜야 함
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,     // 개발자 포털에서 MESSAGE CONTENT INTENT 켜야 함
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.DirectMessages,     // 인증 코드를 DM 으로 받기 위해 필요
  ],
  partials: [Partials.Channel, Partials.Message],
});

/* ═════════════ 자동 보안 시스템 ═════════════ */

const spamMap = new Map();   // guild:user -> [timestamps]
const joinMap = new Map();   // guild -> [timestamps]

const INVITE_RE = /(discord\.(gg|com\/invite)|discordapp\.com\/invite|dsc\.gg)\/[\w-]+/i;
const LINK_RE = /https?:\/\/\S+|www\.\S+/i;

const MIN = 60 * 1000;
const DDOS_WINDOW = 5 * MIN;   // 5분 안에
const DDOS_COUNT = 5;          // 비슷한 이름 5명
const DDOS_FLAG_TIME = 30 * MIN;

async function noticeTemp(channel, text, ms = 6000) {
  const n = await channel.send({ content: text, allowedMentions: { parse: [] } }).catch(() => null);
  if (n) setTimeout(() => n.delete().catch(() => {}), ms);
}

// 일반 처벌: 삭제 + (타임아웃) + (경고)
async function punishDelete(message, reason, { timeoutMs = 0, warn = false } = {}) {
  await message.delete().catch(() => {});
  if (timeoutMs && message.member?.moderatable) {
    await message.member.timeout(timeoutMs, `[AutoMod] ${reason}`).catch(() => {});
  }
  let info = '';
  if (warn && message.member) {
    const { count } = await addWarn(message.guild, message.member, `[자동] ${reason}`);
    info = ` (경고 ${count}회)`;
  }
  await noticeTemp(message.channel, `🛡️ <@${message.author.id}>, ${reason}${info}`);
  await log(message.guild, `🛡️ 자동 보안 | ${message.author.tag} | ${reason}`);
}

// 경계 대상 처벌: 메시지 삭제 + 즉시 밴
async function banWatched(message, reason) {
  await message.delete().catch(() => {});
  if (message.member?.bannable) {
    await message.member.ban({ reason: `[AutoMod/경계] ${reason}`, deleteMessageSeconds: 3600 }).catch(() => {});
  }
  await noticeTemp(message.channel, `🚫 경계 대상 **${message.author.tag}** 님을 차단했어요. (${reason})`, 8000);
  await log(message.guild, `🚫 경계 대상 차단 | ${message.author.tag} (${message.author.id}) | ${reason}`);
}

// 처벌했으면 true 반환 (이 경우 명령어 처리는 건너뜀)
async function autoMod(message) {
  const g = gs(message.guild.id);
  if (isExempt(message.member)) return false;
  const text = message.content;
  const watched = isWatched(message.guild.id, message.author.id);
  const urls = extractUrls(text);
  const untrusted = urls.filter((u) => !isTrusted(u, g.trustedDomains));

  // 0) 경계 대상: 훨씬 엄격 (초대/미검증 링크/멘션 3개 이상 → 즉시 밴)
  if (watched) {
    if (INVITE_RE.test(text)) { await banWatched(message, '초대 링크'); return true; }
    if (untrusted.length) { await banWatched(message, '검증되지 않은 링크'); return true; }
    const mc = message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 5 : 0);
    if (mc >= 3) { await banWatched(message, '멘션 도배'); return true; }
  }

  // 1) 초대 링크
  if (g.antiInvite && INVITE_RE.test(text)) {
    await punishDelete(message, '초대 링크는 보낼 수 없어요.', { warn: true });
    return true;
  }

  // 2) 모든 링크 차단 (옵션)
  if (g.antiLink && LINK_RE.test(text)) {
    await punishDelete(message, '링크는 보낼 수 없어요.', { warn: true });
    return true;
  }

  // 3) 미검증 링크: 봇이 직접 접속/분석해서 악성이면 삭제 + 1분 타임아웃
  if (g.antiScan && untrusted.length) {
    for (const url of untrusted.slice(0, 3)) {
      const r = await scanUrl(url, g.trustedDomains);
      if (r.malicious) {
        await punishDelete(message, '악성 링크가 감지되어 메시지를 삭제했어요. (1분 타임아웃)', { timeoutMs: MIN });
        await log(message.guild,
          `🦠 악성 링크 | ${message.author.tag} (${message.author.id}) | 점수 ${r.score}\n` +
          `주소: ${defang(r.url)}${r.finalUrl !== r.url ? ` → ${defang(r.finalUrl)}` : ''}\n` +
          `근거: ${r.reasons.join(' / ')}`);
        return true;
      }
    }
  }

  // 4) 금칙어
  if (g.antiBadword && g.badWords.length) {
    const lower = text.toLowerCase().replace(/\s+/g, '');
    if (g.badWords.some((w) => lower.includes(w.replace(/\s+/g, '')))) {
      await punishDelete(message, '금칙어가 포함된 메시지예요.', { warn: true });
      return true;
    }
  }

  // 5) 멘션 도배
  if (g.antiMention) {
    const count = message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 5 : 0);
    if (count >= g.mentionLimit) {
      await punishDelete(message, `멘션 도배는 안 돼요. (${count}개)`, { timeoutMs: 10 * MIN });
      return true;
    }
  }

  // 6) 메시지 도배 (경계 대상은 기준이 더 엄격하고 걸리면 밴)
  if (g.antiSpam || watched) {
    const limit = watched ? Math.min(3, g.spamLimit) : g.spamLimit;
    const secs = watched ? Math.max(6, g.spamSeconds) : g.spamSeconds;
    const key = `${message.guild.id}:${message.author.id}`;
    const now = Date.now();
    const arr = (spamMap.get(key) || []).filter((t) => now - t < secs * 1000);
    arr.push(now);
    spamMap.set(key, arr);
    if (arr.length >= limit) {
      spamMap.delete(key);
      if (watched) { await banWatched(message, '도배'); return true; }
      const recent = await message.channel.messages.fetch({ limit: 30 }).catch(() => null);
      if (recent) {
        const mine = recent.filter((m) => m.author.id === message.author.id && now - m.createdTimestamp < 30000);
        await message.channel.bulkDelete(mine, true).catch(() => {});
      }
      await punishDelete(message, '도배가 감지되어 10분 타임아웃됐어요.', { timeoutMs: 10 * MIN });
      return true;
    }
  }

  // 7) 같은 내용 반복 도배 (20초 안에 같은 말 4번)
  if (g.antiSpam && plus.isRepeatSpam(message)) {
    const recent = await message.channel.messages.fetch({ limit: 30 }).catch(() => null);
    if (recent) {
      const mine = recent.filter((m) => m.author.id === message.author.id && Date.now() - m.createdTimestamp < 30000);
      await message.channel.bulkDelete(mine, true).catch(() => {});
    }
    await punishDelete(message, '같은 내용을 반복해서 보내 도배로 판단돼 10분 타임아웃됐어요.', { timeoutMs: 10 * MIN });
    return true;
  }
  return false;
}

// 인증 버튼 (재시작해도 동작하도록 customId 로 처리)
client.on('interactionCreate', async (i) => {
  try {
    if (i.isButton() && i.customId === 'verify:start') await startVerification(i);
    else if (await plus.handleInteraction(i)) { /* 역할 버튼 */ }
    else await fun.handleInteraction(i);   // 추첨 참가 / 티켓 열기·닫기 버튼
  } catch (err) {
    console.error('[interaction 오류]', err);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) {            // DM: 인증 코드 입력
    try { await handleVerifyDM(message); } catch (err) { console.error('[인증 DM 오류]', err); }
    return;
  }
  if (!message.member) return;
  try {
    if (await trapCheck(message)) return;
    if (await autoMod(message)) return;
    await plus.suspicionCheck(message);   // 애매한 의심 행동은 처벌 대신 로그 채널에 유저 정보를 남겨요
    await plus.afkHandler(message);   // 잠수 해제 / 잠수 중인 사람 멘션 안내
    await handleCommand(message);
  } catch (err) {
    console.error('[messageCreate 오류]', err);
  }
});

// 수정한 메시지로 필터 우회하는 것 방지
client.on('messageUpdate', async (_old, message) => {
  try {
    if (message.partial) message = await message.fetch();
    if (message.author?.bot || !message.guild || !message.member) return;
    await autoMod(message);
  } catch { /* 무시 */ }
});

/* ─── 디도스 감지: 5분 안에 비슷한 이름 5명 → 1명만 남기고 전부 밴, 남은 1명은 경계 ─── */
async function checkDdos(member) {
  const gid = member.guild.id;
  const keys = nameKeys(member.user.username, member.user.globalName);
  if (!keys.length) return false;
  const now = Date.now();

  // 이미 감지된 이름 패턴이 계속 들어오면 즉시 밴
  const flags = (state.ddosFlags.get(gid) || []).filter((f) => f.until > now);
  state.ddosFlags.set(gid, flags);
  if (flags.some((f) => keysSimilar(keys, [f.key]))) {
    if (member.bannable) await member.ban({ reason: '[AutoMod] 디도스 의심 (비슷한 이름 대량 입장)', deleteMessageSeconds: 3600 }).catch(() => {});
    await log(member.guild, `🚫 디도스 패턴 추가 입장 차단 | ${member.user.tag} (${member.id})`);
    return true;
  }

  const arr = (state.nameLog.get(gid) || []).filter((x) => now - x.at < DDOS_WINDOW);
  arr.push({ id: member.id, keys, at: now });
  state.nameLog.set(gid, arr);

  const group = arr.filter((x) => keysSimilar(x.keys, keys));
  if (group.length < DDOS_COUNT) return false;

  // 감지! 가장 먼저 들어온 1명만 남기고 나머지는 밴
  const keep = group[0];
  flags.push({ key: keys[0], until: now + DDOS_FLAG_TIME, keptId: keep.id });
  let banned = 0;
  for (const entry of group) {
    if (entry.id === keep.id) continue;
    const mem = await member.guild.members.fetch(entry.id).catch(() => null);
    if (mem?.bannable) {
      await mem.ban({ reason: '[AutoMod] 디도스 의심 (비슷한 이름 대량 입장)', deleteMessageSeconds: 3600 }).then(() => banned++).catch(() => {});
    }
  }
  state.nameLog.set(gid, arr.filter((x) => !group.some((g2) => g2.id === x.id) || x.id === keep.id));

  addWatch(gid, keep.id);
  await log(member.guild,
    `🚨 **디도스 감지!** 5분 안에 비슷한 이름 ${group.length}명 입장 (예: ${keys[0]})\n` +
    `→ ${banned}명 밴, <@${keep.id}> 1명은 남겨 **경계 대상**으로 지정 (${gs(gid).watchHours}시간). ` +
    `이 사람이 도배/미검증 링크를 보내면 즉시 밴돼요.`);
  return true;
}

/* ─── 입장 감시: 디도스 / 계정 나이 / 레이드 ─── */
async function joinSecurity(member) {
  const g = gs(member.guild.id);
  if (member.user.bot) return true;

  // 비상 모드(.비상 켜기): 방장이 허용한 사람 외에는 신규 입장 차단
  if ((g.emergencyUntil || 0) > Date.now() && !g.whitelist.includes(member.id) && !g.authUsers.includes(member.id) && !isBotAdmin(member.id)) {
    await member.send(`**${member.guild.name}** 은(는) 지금 비상 모드라서 신규 입장이 잠시 제한돼요. 나중에 다시 들어와주세요.`).catch(() => {});
    await member.kick('비상 모드').catch(() => {});
    await log(member.guild, `🚨 비상 모드 입장 차단 | ${member.user.tag} (${member.id})`);
    return true;
  }

  if (g.antiDdos && !g.whitelist.includes(member.id)) {
    if (await checkDdos(member)) return true;
  }

  // 최소 계정 나이
  if (g.minAccountAgeDays > 0) {
    const ageDays = (Date.now() - member.user.createdTimestamp) / 864e5;
    if (ageDays < g.minAccountAgeDays && !g.whitelist.includes(member.id)) {
      await member.send(`계정 생성 ${g.minAccountAgeDays}일 미만 계정은 **${member.guild.name}** 에 입장할 수 없어요.`).catch(() => {});
      await member.kick('최소 계정 나이 미달').catch(() => {});
      await log(member.guild, `🛡️ 계정나이 미달 킥 | ${member.user.tag} | ${ageDays.toFixed(1)}일`);
      return true;
    }
  }

  if (!g.antiRaid) return false;
  const now = Date.now();

  if ((state.raidUntil.get(member.guild.id) || 0) > now) {
    await member.send('현재 서버가 보호 모드예요. 잠시 후 다시 입장해주세요.').catch(() => {});
    await member.kick('레이드 방어 모드').catch(() => {});
    await log(member.guild, `🛡️ 레이드 방어 킥 | ${member.user.tag}`);
    return true;
  }

  const arr = (joinMap.get(member.guild.id) || []).filter((t) => now - t < 10000);
  arr.push(now);
  joinMap.set(member.guild.id, arr);

  if (arr.length >= 7) {
    state.raidUntil.set(member.guild.id, now + 2 * MIN);
    joinMap.delete(member.guild.id);
    await member.kick('레이드 방어 모드').catch(() => {});
    await log(member.guild, '🚨 **레이드 감지!** 2분 동안 신규 입장자를 자동으로 킥합니다.');
    return true;
  }
  return false;
}

client.on('guildMemberAdd', async (member) => {
  try {
    if (await guard.blacklistCheck(member)) return;   // 전역 블랙리스트 유저는 즉시 영구 차단
    if (await joinSecurity(member)) return;   // 보안 때문에 내보낸 유저에게는 환영/자동역할 X
    await onMemberJoined(member);
  } catch (err) {
    console.error('[guildMemberAdd 오류]', err);
  }
});

/* ─── 통합 안티누크: 역할 멤버십 스냅샷 + 삭제 복구 ─── */
client.on('guildCreate', (guild) => antiNuke.primeGuild(guild));
client.on('channelCreate', (channel) => {
  if (channel.guild) antiNuke.applyQuarantineToChannel(channel).catch((err) =>
    console.error(`[안티누크 신규 채널 격리 적용:${channel.guild.id}]`, err.message));
});
client.on('guildMemberAdd', (member) => antiNuke.trackMember(member));
client.on('guildMemberUpdate', (oldMember, newMember) => antiNuke.trackMember(newMember, oldMember));
client.on('guildMemberRemove', (member) => antiNuke.untrackMember(member));

client.on('channelDelete', (ch) => {
  if (ch.guild) antiNuke.handleDeletion(ch.guild, AuditLogEvent.ChannelDelete, ch)
    .catch((err) => console.error('[안티누크 채널 삭제]', err.message));
});
client.on('roleDelete', (role) => {
  antiNuke.handleDeletion(role.guild, AuditLogEvent.RoleDelete, role)
    .catch((err) => console.error('[안티누크 역할 삭제]', err.message));
});

/* ─── 임시밴 만료 처리 (30초마다) ─── */
setInterval(() => {
  const now = Date.now();
  for (const guild of client.guilds.cache.values()) {
    const g = gs(guild.id);
    for (const [uid, exp] of Object.entries(g.tempBans)) {
      if (exp <= now) {
        guild.bans.remove(uid, '임시밴 만료').catch(() => {});
        delete g.tempBans[uid];
        save();
        log(guild, `♻️ 임시밴 만료로 자동 해제 | ${uid}`);
      }
    }
  }
}, 30 * 1000);

/* ─── 봇이 서버에 추가되면: 추가한 사람을 그 서버의 인증 유저로 등록 (서버백업 권한은 없음) ───
 * 방장은 따로 등록하지 않아도 자동으로 인증 + 서버백업 권한이 있어요. (서버백업/복원/정보는 방장·봇 소유자 전용)
 * 추가한 사람을 알아내려면 봇에게 '감사 로그 보기' 권한이 있어야 해요. (초대 링크를 관리자 권한으로 만들면 자동 포함)
 */
client.on('guildCreate', async (guild) => {
  try {
    if (Date.now() - (guild.joinedTimestamp || 0) > 2 * MIN) return;   // 재시작 때 기존 서버로 오는 이벤트는 무시
    await new Promise((r) => setTimeout(r, 3000));                      // 감사 로그가 기록될 시간
    if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
      console.log(`[guildCreate] ${guild.name}: 감사 로그 권한이 없어 봇을 추가한 사람을 알 수 없어요.`);
      return;
    }
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 5 }).catch(() => null);
    const entry = logs?.entries.find((e) => e.target?.id === client.user.id && Date.now() - e.createdTimestamp < 2 * MIN);
    const adder = entry?.executor;
    if (!adder || adder.bot) return;

    if (adder.id === guild.ownerId) {
      await adder.send(`🛡️ **${guild.name}** 에 봇을 추가했어요. 방장이라서 서버백업을 포함한 모든 기능(소유자 전용 제외)을 쓸 수 있어요. \`.도움\` 으로 명령어를 확인하세요.`).catch(() => {});
      return;
    }
    if (isBotAdmin(adder.id)) return;   // 이미 전체 권한이 있는 사람
    if (addGuildAuth(guild.id, adder.id)) {
      await log(guild, `🔑 봇을 추가한 ${adder.tag} 님을 이 서버의 인증 유저로 등록했어요. (서버백업 권한 없음)`);
      await adder.send(
        `🛡️ **${guild.name}** 에 봇을 추가해주셔서 감사해요! 이 서버에서 봇 명령어를 쓸 수 있는 **인증 유저**로 등록됐어요.\n` +
        '단, `.서버백업` · `.서버복원` · `.서버백업정보` 는 서버 방장과 봇 소유자만 쓸 수 있어요. `.도움` 으로 명령어를 확인하세요.').catch(() => {});
    }
  } catch (err) {
    console.error('[guildCreate 오류]', err);
  }
});

moderation.attach(client);  // 삭제/수정 메시지 아카이브 + Discord 감사 로그 수집

guard.attach(client);   // 봇 탈취 감지 + 새 서버 블랙리스트 사전 차단
plus.attach(client);    // 봇 추가/위험 권한/웹훅/대량 처벌 감시 + 차단된 서버 자동 퇴장

/* ═════════════ 시작 ═════════════ */
client.once('ready', () => {
  console.log(`✅ ${client.user.tag} 로그인 완료 (서버 ${client.guilds.cache.size}개)`);
  // 역할 삭제 이벤트 전에 캐시에 남은 멤버-역할 관계를 스냅샷으로 유지해 복구 성공률을 높입니다.
  for (const guild of client.guilds.cache.values()) antiNuke.primeGuild(guild);
  fun.start(client);   // 알림/추첨 타이머
  plus.start(client);  // 상태 문구 + 비상 모드 자동 해제 + 차단 서버 정리
});

client.on('error', (e) => console.error('[client error]', e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

// Render Web Service 는 포트를 열어야 해요 (헬스체크용)
const PORT = process.env.PORT || 3000;
http
  .createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Security bot is running');
  })
  .listen(PORT, () => console.log(`🌐 헬스체크 서버 포트 ${PORT}`));

async function shutdown(sig) {
  console.log(`${sig} 받음 — 데이터를 저장하고 종료해요.`);
  await shutdownStore().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// 데이터를 먼저 불러온 다음에 로그인해요 (불러오기 실패 시 시작 안 함 → 빈 데이터로 덮어쓰기 방지)
initStore()
  .then(() => client.login(TOKEN))
  .catch((err) => { console.error('❌ 시작 실패:', err.message); process.exit(1); });
