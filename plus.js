// plus.js - 추가 기능 모음
//  · 편의 기능     : 주사위 / 동전 / 골라 / 계산 / 잠수(AFK) / 역할버튼 / 채널정보
//  · 자동 보안     : 허가 없는 봇 추가 차단 / 위험 권한 역할 부여 되돌리기 / 웹훅 생성 차단 / 대량 밴·킥 감시 / 같은 말 반복 도배
//  · 방장 전용     : 비상 / 초대정리 / 관리자목록 / 인증유저 / 보안초기화   (서버 방장 + 봇 소유자)
//  · 봇 소유자 전용: 서버목록 / 서버나가기 / 서버차단 / 전체공지 / 상태설정 / 재시작
const crypto = require('crypto');
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits: P,
  AuditLogEvent, ChannelType, MessageFlags,
} = require('discord.js');
const { F, DEFAULTS, gs, save, log, isBotAdmin, isExempt, extraStore, fmtDuration, parseDuration, shutdownStore, state } = require('./server');
const antiNuke = require('./antinuke');

const EPH = MessageFlags.Ephemeral;
const DEFAULT_ACTIVITY = '.도움 | 서버 보안 중 🛡️';
const noPing = { repliedUser: false };
const rnd = (n) => crypto.randomInt(n);   // 0 이상 n 미만
const hasAny = (perms, list) => list.some((f) => perms.has(f));

// 역할을 주는 순간 서버를 장악할 수 있는 권한 (이 역할을 허가 없이 주면 되돌려요)
const ESCALATE = [P.Administrator, P.ManageGuild, P.ManageRoles];
// 대량 처벌 감시에서 걸린 사람에게서 회수할 권한
// 역할버튼으로는 절대 줄 수 없는 위험한 권한
const DANGER_BTN = [
  P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels, P.BanMembers, P.KickMembers,
  P.ManageWebhooks, P.MentionEveryone, P.ModerateMembers, P.ManageMessages, P.ManageNicknames,
];
const DANGER_LIST = [P.ManageGuild, P.ManageRoles, P.ManageChannels, P.BanMembers, P.KickMembers, P.ManageWebhooks];

async function tempNotice(channel, text, ms = 8000) {
  const n = await channel.send({ content: text, allowedMentions: { parse: [] } }).catch(() => null);
  if (n) setTimeout(() => n.delete().catch(() => {}), ms);
}

/* ═════════════════════════ 편의 기능 ═════════════════════════ */

// .주사위 [개수]d[면]
function dice(_m, args) {
  const spec = (args[0] || '1d6').toLowerCase();
  const x = /^(\d{1,2})?d(\d{1,4})$/.exec(spec);
  const usage = '사용법: `.주사위 [개수]d[면]` (예: `.주사위 2d6`, 생략하면 1d6 · 최대 20개, 1000면)';
  if (!x) return usage;
  const n = Number(x[1] || 1);
  const s = Number(x[2]);
  if (n < 1 || n > 20 || s < 2 || s > 1000) return usage;
  const rolls = Array.from({ length: n }, () => rnd(s) + 1);
  const sum = rolls.reduce((a, b) => a + b, 0);
  return `🎲 ${n}d${s} → **${sum}**` + (n > 1 ? `  (${rolls.join(' + ')})` : '');
}

function coin() {
  return `🪙 **${rnd(2) ? '앞면' : '뒷면'}** 이에요!`;
}

// .골라 a | b | c
function pick(_m, args) {
  const raw = args.join(' ');
  const opts = (raw.includes('|') ? raw.split('|') : args).map((s) => s.trim()).filter(Boolean);
  if (opts.length < 2) return '사용법: `.골라 피자 | 치킨 | 족발` (공백으로 구분해도 돼요)';
  if (opts.length > 25) return '선택지는 최대 25개예요.';
  return `🎯 저는 **${opts[rnd(opts.length)].slice(0, 100)}** 을(를) 고를래요!`;
}

// 안전한 계산기 (eval 을 쓰지 않고 직접 파싱해요)  지원: + - * / % ^ ( )
function evaluate(str) {
  let i = 0;
  const peek = () => str[i];
  const fail = () => { throw new Error('syntax'); };
  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') { const op = str[i++]; const r = term(); v = op === '+' ? v + r : v - r; }
    return v;
  }
  function term() {
    let v = unary();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = str[i++];
      const r = unary();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  function unary() {
    if (peek() === '-') { i++; return -unary(); }
    if (peek() === '+') { i++; return unary(); }
    return power();
  }
  function power() {
    const base = atom();
    if (peek() === '^') { i++; return Math.pow(base, unary()); }
    return base;
  }
  function atom() {
    if (peek() === '(') { i++; const v = expr(); if (peek() !== ')') fail(); i++; return v; }
    const mt = /^(\d+(\.\d+)?|\.\d+)/.exec(str.slice(i));
    if (!mt) fail();
    i += mt[0].length;
    return parseFloat(mt[0]);
  }
  const v = expr();
  if (i !== str.length) fail();
  return v;
}

function calc(_m, args) {
  const src = args.join('').replace(/×/g, '*').replace(/÷/g, '/');
  if (!src) return '사용법: `.계산 (12+3)*4/5` — 지원: `+ - * / % ^ ( )`';
  if (src.length > 100 || !/^[0-9+\-*/%^().]+$/.test(src)) return '숫자와 `+ - * / % ^ ( )` 만 쓸 수 있어요. (최대 100자)';
  let v;
  try { v = evaluate(src); } catch { return '식을 이해하지 못했어요. 괄호나 연산자를 확인해주세요.'; }
  if (!Number.isFinite(v)) return '계산할 수 없는 식이에요. (0으로 나누기 등)';
  return `🧮 \`${src}\` = **${Number(v.toPrecision(12))}**`;
}

/* ── 잠수(AFK) ── */
const AFK_CAP = 500;
const AFK_CMD = /^\.(잠수|afk)(\s|$)/i;

function afk(m, args) {
  const g = gs(m.guild.id);
  if (!g.afk[m.author.id] && Object.keys(g.afk).length >= AFK_CAP) return '이 서버의 잠수 목록이 가득 찼어요.';
  const reason = args.join(' ').trim().slice(0, 100) || '잠시 자리를 비웠어요';
  g.afk[m.author.id] = { reason, at: Date.now() };
  save();
  return `💤 <@${m.author.id}> 님이 잠수 상태가 됐어요. (${reason})\n다음에 채팅을 치면 자동으로 풀려요.`;
}

