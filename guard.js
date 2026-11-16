// guard.js - 전역 블랙리스트 + 봇 탈취(토큰 유출) 이상 징후 감지
//
// ⚠️ 디스코드는 봇에게 유저의 IP / HWID 를 절대 알려주지 않아요. (봇이 받는 건 유저 ID 뿐)
//    그래서 블랙리스트는 "유저 ID" 기준이에요. 같은 사람이 새 계정으로 오면 ID 가 달라서 이 방식만으로는 못 막아요.
const { EmbedBuilder, AuditLogEvent, PermissionFlagsBits } = require('discord.js');
const { blacklistStore, isOwner, log, save, OWNER_ID } = require('./server');
const { isBusy } = require('./backup');

const REASON = '블랙리스트';
const idOf = (m, args) => m.mentions.users.first()?.id || (args[0] || '').replace(/\D/g, '');

async function banEverywhere(client, userId, reason) {
  let ok = 0;
  for (const guild of client.guilds.cache.values()) {
    try { await guild.bans.create(userId, { reason: `[${REASON}] ${reason}` }); ok++; } catch { /* 권한 부족/방장 등 */ }
  }
  return ok;
}

/* ───────────── .블랙리스트 (봇 소유자 전용) ───────────── */
async function blacklistCmd(m, args) {
  const store = blacklistStore();
  const sub = (args[0] || '').toLowerCase();

  if (['추가', 'add'].includes(sub)) {
    const rest = args.slice(1);
    const id = idOf(m, rest);
    if (!/^\d{17,20}$/.test(id)) return '사용법: `.블랙리스트 추가 <유저ID|@유저> [사유]`';
    if (isOwner(id) || id === m.client.user.id) return '봇 소유자나 봇 자신은 블랙리스트에 넣을 수 없어요.';
    const reason = rest.slice(1).join(' ').trim().slice(0, 200) || '봇 탈취/테러 시도';
    const had = !!store[id];
    store[id] = { reason, at: Date.now(), by: m.author.id };
    save();
    const n = await banEverywhere(m.client, id, reason);
    await log(m.guild, `⛔ 블랙리스트 ${had ? '갱신' : '등록'} | ${id} | ${reason} | by ${m.author.tag} | ${n}개 서버에서 차단`);
    return `⛔ \`${id}\` ${had ? '정보를 갱신' : '를 블랙리스트에 등록'}했어요. 봇이 있는 **${n}개 서버**에서 영구 차단했고, 앞으로 어느 서버에 들어와도 바로 차단돼요.\n사유: ${reason}`;
  }

  if (['제거', '해제', '삭제', 'remove'].includes(sub)) {
    const id = idOf(m, args.slice(1));
    if (!store[id]) return '블랙리스트에 없는 ID예요.';
    delete store[id];
    save();
    let n = 0;
    for (const guild of m.client.guilds.cache.values()) {
      const ban = await guild.bans.fetch(id).catch(() => null);
      if (ban?.reason?.startsWith(`[${REASON}]`)) { await guild.bans.remove(id, '블랙리스트 해제').then(() => n++).catch(() => {}); }
    }
    return `✅ \`${id}\` 를 블랙리스트에서 뺐어요. (블랙리스트로 걸린 차단 ${n}개 해제)`;
  }

  if (['목록', 'list', ''].includes(sub)) {
    const entries = Object.entries(store).sort((a, b) => b[1].at - a[1].at);
    if (!entries.length) return '블랙리스트가 비어 있어요.\n`.블랙리스트 추가 <유저ID> [사유]`';
    const e = new EmbedBuilder().setColor(0xed4245).setTitle(`⛔ 블랙리스트 (${entries.length}명)`)
      .setDescription(entries.slice(0, 20).map(([id, v]) => `\`${id}\` · <t:${Math.floor(v.at / 1000)}:d> · ${v.reason}`).join('\n').slice(0, 4000))
      .setFooter({ text: entries.length > 20 ? `최근 20명만 표시 · 전체 ${entries.length}명` : '유저 ID 기준이에요 (IP/HWID 는 디스코드가 알려주지 않아요)' });
    return { embeds: [e] };
  }
  return '사용법: `.블랙리스트 추가 <유저ID> [사유]` · `.블랙리스트 제거 <유저ID>` · `.블랙리스트 목록`';
}