// 모든 메시지에서 호출: 잠수 중인 사람이 말하면 해제 / 잠수 중인 사람을 멘션하면 알려줘요
async function afkHandler(message) {
  const afkMap = gs(message.guild.id).afk;
  if (!Object.keys(afkMap).length) return;
  const own = afkMap[message.author.id];
  if (own && !AFK_CMD.test(message.content)) {
    delete afkMap[message.author.id];
    save();
    await tempNotice(message.channel, `👋 <@${message.author.id}> 님, 돌아오셨네요! 잠수를 풀었어요. (${fmtDuration(Date.now() - own.at)} 동안 자리 비움)`);
  }
  const hits = [...message.mentions.users.values()].filter((u) => afkMap[u.id] && u.id !== message.author.id).slice(0, 3);
  if (hits.length) {
    const lines = hits.map((u) => `💤 **${u.username}** 님은 잠수 중이에요: ${afkMap[u.id].reason} (<t:${Math.floor(afkMap[u.id].at / 1000)}:R>)`);
    await tempNotice(message.channel, lines.join('\n'), 15000);
  }
}

/* ── 역할 버튼 ── */
function rolePanelError(m, role) {
  if (role.managed || role.id === m.guild.id) return `**${role.name}** — 봇/부스트 전용 역할이거나 @everyone 이에요.`;
  if (hasAny(role.permissions, DANGER_BTN)) return `**${role.name}** — 관리·차단·타임아웃 같은 위험한 권한이 있어서 버튼으로 줄 수 없어요.`;
  if (role.position >= m.guild.members.me.roles.highest.position) return `**${role.name}** — 제 역할보다 높거나 같아서 줄 수 없어요.`;
  if (m.author.id !== m.guild.ownerId && !isBotAdmin(m.author.id) && role.position >= m.member.roles.highest.position)
    return `**${role.name}** — 내 최고 역할보다 높거나 같은 역할이에요.`;
  return null;
}

async function roleButtonCmd(m) {
  const roles = [...m.mentions.roles.values()].slice(0, 10);
  const usage = '사용법: `.역할버튼 [#채널] @역할1 @역할2 ...` (최대 10개)';
  if (!roles.length) return usage;
  const errs = roles.map((r) => rolePanelError(m, r)).filter(Boolean);
  if (errs.length) return '🚫 버튼으로 만들 수 없는 역할이 있어요:\n' + errs.join('\n');
  const ch = m.mentions.channels.first() || m.channel;
  if (!ch.isTextBased() || ch.isThread()) return '텍스트 채널을 지정해주세요.';

  const rows = [];
  for (let r = 0; r < roles.length; r += 5) {
    rows.push(new ActionRowBuilder().addComponents(roles.slice(r, r + 5).map((role) =>
      new ButtonBuilder().setCustomId(`rolebtn:${role.id}`).setLabel(role.name.slice(0, 80)).setStyle(ButtonStyle.Secondary))));
  }
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('🏷️ 역할 받기')
    .setDescription('버튼을 누르면 역할을 받고, 한 번 더 누르면 빼요.\n\n' + roles.map((r) => `• ${r}`).join('\n'));
  const sent = await ch.send({ embeds: [embed], components: rows, allowedMentions: { parse: [] } }).catch(() => null);
  if (!sent) return `${ch} 에 메시지를 보낼 수 없어요. 봇 권한을 확인해주세요.`;
  await log(m.guild, `🏷️ 역할 버튼 패널 생성 | #${ch.name} | ${roles.map((r) => r.name).join(', ')} | by ${m.author.tag}`);
  return `✅ ${ch} 에 역할 버튼 ${roles.length}개를 올렸어요.`;
}

const btnCool = new Map();
async function roleButton(i) {
  const last = btnCool.get(i.user.id) || 0;
  if (Date.now() - last < 1500) return i.reply({ content: '⏳ 잠시 후에 다시 눌러주세요.', flags: EPH }).catch(() => {});
  btnCool.set(i.user.id, Date.now());

  const role = i.guild.roles.cache.get(i.customId.slice('rolebtn:'.length));
  if (!role) return i.reply({ content: '이 역할은 더 이상 없어요.', flags: EPH });
  // 버튼은 오래 남기 때문에 누를 때마다 다시 검사해요 (나중에 역할 권한이 올라간 경우 대비)
  if (role.managed || role.id === i.guild.id || hasAny(role.permissions, DANGER_BTN))
    return i.reply({ content: '🚫 이 역할은 지금 버튼으로 받을 수 없어요.', flags: EPH });
  if (role.position >= i.guild.members.me.roles.highest.position)
    return i.reply({ content: '🚫 봇이 줄 수 없는 역할이에요. 관리자에게 알려주세요.', flags: EPH });

  const member = await i.guild.members.fetch(i.user.id).catch(() => null);
  if (!member) return i.reply({ content: '멤버 정보를 불러오지 못했어요.', flags: EPH });
  const has = member.roles.cache.has(role.id);
  try {
    if (has) await member.roles.remove(role, '역할 버튼');
    else await member.roles.add(role, '역할 버튼');
  } catch {
    return i.reply({ content: '❌ 역할을 바꾸지 못했어요. 봇 권한과 역할 순서를 확인해주세요.', flags: EPH });
  }
  return i.reply({ content: has ? `🏷️ **${role.name}** 역할을 뺐어요.` : `🏷️ **${role.name}** 역할을 받았어요!`, flags: EPH });
}

/* ── 채널정보 ── */
const CH_TYPE = {
  [ChannelType.GuildText]: '텍스트', [ChannelType.GuildVoice]: '음성', [ChannelType.GuildCategory]: '카테고리',
  [ChannelType.GuildAnnouncement]: '공지', [ChannelType.GuildStageVoice]: '스테이지', [ChannelType.GuildForum]: '포럼',
};