/* ───────────── 입장 시 즉시 차단 ───────────── */
async function blacklistCheck(member) {
  const entry = blacklistStore()[member.id];
  if (!entry) return false;
  await member.ban({ reason: `[${REASON}] ${entry.reason}` }).catch(() => {});
  await log(member.guild, `⛔ 블랙리스트 유저 입장 차단 | ${member.user.tag} (${member.id}) | ${entry.reason}`);
  return true;
}

/* ───────────── 봇 탈취 이상 징후 감지 ─────────────
 * 봇이 스스로 채널/역할을 지우는 건 .서버복원 때뿐이에요. 그 외에 봇 계정이 10초 안에 3개 이상 지우면
 * 토큰이 유출돼 누군가 봇으로 테러 중일 가능성이 커요 → 봇 소유자와 방장에게 DM + 로그 채널 알림.
 * (봇 토큰을 가진 사람의 행동 자체를 코드로 막을 순 없어서, 빠르게 알리고 토큰 재발급을 안내해요.)
 */
const tamperMap = new Map();   // guildId -> [timestamps]
const alerted = new Map();     // guildId -> 마지막 알림 시각

async function checkTamper(client, guild, type) {
  try {
    if (isBusy(guild.id)) return;   // 정상적인 서버복원 중
    if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return;
    const logs = await guild.fetchAuditLogs({ type, limit: 1 });
    const entry = logs.entries.first();
    if (!entry || entry.executor?.id !== client.user.id || Date.now() - entry.createdTimestamp > 5000) return;

    const now = Date.now();
    const arr = (tamperMap.get(guild.id) || []).filter((t) => now - t < 10000);
    arr.push(now);
    tamperMap.set(guild.id, arr);
    if (arr.length < 3 || now - (alerted.get(guild.id) || 0) < 5 * 60 * 1000) return;
    alerted.set(guild.id, now);

    const text =
      `🚨 **봇 탈취 의심!** **${guild.name}** 서버에서 봇 계정이 명령어 없이 10초 안에 채널/역할을 3개 이상 삭제했어요.\n` +
      '봇 토큰이 유출됐을 수 있어요. **지금 바로**:\n' +
      '1. 디스코드 개발자 포털 → Bot → **Reset Token** 으로 토큰을 재발급하세요.\n' +
      '2. 호스팅(Render 등) 환경변수 `DISCORD_TOKEN` 을 새 토큰으로 바꾸고 재시작하세요.\n' +
      '3. 서버 설정 → 연동에서 봇의 관리자 권한을 잠시 빼두세요.';
    await log(guild, text);
    for (const id of new Set([OWNER_ID, guild.ownerId])) {
      const u = await client.users.fetch(id).catch(() => null);
      await u?.send(text).catch(() => {});
    }
  } catch { /* 무시 */ }
}

function attach(client) {
  client.on('channelDelete', (ch) => ch.guild && checkTamper(client, ch.guild, AuditLogEvent.ChannelDelete));
  client.on('roleDelete', (role) => checkTamper(client, role.guild, AuditLogEvent.RoleDelete));
  // 새 서버에 봇이 들어가면 블랙리스트 유저를 미리 차단 (최대 200명)
  client.on('guildCreate', async (guild) => {
    const ids = Object.keys(blacklistStore()).slice(0, 200);
    for (const id of ids) await guild.bans.create(id, { reason: `[${REASON}] 사전 차단` }).catch(() => {});
  });
}

module.exports = { blacklistCmd, blacklistCheck, attach };