function channelInfo(m, args) {
  const ch = m.mentions.channels.first() || m.guild.channels.cache.get((args[0] || '').replace(/\D/g, '')) || m.channel;
  const ow = ch.permissionOverwrites?.cache.get(m.guild.id);
  const locked = ow?.deny.has(P.SendMessages);
  const e = new EmbedBuilder().setColor(0x5865f2).setTitle(`📺 #${ch.name}`)
    .addFields(
      { name: 'ID', value: `\`${ch.id}\``, inline: true },
      { name: '종류', value: CH_TYPE[ch.type] || String(ChannelType[ch.type] || ch.type), inline: true },
      { name: '카테고리', value: ch.parent?.name || '없음', inline: true },
      { name: '생성', value: `<t:${Math.floor(ch.createdTimestamp / 1000)}:R>`, inline: true },
      { name: '슬로우모드', value: ch.rateLimitPerUser ? `${ch.rateLimitPerUser}초` : '없음', inline: true },
      { name: '상태', value: [locked ? '🔒 @everyone 채팅 잠김' : '🔓 열려 있음', ch.nsfw ? '🔞 NSFW' : null].filter(Boolean).join(' · '), inline: true },
      { name: '권한 덮어쓰기', value: `${ch.permissionOverwrites?.cache.size ?? 0}개`, inline: true },
    );
  if (ch.topic) e.setDescription(ch.topic.slice(0, 500));
  return { embeds: [e] };
}

/* ═════════════════════════ 자동 보안 ═════════════════════════ */

// 이 사람이 한 행동은 문제 삼지 않아요: 봇 자신 / 방장 / 봇 관리자 / 화이트리스트 / 인증 유저
function trusted(guild, userId) {
  const g = gs(guild.id);
  return userId === guild.client.user.id || userId === guild.ownerId || isBotAdmin(userId) ||
    g.whitelist.includes(userId) || g.authUsers.includes(userId);
}

const alertAt = new Map();
async function dmOwner(guild, key, text) {
  const k = `${guild.id}:${key}`;
  if (Date.now() - (alertAt.get(k) || 0) < 60000) return;   // 같은 알림은 1분에 한 번만
  alertAt.set(k, Date.now());
  const owner = await guild.fetchOwner().catch(() => null);
  await owner?.send(text.slice(0, 1900)).catch(() => {});
}

// 1) 허가 없는 봇 추가: 방장/인증 유저/봇 관리자/화이트리스트가 아닌 사람이 봇을 넣으면 그 봇을 내보내요
async function blockBot(guild, entry) {
  const bot = await guild.members.fetch(entry.targetId).catch(() => null);
  if (!bot?.user.bot) return;
  const adder = await guild.client.users.fetch(entry.executorId).catch(() => null);
  const who = `${adder?.tag || '알 수 없음'} (${entry.executorId})`;
  const kicked = bot.kickable ? await bot.kick(`[AutoMod] 허가받지 않은 봇 추가 (${adder?.tag || entry.executorId})`).then(() => true).catch(() => false) : false;
  const text = `🤖 **허가받지 않은 봇 ${kicked ? '추가를 차단' : '추가를 감지'}했어요** | ${bot.user.tag} (${bot.id}) | 추가한 사람: ${who}` +
    (kicked ? '\n봇이 필요하면 방장이 직접 추가하거나 `.화이트리스트 추가 @유저` 로 허용하세요.' : '\n⚠️ 제가 내보낼 수 없는 봇이에요. 봇 역할을 최상단으로 올려주세요.');
  await log(guild, text);
  await dmOwner(guild, 'botadd', `**${guild.name}**\n${text}`);
}

// 2) 위험 권한 역할 부여 되돌리기 (관리자/서버 관리/역할 관리 권한이 있는 역할)
async function revertRoleGrant(guild, entry) {
  const added = entry.changes?.find((c) => c.key === '$add')?.new;
  if (!Array.isArray(added) || !added.length) return;
  const bad = added.map((r) => guild.roles.cache.get(r.id)).filter((r) => r && !r.managed && r.id !== guild.id && hasAny(r.permissions, ESCALATE));
  if (!bad.length) return;
  const target = await guild.members.fetch(entry.targetId).catch(() => null);
  if (!target) return;
  const done = await target.roles.remove(bad, '[AutoMod] 허가받지 않은 위험 권한 역할 부여 되돌림').then(() => true).catch(() => false);
  const adder = await guild.client.users.fetch(entry.executorId).catch(() => null);
  const text = `🛑 **위험 권한 역할 부여 ${done ? '되돌림' : '감지'}** | ${target.user.tag} ← ${bad.map((r) => r.name).join(', ')} | 준 사람: ${adder?.tag || entry.executorId}` +
    (done ? '' : '\n⚠️ 되돌리지 못했어요. 봇 역할 순서/권한을 확인해주세요.');
  await log(guild, text);
  await dmOwner(guild, 'rolegrant', `**${guild.name}**\n${text}`);
}

// 3) 웹훅 생성 차단 (기본 꺼짐: .보안 웹훅 켜기)
// 여러 웹훅 생성 이벤트가 한꺼번에 들어와도 서버별로 직렬 처리해 REST 요청 폭주를 줄입니다.
const webhookRemovalQueues = new Map();
async function removeWebhook(guild, entry) {
  const previous = webhookRemovalQueues.get(guild.id) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const hooks = await guild.fetchWebhooks().catch(() => null);
    const hook = hooks?.get(entry.targetId);
    if (!hook) return;
    const done = await hook.delete('[AutoMod] 허가받지 않은 웹훅 생성').then(() => true).catch(() => false);
    const adder = await guild.client.users.fetch(entry.executorId).catch(() => null);
    await log(guild, `🪝 **허가받지 않은 웹훅 ${done ? '삭제' : '감지'}** | ${hook.name} | 만든 사람: ${adder?.tag || entry.executorId}` + (done ? '' : '\n⚠️ 삭제하지 못했어요. 봇에게 \"웹훅 관리\" 권한이 필요해요.'));
  });
  const tracked = task.catch((err) => console.error('[웹훅 정리 큐]', err.message));
  webhookRemovalQueues.set(guild.id, tracked);
  try { await task; }
  finally {
    if (webhookRemovalQueues.get(guild.id) === tracked) webhookRemovalQueues.delete(guild.id);
  }
}

// 대량 밴/킥은 antinuke.js의 공통 점수 엔진에서 함께 감시합니다.

async function onAudit(entry, guild) {
  try {
    // 안티누크는 역할/채널/웹훅/초대/대량 처벌을 같은 점수 체계로 판단합니다.
    await antiNuke.handleAuditEntry(entry, guild);
    const exec = entry.executorId;
    if (!exec || trusted(guild, exec)) return;
    const g = gs(guild.id);
    switch (entry.action) {
      case AuditLogEvent.BotAdd: if (g.antiBotAdd) await blockBot(guild, entry); break;
      // antiNuke가 켜져 있으면 공통 엔진에서 이미 위험 역할 지급을 원복하므로 중복 REST 호출을 피합니다.
      case AuditLogEvent.MemberRoleUpdate: if (g.antiRoleGrant && !g.antiNuke) await revertRoleGrant(guild, entry); break;
      case AuditLogEvent.WebhookCreate: if (g.antiWebhook) await removeWebhook(guild, entry); break;
      // 밴/킥은 통합 안티누크 점수 엔진에서 감시하므로 별도 카운터를 사용하지 않습니다.
      default: break;
    }
  } catch (err) {
    console.error('[감사 로그 이벤트 오류]', err.message);
  }
}

// 5) 같은 내용을 반복해서 보내는 도배 (20초 안에 같은 메시지 4번). main.js autoMod 에서 호출
const repeatMap = new Map();
function isRepeatSpam(message) {
  if (message.editedTimestamp) return false;
  const text = message.content.toLowerCase().replace(/\s+/g, ' ').trim();
  if (text.length < 6) return false;   // "ㅋㅋ" 같은 짧은 말은 제외
  const key = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  const arr = (repeatMap.get(key) || []).filter((x) => now - x.t < 20000);
  arr.push({ h: text, t: now });
  repeatMap.set(key, arr);
  if (arr.filter((x) => x.h === text).length >= 4) { repeatMap.delete(key); return true; }
  return false;
}

/* ═════════════════════════ 방장 전용 ═════════════════════════ */

// .비상 켜기 [시간] / 해제 / 상태
const EMERGENCY_DEFAULT = 6 * 36e5;
const EMERGENCY_MAX = 24 * 36e5;

async function setInvites(guild, disabled) {
  if (typeof guild.disableInvites !== 'function') return '⚪ 이 버전에서는 초대 일시중지를 지원하지 않아요';
  try { await guild.disableInvites(disabled); return disabled ? '✅ 초대 링크 일시 중지' : '✅ 초대 링크 다시 허용'; }
  catch { return '⚠️ 초대 링크 설정 실패 (봇에게 "서버 관리" 권한이 필요해요)'; }
}

async function releaseEmergency(guild, who) {
  gs(guild.id).emergencyUntil = 0;
  save();
  const unlock = await F.unlockdown({ guild, author: { tag: who } });
  const inv = await setInvites(guild, false);
  await log(guild, `✅ 비상 모드 해제 | ${who}`);
  return `${unlock}\n${inv}`;
}

async function emergency(m, args) {
  const g = gs(m.guild.id);
  const sub = (args[0] || '').toLowerCase();

  if (['켜기', 'on', '시작'].includes(sub)) {
    let ms = EMERGENCY_DEFAULT;
    if (args[1]) {
      ms = parseDuration(args[1], false, 36e5);   // 숫자만 쓰면 시간 단위
      if (!ms || ms < 5 * 60000 || ms > EMERGENCY_MAX) return '시간은 5분 이상 24시간 이하로 정해주세요. (예: `.비상 켜기 2h`, 숫자만 쓰면 시간)';
    }
    const lock = await F.lockdown(m);
    const inv = await setInvites(m.guild, true);
    g.emergencyUntil = Date.now() + ms;
    save();
    await log(m.guild, `🚨 **비상 모드 시작** | ${fmtDuration(ms)} | by ${m.author.tag}\n신규 입장자는 자동 킥돼요.`);
    return `🚨 **비상 모드를 켰어요** (${fmtDuration(ms)} 뒤 자동 해제)\n${lock}\n${inv}\n🚪 신규 입장자는 자동으로 내보내요.\n끝내려면 \`.비상 해제\``;
  }
  if (['해제', 'off', '끄기'].includes(sub)) {
    if (!g.emergencyUntil) return '지금은 비상 모드가 아니에요.';
    return `✅ 비상 모드를 해제했어요.\n${await releaseEmergency(m.guild, m.author.tag)}`;
  }
  if (['상태', 'status', ''].includes(sub)) {
    return g.emergencyUntil > Date.now()
      ? `🚨 비상 모드 진행 중 — <t:${Math.floor(g.emergencyUntil / 1000)}:R> 자동 해제`
      : '🟢 비상 모드가 아니에요.\n`.비상 켜기 [시간]` — 전체 채널 잠금 + 초대 일시 중지 + 신규 입장 차단';
  }
  return '사용법: `.비상 켜기 [시간]` · `.비상 해제` · `.비상 상태`';
}

async function purgeInvites(m) {
  const invites = await m.guild.invites.fetch().catch(() => null);
  if (!invites) return '초대 링크를 불러올 수 없어요. 봇에게 **서버 관리** 권한이 필요해요.';
  if (!invites.size) return '삭제할 초대 링크가 없어요.';
  let n = 0;
  for (const inv of [...invites.values()].slice(0, 200)) {
    if (await inv.delete(`초대정리 by ${m.author.tag}`).then(() => true).catch(() => false)) n++;
  }
  await log(m.guild, `🧹 초대 링크 정리 | ${n}/${invites.size}개 삭제 | by ${m.author.tag}`);
  return `🧹 초대 링크 **${n}/${invites.size}개**를 삭제했어요. (서버 커스텀 URL은 그대로예요)`;
}

async function adminList(m) {
  const members = await m.guild.members.fetch().catch(() => m.guild.members.cache);
  const admins = [];
  const risky = [];
  for (const mem of members.values()) {
    if (mem.id === m.guild.ownerId) continue;
    if (mem.permissions.has(P.Administrator)) admins.push(mem);
    else if (hasAny(mem.permissions, DANGER_LIST)) risky.push(mem);
  }
  const fmt = (arr) => {
    if (!arr.length) return '없음';
    const lines = arr.slice(0, 12).map((x) => `${x.user.bot ? '🤖' : '👤'} ${x.user.username} (\`${x.id}\`)`);
    return (lines.join('\n') + (arr.length > 12 ? `\n…외 ${arr.length - 12}명` : '')).slice(0, 1000);
  };
  const e = new EmbedBuilder().setColor(admins.length > 5 ? 0xfee75c : 0x5865f2).setTitle('🔐 관리 권한 보유자')
    .addFields(
      { name: `👑 관리자 권한 (${admins.length})`, value: fmt(admins) },
      { name: `⚠️ 그 외 위험 권한 — 서버 관리·역할 관리·채널 관리·차단·추방·웹훅 (${risky.length})`, value: fmt(risky) },
    )
    .setFooter({ text: '꼭 필요한 사람/봇에게만 두세요 · 방장 제외' });
  return { embeds: [e] };
}

async function authUsers(m, args) {
  const g = gs(m.guild.id);
  const sub = (args[0] || '').toLowerCase();
  const id = m.mentions.users.first()?.id || (args[1] || '').replace(/\D/g, '');

  if (['추가', 'add'].includes(sub)) {
    if (!/^\d{17,20}$/.test(id)) return '사용법: `.인증유저 추가 @유저`';
    const mem = await m.guild.members.fetch(id).catch(() => null);
    if (!mem) return '이 서버에 있는 유저만 등록할 수 있어요.';
    if (mem.user.bot) return '봇은 등록할 수 없어요.';
    if (id === m.guild.ownerId || isBotAdmin(id)) return '이미 봇을 쓸 수 있는 사람이에요.';
    if (g.authUsers.includes(id)) return '이미 인증 유저예요.';
    g.authUsers.push(id);
    save();
    await log(m.guild, `🔑 인증 유저 등록 | ${mem.user.tag} (${id}) | by ${m.author.tag}`);
    return `🔑 **${mem.user.tag}** 님을 이 서버의 인증 유저로 등록했어요.\n이제 방장·소유자 전용을 뺀 봇 명령어를 쓸 수 있고, 자동 보안에서도 제외돼요.`;
  }
  if (['삭제', '제거', 'remove'].includes(sub)) {
    if (!g.authUsers.includes(id)) return '인증 유저가 아니에요.';
    g.authUsers = g.authUsers.filter((x) => x !== id);
    save();
    await log(m.guild, `🔒 인증 유저 해제 | ${id} | by ${m.author.tag}`);
    return `🔒 <@${id}> 님의 인증을 해제했어요.`;
  }
  if (['목록', 'list', ''].includes(sub)) {
    return g.authUsers.length
      ? `🔑 이 서버의 인증 유저 (${g.authUsers.length}명)\n${g.authUsers.slice(0, 30).map((x) => `• <@${x}> (\`${x}\`)`).join('\n')}`
      : '인증 유저가 없어요. `.인증유저 추가 @유저`';
  }
  return '사용법: `.인증유저 추가 @유저` · `.인증유저 삭제 @유저` · `.인증유저 목록`';
}

const RESET_KEYS = [
  'antiSpam', 'antiInvite', 'antiLink', 'antiScan', 'antiMention', 'antiBadword', 'antiRaid', 'antiDdos', 'antiNuke', 'antiNukeRecover',
  'antiNukeContain', 'antiNukeAutoBan', 'antiBotAdd', 'antiRoleGrant', 'antiWebhook', 'antiMassPunish', 'suspectLog',
  'minAccountAgeDays', 'spamLimit', 'spamSeconds', 'mentionLimit', 'watchHours',
];

async function securityReset(m) {
  const g = gs(m.guild.id);
  for (const k of RESET_KEYS) g[k] = structuredClone(DEFAULTS[k]);
  save();
  await log(m.guild, `🔄 보안 설정 초기화 | by ${m.author.tag}`);
  return '🔄 자동 보안 설정을 기본값으로 되돌렸어요. (금칙어·화이트리스트·경고 기록·로그 채널은 그대로예요) `.보안 상태`로 확인하세요.';
}

/* ═════════════════════════ 봇 소유자 전용 ═════════════════════════ */

function guildList(m) {
  const list = [...m.client.guilds.cache.values()].sort((a, b) => b.memberCount - a.memberCount);
  const lines = list.slice(0, 25).map((g, i) => `**${i + 1}.** ${g.name.slice(0, 30)} · 👥${g.memberCount} · \`${g.id}\` · 방장 \`${g.ownerId}\``);
  return {
    embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`🌐 봇이 들어가 있는 서버 (${list.length}개)`)
      .setDescription(lines.join('\n').slice(0, 4000) || '없음')
      .setFooter({ text: list.length > 25 ? '멤버가 많은 25개만 표시' : '나가기: .서버나가기 <서버ID>' })],
  };
}

async function leaveGuild(m, args) {
  const id = (args[0] || '').replace(/\D/g, '');
  const guild = m.client.guilds.cache.get(id);
  if (!guild) return '봇이 들어가 있는 서버 ID가 아니에요. `.서버목록` 으로 확인하세요.';
  if ((args[1] || '') !== '확인') return `⚠️ **${guild.name}** 에서 봇을 내보낼까요? 맞다면 \`.서버나가기 ${id} 확인\``;
  if (guild.id === m.guild.id) {
    await m.reply({ content: `👋 이 서버(**${guild.name}**)에서 나가요.`, allowedMentions: noPing }).catch(() => {});
    await guild.leave();
    return null;
  }
  await guild.leave();
  return `👋 **${guild.name}** 에서 나왔어요.`;
}

async function guildBan(m, args) {
  const store = (extraStore().guildBlacklist ||= {});
  const sub = (args[0] || '').toLowerCase();
  const id = (args[1] || '').replace(/\D/g, '');

  if (['추가', 'add'].includes(sub)) {
    if (!/^\d{17,20}$/.test(id)) return '사용법: `.서버차단 추가 <서버ID> [사유]`';
    if (id === m.guild.id) return '지금 이 서버는 차단할 수 없어요. 다른 서버 ID를 입력하세요.';
    store[id] = { reason: args.slice(2).join(' ').trim().slice(0, 200) || '소유자가 차단', at: Date.now(), by: m.author.id };
    save();
    const g = m.client.guilds.cache.get(id);
    if (g) await g.leave().catch(() => {});
    return `⛔ 서버 \`${id}\` 를 차단했어요. ${g ? '이미 들어가 있어서 나왔고, ' : ''}앞으로 그 서버에 초대돼도 자동으로 나가요.`;
  }
  if (['제거', '해제', '삭제', 'remove'].includes(sub)) {
    if (!store[id]) return '차단 목록에 없는 서버예요.';
    delete store[id];
    save();
    return `✅ 서버 \`${id}\` 의 차단을 풀었어요.`;
  }
  if (['목록', 'list', ''].includes(sub)) {
    const entries = Object.entries(store);
    return entries.length
      ? `⛔ 차단한 서버 (${entries.length}개)\n` + entries.slice(0, 20).map(([k, v]) => `• \`${k}\` · ${v.reason}`).join('\n').slice(0, 1800)
      : '차단한 서버가 없어요.';
  }
  return '사용법: `.서버차단 추가 <서버ID> [사유]` · `.서버차단 제거 <서버ID>` · `.서버차단 목록`';
}

async function broadcast(m, args) {
  const text = args.join(' ').trim();
  if (!text) return '사용법: `.전체공지 <내용>` — 봇이 있는 모든 서버의 **로그 채널**로 보내요. (로그 채널이 없는 서버는 건너뛰어요)';
  if (text.length > 1500) return '공지는 1500자 이하로 써주세요.';
  let ok = 0;
  let skip = 0;
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('📢 봇 공지').setDescription(text).setFooter({ text: '보안 봇 소유자가 보낸 공지예요.' });
  for (const guild of m.client.guilds.cache.values()) {
    const id = gs(guild.id).logChannel;
    const ch = id && guild.channels.cache.get(id);
    if (!ch?.isTextBased()) { skip++; continue; }
    if (await ch.send({ embeds: [embed], allowedMentions: { parse: [] } }).then(() => true).catch(() => false)) ok++;
    else skip++;
  }
  return `📢 ${ok}개 서버에 보냈어요. (건너뜀 ${skip}개 — 로그 채널 없음/권한 없음)`;
}

function applyActivity(client) {
  client.user?.setActivity(extraStore().activity || DEFAULT_ACTIVITY);
}

function setStatus(m, args) {
  const text = args.join(' ').trim();
  const ex = extraStore();
  if (!text) return `현재 상태 문구: \`${ex.activity || DEFAULT_ACTIVITY}\`\n사용법: \`.상태설정 <문구>\` · 되돌리기: \`.상태설정 초기화\``;
  if (['초기화', 'reset'].includes(text)) delete ex.activity;
  else ex.activity = text.slice(0, 100);
  save();
  applyActivity(m.client);
  return `✅ 봇 상태 문구를 \`${ex.activity || DEFAULT_ACTIVITY}\` 로 바꿨어요.`;
}

async function restart(m) {
  await m.reply({ content: '🔄 데이터를 저장하고 다시 시작해요. (호스팅이 꺼진 프로세스를 자동으로 다시 켜주는 환경에서만 돌아와요)', allowedMentions: noPing }).catch(() => {});
  await shutdownStore().catch(() => {});
  process.exit(0);
}


/* ═════════════════════════ 의심 행동 로그 ═════════════════════════
 * 봇이 확실하게 처벌할 정도는 아니지만 애매한 행동(짧은 시간 연속 채팅, 같은 말 반복, 새 계정/방금 들어온 사람의 링크·멘션 등)은
 * 처벌 대신 로그 채널에 그 사람의 정보를 정리해서 올려요. 판단은 관리자가 해요.
 */
const suspMap = new Map();
const suspCool = new Map();
const tsFull = (ms) => `<t:${Math.floor(ms / 1000)}:F> (<t:${Math.floor(ms / 1000)}:R>)`;

function suspicionReasons(message) {
  const now = Date.now();
  const text = message.content.toLowerCase().replace(/\s+/g, ' ').trim();
  const key = `${message.guild.id}:${message.author.id}`;
  const arr = (suspMap.get(key) || []).filter((x) => now - x.t < 10000);
  arr.push({ t: now, h: text });
  suspMap.set(key, arr);

  const reasons = [];
  if (arr.length >= 4) reasons.push(`10초 안에 메시지 ${arr.length}개`);
  if (text.length >= 6 && arr.filter((x) => x.h === text).length >= 2) reasons.push('같은 내용을 반복해서 보냄');
  const ageDays = (now - message.author.createdTimestamp) / 864e5;
  const sinceJoin = now - (message.member?.joinedTimestamp || 0);
  const fresh = ageDays < 7 ? '만든 지 7일 미만 계정' : sinceJoin < 30 * 60000 ? '서버에 들어온 지 30분 이내' : null;
  if (fresh && /https?:\/\/\S+|www\.\S+|discord\.(gg|com\/invite)/i.test(message.content)) reasons.push(`${fresh}이(가) 링크를 보냄`);
  const mc = message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 5 : 0);
  if (fresh && mc >= 3) reasons.push(`${fresh}이(가) 멘션 ${mc}개를 보냄`);
  if (message.attachments.size >= 4) reasons.push(`첨부파일 ${message.attachments.size}개`);
  return reasons;
}

async function suspicionCheck(message) {
  try {
    const g = gs(message.guild.id);
    if (!g.suspectLog || !g.logChannel || !message.member || isExempt(message.member)) return;
    const reasons = suspicionReasons(message);
    if (!reasons.length) return;
    const k = `${message.guild.id}:${message.author.id}`;
    if (Date.now() - (suspCool.get(k) || 0) < 2 * 60000) return;   // 같은 사람은 2분에 한 번만
    suspCool.set(k, Date.now());

    const ch = message.guild.channels.cache.get(g.logChannel);
    if (!ch?.isTextBased()) return;
    const left = g.leftLog[message.author.id];
    const snippet = (message.content || '(내용 없음)').replace(/https?:\/\//gi, 'hxxp://').replace(/`/g, "'").slice(0, 300);
    const e = new EmbedBuilder().setColor(0xfee75c).setTitle('🕵️ 의심스러운 행동 (자동 처벌은 하지 않았어요)')
      .setThumbnail(message.author.displayAvatarURL())
      .addFields(
        { name: '사용자', value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
        { name: 'ID', value: `\`${message.author.id}\``, inline: true },
        { name: '경고', value: `${(g.warns[message.author.id] || []).length}회`, inline: true },
        { name: '계정 가입일', value: tsFull(message.author.createdTimestamp) },
        { name: '서버 가입일', value: message.member.joinedTimestamp ? tsFull(message.member.joinedTimestamp) : '0' },
        { name: '서버 퇴장일', value: left ? `${tsFull(left)} (이후 재입장)` : '0' },
        { name: '의심 사유', value: reasons.map((r) => `• ${r}`).join('\n') },
        { name: '채널 / 메시지', value: `<#${message.channel.id}> · [바로가기](${message.url})` },
        { name: '내용', value: '```\n' + snippet + '\n```' },
      )
      .setFooter({ text: '처벌 예: .타임아웃 <ID> 10m · .밴 <ID> · .경계 추가 @유저' });
    await ch.send({ embeds: [e], allowedMentions: { parse: [] } }).catch(() => {});
  } catch (err) {
    console.error('[의심 행동 로그 오류]', err.message);
  }
}

/* ═════════════════════════ 서버 비밀번호 / 서버폭파 ═════════════════════════
 * 서버 이전 때 쓰는 기능이에요. 방장 계정이 해킹돼도 막을 수 있게 **서버 비밀번호**를 모르면 쓸 수 없어요.
 *  - 비밀번호는 암호화(scrypt 해시)해서 저장해요. 평문은 저장하지 않고, 입력한 메시지는 바로 지워요.
 *  - 등록/변경/폭파는 @everyone 이 볼 수 없는 채널(관리자 전용 채널)에서만 돼요.
 *  - 5번 틀리면 30분 동안 잠겨요.
 */
const PW_MIN = 8;
const PW_LOCK_MS = 30 * 60000;
const bombing = new Set();   // 진행 중인 서버폭파 (중복 실행 방지)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
function checkPw(g, pw) {
  if (!g.serverPw) return false;
  const a = Buffer.from(hashPw(pw, g.serverPw.salt), 'hex');
  const b = Buffer.from(g.serverPw.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function adminOnlyChannel(m) {
  const ch = m.channel;
  if (ch.isThread?.() || !ch.permissionsFor) return false;
  return !ch.permissionsFor(m.guild.roles.everyone)?.has(P.ViewChannel);
}

// 공통 점검: 관리자 전용 채널 + 메시지 삭제 가능 + 잠금 여부. 문제가 있으면 안내 문구를 돌려줘요.
async function pwGate(m) {
  if (!adminOnlyChannel(m)) return '🚫 비밀번호는 **관리자만 볼 수 있는 채널**에서만 입력할 수 있어요. (@everyone 이 채널을 볼 수 없게 설정한 채널에서 다시 해주세요)';
  if (!m.channel.permissionsFor(m.guild.members.me)?.has(P.ManageMessages)) return '🚫 비밀번호 메시지를 바로 지울 수 있어야 해서, 이 채널에서 봇에게 **메시지 관리** 권한이 필요해요.';
  const g = gs(m.guild.id);
  if (g.pwLockUntil > Date.now()) return `🔒 비밀번호를 여러 번 틀려서 잠겼어요. <t:${Math.floor(g.pwLockUntil / 1000)}:R> 에 다시 시도할 수 있어요.`;
  return null;
}

async function failPw(m) {
  const g = gs(m.guild.id);
  g.pwFails++;
  let extra = '';
  if (g.pwFails >= 5) { g.pwLockUntil = Date.now() + PW_LOCK_MS; g.pwFails = 0; extra = ' → **30분 동안 잠금**'; }
  save();
  await log(m.guild, `🚨 서버 비밀번호 입력 실패 | ${m.author.tag} (${m.author.id})${extra}`);
  await dmOwner(m.guild, 'pwfail', `🚨 **${m.guild.name}** 서버 비밀번호 입력에 실패했어요. 시도한 사람: ${m.author.tag} (${m.author.id})${extra}\n본인이 아니라면 계정 보안을 점검하세요.`);
  return `❌ 비밀번호가 틀렸어요.${extra ? ' 30분 동안 잠겼어요.' : ''}`;
}

async function serverPassword(m, args) {
  const g = gs(m.guild.id);
  const sub = (args[0] || '').toLowerCase();
  const usage = '사용법: `.서버비밀번호 설정 <새 비밀번호>` · `.서버비밀번호 변경 <현재> <새 비밀번호>` · `.서버비밀번호 상태`\n(공백 없이 8자 이상, 관리자 전용 채널에서만)';

  if (['상태', 'status', ''].includes(sub)) {
    return g.serverPw ? '🔐 서버 비밀번호가 설정돼 있어요. (내용은 저장돼 있어도 볼 수 없어요)' : '🔓 서버 비밀번호가 아직 없어요. `.서버비밀번호 설정 <새 비밀번호>`';
  }
  if (!['설정', 'set', '변경', 'change'].includes(sub)) return usage;

  const gate = await pwGate(m);
  m.delete().catch(() => {});   // 비밀번호가 적힌 메시지는 바로 지워요
  if (gate) return gate;

  const isChange = ['변경', 'change'].includes(sub);
  if (isChange || g.serverPw) {
    // 이미 비밀번호가 있으면 현재 비밀번호를 알아야 바꿀 수 있어요 (방장 계정 탈취 대비)
    if (!g.serverPw) return '비밀번호가 아직 없어요. `.서버비밀번호 설정 <새 비밀번호>`';
    if (!isChange) return '이미 비밀번호가 있어요. 바꾸려면 `.서버비밀번호 변경 <현재> <새 비밀번호>`';
    if (!checkPw(g, args[1] || '')) return failPw(m);
  }
  const next = isChange ? args[2] : args[1];
  if (!next || next.length < PW_MIN || next.length > 64) return `새 비밀번호는 공백 없이 ${PW_MIN}자 이상 64자 이하로 정해주세요.\n${usage}`;
  const salt = crypto.randomBytes(16).toString('hex');
  g.serverPw = { salt, hash: hashPw(next, salt) };
  g.pwFails = 0;
  save();
  await log(m.guild, `🔐 서버 비밀번호 ${isChange ? '변경' : '설정'} | by ${m.author.tag}`);
  return `🔐 서버 비밀번호를 ${isChange ? '바꿨어요' : '설정했어요'}. 입력한 메시지는 지웠어요. 비밀번호는 안전한 곳에 따로 보관하세요. (저도 다시 보여줄 수 없어요)`;
}

async function serverBomb(m, args) {
  const g = gs(m.guild.id);
  const guild = m.guild;
  if (!g.serverPw) return '🚫 먼저 `.서버비밀번호 설정 <비밀번호>` 로 서버 비밀번호를 정해야 서버폭파를 쓸 수 있어요.';
  if (bombing.has(guild.id)) return '이미 서버폭파가 진행 중이에요.';
  const gate = await pwGate(m);
  m.delete().catch(() => {});
  if (gate) return gate;
  if (!args[0]) return '사용법: `.서버폭파 <서버 비밀번호>`';
  if (!checkPw(g, args[0])) return failPw(m);
  g.pwFails = 0;
  save();

  const me = guild.members.me;
  const miss = [['KickMembers', '멤버 추방하기'], ['ManageGuild', '서버 관리']].filter(([k]) => !me.permissions.has(P[k])).map(([, v]) => v);
  if (miss.length) return `🚫 봇에게 필요한 권한이 없어요: ${miss.join(', ')}`;

  const members = await guild.members.fetch().catch(() => null);
  if (!members) return '멤버 목록을 불러오지 못했어요. 잠시 후 다시 시도해주세요.';
  const targets = members.filter((x) => x.id !== guild.ownerId && x.id !== me.id && x.id !== m.author.id);
  const invites = await guild.invites.fetch().catch(() => null);

  await m.channel.send({
    content: `⚠️ **서버폭파 최종 확인** — <@${m.author.id}>\n• 멤버 **${targets.size}명**을 킥해요. (제외: 방장, 이 봇, 명령어를 쓴 사람)\n• 초대 링크 **${invites?.size ?? '?'}개**를 모두 삭제해요.\n• 되돌릴 수 없어요.\n계속하려면 **30초 안에** 이 채널에 \`폭파확인\` 이라고 입력하세요. 아니면 자동 취소돼요.`,
    allowedMentions: { parse: [] },
  }).catch(() => {});
  const got = await m.channel.awaitMessages({ filter: (x) => x.author.id === m.author.id && x.content.trim() === '폭파확인', max: 1, time: 30000 }).catch(() => null);
  if (!got?.size) return '⏱️ 확인이 없어서 서버폭파를 취소했어요.';
  got.first().delete().catch(() => {});

  bombing.add(guild.id);
  try {
    await log(guild, `💥 **서버폭파 시작** | by ${m.author.tag} (${m.author.id}) | 대상 ${targets.size}명`);
    // 1) 초대 링크 전부 삭제 (다시 들어오지 못하게 먼저)
    let inv = 0;
    for (const i of [...(invites?.values() || [])]) if (await i.delete('[서버폭파]').then(() => true).catch(() => false)) inv++;
    await m.channel.send(`🧹 초대 링크 ${inv}개를 삭제했어요. 이제 멤버를 내보내요...`).catch(() => {});

    // 2) 전체 멤버 킥
    let ok = 0;
    let fail = 0;
    let n = 0;
    for (const t of targets.values()) {
      if (t.kickable && await t.kick(`[서버폭파] by ${m.author.tag}`).then(() => true).catch(() => false)) ok++;
      else fail++;
      if (++n % 50 === 0) await m.channel.send(`⏳ 진행 중... ${n}/${targets.size}`).catch(() => {});
      await sleep(250);
    }
    const done = `💥 **서버폭파 완료** | 킥 ${ok}명 · 실패 ${fail}명 · 초대 ${inv}개 삭제 | by ${m.author.tag}` +
      (fail ? '\n실패한 멤버는 봇보다 역할이 높은 사람/봇이에요. 봇 역할을 최상단으로 올린 뒤 다시 시도하세요.' : '');
    await log(guild, done);
    await dmOwner(guild, 'bomb', `**${guild.name}**\n${done}`);
    return done;
  } finally {
    bombing.delete(guild.id);
  }
}

/* ═════════════════════════ 연결 ═════════════════════════ */

function attach(client) {
  client.on('guildAuditLogEntryCreate', onAudit);
  // 서버를 나간 시각 기록 (의심 행동 로그의 '서버 퇴장일'에 쓰여요)
  client.on('guildMemberRemove', (member) => {
    const g = gs(member.guild.id);
    g.leftLog[member.id] = Date.now();
    const keys = Object.keys(g.leftLog);
    if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete g.leftLog[k];
    save();
  });
  // 차단된 서버에 초대되면 바로 나가요
  client.on('guildCreate', (guild) => {
    if (extraStore().guildBlacklist?.[guild.id]) {
      console.log(`[서버차단] ${guild.name} (${guild.id}) 에서 자동으로 나가요.`);
      guild.leave().catch(() => {});
    }
  });
}

function start(client) {
  applyActivity(client);
  for (const guild of client.guilds.cache.values()) {
    if (extraStore().guildBlacklist?.[guild.id]) guild.leave().catch(() => {});
  }
  setInterval(() => {
    const now = Date.now();
    // 비상 모드 자동 해제
    for (const guild of client.guilds.cache.values()) {
      const g = gs(guild.id);
      if (g.emergencyUntil && g.emergencyUntil <= now) releaseEmergency(guild, '자동 해제').catch(() => {});
    }
    // 메모리 정리
    for (const [k, arr] of repeatMap) if (!arr.length || now - arr[arr.length - 1].t > 60000) repeatMap.delete(k);
    for (const [k, t] of btnCool) if (now - t > 60000) btnCool.delete(k);
    for (const [k, t] of alertAt) if (now - t > 10 * 60000) alertAt.delete(k);
    for (const [k, arr] of suspMap) if (!arr.length || now - arr[arr.length - 1].t > 60000) suspMap.delete(k);
    for (const [k, t] of suspCool) if (now - t > 5 * 60000) suspCool.delete(k);
  }, 60 * 1000);
}

async function handleInteraction(i) {
  if (i.isButton() && i.guild && i.customId.startsWith('rolebtn:')) { await roleButton(i); return true; }
  return false;
}

module.exports = {
  dice, coin, pick, calc, afk, afkHandler, roleButtonCmd, channelInfo,
  emergency, purgeInvites, adminList, authUsers, securityReset,
  guildList, leaveGuild, guildBan, broadcast, setStatus, restart,
  suspicionCheck, serverPassword, serverBomb,
  isRepeatSpam, attach, start, applyActivity, handleInteraction, evaluate,
};
