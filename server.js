// server.js - 명령어마다의 실제 기능 구현 + 설정 저장소 + 공용 상태
const fs = require('fs');
const path = require('path');
const { PermissionFlagsBits, EmbedBuilder, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, version: DJS_VERSION } = require('discord.js');
const { extractUrls, scanUrl, defang, TRUSTED_DEFAULT } = require('./linkscan');

/* ───────────── 설정 저장소 (Turso / MongoDB / 파일) ─────────────
 * TURSO_DATABASE_URL + TURSO_AUTH_TOKEN 이 있으면 Turso를 우선 사용해요.
 * Turso가 없으면 MONGODB_URI, MONGO_URI 순으로 MongoDB를 사용하고, 둘 다 없으면 data.json 파일에 저장해요.
 *  - 전체 데이터를 하나의 문서(_id: 'main')로 두고, 1초마다 기존 문서를 통째로 덮어써요.
 *  - 1초마다 확인해서 바뀐 게 있을 때만 쓰기 때문에 결과는 "1초마다 새로 저장"과 같지만 불필요한 쓰기는 없어요.
 *  - 시작할 때 MongoDB 에서 먼저 불러와요. 불러오기에 실패하면 빈 데이터로 덮어쓰지 않도록 봇이 시작하지 않아요.
 * 환경변수: TURSO_DATABASE_URL + TURSO_AUTH_TOKEN 또는 MONGODB_URI / MONGODB_DB / MONGODB_COLLECTION
 */
const DATA = process.env.DATA_PATH || path.join(__dirname, 'data.json');
const TURSO_URL = (process.env.TURSO_DATABASE_URL || '').trim();
const TURSO_TOKEN = (process.env.TURSO_AUTH_TOKEN || '').trim();
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || '';
if (Boolean(TURSO_URL) !== Boolean(TURSO_TOKEN)) {
  throw new Error('Turso 설정이 불완전해요. TURSO_DATABASE_URL 과 TURSO_AUTH_TOKEN 을 모두 설정해주세요.');
}
const USE_TURSO = Boolean(TURSO_URL && TURSO_TOKEN);
let db = { guilds: {} };
try { db = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch { /* 첫 실행 */ }

function normalizeDb() {
  if (!db || typeof db !== 'object') db = {};
  if (!db.guilds || typeof db.guilds !== 'object') db.guilds = {};
  if (!Array.isArray(db.botAdmins)) db.botAdmins = [];
  if (!db.extra || typeof db.extra !== 'object') db.extra = {};
  if (!Array.isArray(db.extra.reminders)) db.extra.reminders = [];        // 알림(리마인더)
  if (!db.extra.polls || typeof db.extra.polls !== 'object') db.extra.polls = {};   // 투표 패널
  if (!db.extra.giveaways || typeof db.extra.giveaways !== 'object') db.extra.giveaways = {};   // 추첨
  if (!db.blacklist || typeof db.blacklist !== 'object') db.blacklist = {};   // { userId: {reason, at, by} } 전역 블랙리스트
  if (!db.backups || typeof db.backups !== 'object') db.backups = {};   // { guildId: { latest, prev } } 서버 백업
}
normalizeDb();

const storeInfo = {
  mode: USE_TURSO ? 'turso' : (MONGO_URI ? 'mongodb' : 'file'), ready: !(USE_TURSO || MONGO_URI), lastSavedAt: 0, saves: 0, errors: 0, lastError: null, bytes: 0, intervalMs: 1000,
};
let mongoClient = null;
let mongoCol = null;
let tursoClient = null;
let lastJson = null;
let flushing = false;
let flushTimer = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 저장은 1초마다 자동으로 해요. (호출은 예전 코드와의 호환용)
function save() { /* 1초 저장 루프가 변경을 감지해요 */ }

async function flush(force = false) {
  if (!storeInfo.ready || flushing) return;
  const json = JSON.stringify(db);
  if (!force && json === lastJson) return;
  flushing = true;
  try {
    if (tursoClient) {
      await tursoClient.execute({
        sql: 'INSERT INTO bot_state (id, data, saved_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, saved_at = excluded.saved_at',
        args: ['main', json, new Date().toISOString()],
      });
    } else if (mongoCol) {
      await mongoCol.replaceOne({ _id: 'main' }, { _id: 'main', data: JSON.parse(json), savedAt: new Date() }, { upsert: true });
    } else {
      const tmp = DATA + '.tmp';
      await fs.promises.writeFile(tmp, json);
      await fs.promises.rename(tmp, DATA);
    }
    lastJson = json;
    storeInfo.lastSavedAt = Date.now();
    storeInfo.saves++;
    storeInfo.bytes = Buffer.byteLength(json);
  } catch (err) {
    storeInfo.errors++;
    storeInfo.lastError = String(err.message || err).slice(0, 200);
    console.error('[저장 오류]', err.message);
  } finally {
    flushing = false;
  }
}

// 봇 시작 전에 한 번 호출: DB 연결 + 불러오기 + 1초 저장 루프 시작
async function initStore() {
  if (USE_TURSO) {
    const { createClient } = require('@libsql/client');
    let lastErr;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        tursoClient = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
        await tursoClient.execute(`CREATE TABLE IF NOT EXISTS bot_state (id TEXT PRIMARY KEY, data TEXT NOT NULL, saved_at TEXT NOT NULL)`);
        const result = await tursoClient.execute({ sql: 'SELECT data FROM bot_state WHERE id = ?', args: ['main'] });
        if (result.rows.length && result.rows[0].data) {
          const parsed = JSON.parse(String(result.rows[0].data));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Turso에 저장된 데이터 형식이 올바르지 않아요.');
          db = parsed;
          normalizeDb();
          lastJson = JSON.stringify(db);
          console.log(`🗄️ Turso에서 데이터를 불러왔어요. (서버 ${Object.keys(db.guilds).length}개)`);
        } else {
          console.log('🗄️ Turso가 비어 있어요. 기존 data.json 데이터를 최초 저장해요.');
        }
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        console.error(`[Turso 연결 실패 ${attempt}/5]`, err.message);
        try { tursoClient?.close(); } catch {}
        tursoClient = null;
        if (attempt < 5) await sleep(3000 * attempt);
      }
    }
    if (lastErr) throw new Error('Turso에 연결하지 못했어요. TURSO_DATABASE_URL, TURSO_AUTH_TOKEN 및 데이터베이스 접근 권한을 확인해주세요: ' + lastErr.message);
    storeInfo.ready = true;
  } else if (MONGO_URI) {
    const { MongoClient } = require('mongodb');
    let lastErr;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        mongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
        await mongoClient.connect();
        mongoCol = mongoClient.db(process.env.MONGODB_DB || 'security').collection(process.env.MONGODB_COLLECTION || 'botdata');
        const doc = await mongoCol.findOne({ _id: 'main' });
        if (doc?.data) {
          db = doc.data;
          normalizeDb();
          lastJson = JSON.stringify(db);
          console.log(`🗄️ MongoDB에서 데이터를 불러왔어요. (서버 ${Object.keys(db.guilds).length}개)`);
        } else {
          console.log('🗄️ MongoDB가 비어 있어요. 현재 데이터(data.json 이 있으면 그 내용)를 올려요.');
        }
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        console.error(`[MongoDB 연결 실패 ${attempt}/5]`, err.message);
        await mongoClient?.close().catch(() => {});
        mongoClient = null;
        mongoCol = null;
        if (attempt < 5) await sleep(3000 * attempt);
      }
    }
    if (lastErr) throw new Error('MongoDB에 연결하지 못했어요. MONGODB_URI, 비밀번호, Atlas Network Access(IP 허용)를 확인해주세요: ' + lastErr.message);
    storeInfo.ready = true;
  }
  await flush();
  flushTimer = setInterval(() => { flush().catch((err) => console.error('[저장 루프 오류]', err.message)); }, storeInfo.intervalMs);
  console.log(`💾 저장 방식: ${storeInfo.mode} (1초마다 변경 사항 자동 저장)`);
}

// 종료 직전에 마지막으로 저장
async function shutdownStore() {
  clearInterval(flushTimer);
  await flush(true);
  await mongoClient?.close().catch(() => {});
  try { tursoClient?.close(); } catch {}
}

const DEFAULTS = {
  logChannel: null,
  antiSpam: true,
  antiInvite: true,
  antiLink: false,     // 모든 링크 차단
  antiScan: true,      // 미검증 링크 접속 검사
  antiMention: true,
  antiBadword: true,
  antiRaid: true,
  antiDdos: true,      // 비슷한 이름 대량 입장 감지
  antiNuke: true,
  antiNukeRecover: true, // 삭제된 채널/역할 자동 복구 시도
  antiNukeContain: true, // 위험 신호 4점 이상이면 위험 권한 회수 + 타임아웃
  minAccountAgeDays: 0,
  spamLimit: 5,
  spamSeconds: 5,
  mentionLimit: 5,
  watchHours: 24,      // 경계 유지 시간
  badWords: [],
  whitelist: [],
  trustedDomains: [],  // 서버가 추가한 신뢰 도메인
  watch: {},           // { userId: 만료시각 }  경계 대상
  tempBans: {},        // { userId: 만료시각 }
  lockdown: [],        // 서버잠금으로 잠근 채널 ID
  warns: {},
  quarantines: {},          // 안티누크 격리 상태 및 격리 전 역할 스냅샷
  moderationLogs: [],       // 구조화된 모더레이션/감사 로그 (최근 500건)
  messageArchive: [],       // 삭제/수정 메시지 아카이브 (최근 500건)
  archiveEnabled: true,
  welcomeChannel: null,  // 환영 메시지 채널
  welcomeMessage: '{user} 님, **{server}** 에 오신 걸 환영해요! 🎉 (현재 {count}명)',
  autoRole: null,        // 입장 시 자동으로 줄 역할 ID
  verifyChannel: null,   // 인증 채널
  verifyMessage: null,   // 인증 버튼 메시지 ID
  verifyRole: null,      // 인증 성공 시 줄 역할
  trapChannel: null,   // 자동킥채널: 여기에 메시지 보내면 1일 타임아웃
  memos: {},           // { userId: [{text, by, at}] } 관리자 메모
  authUsers: [],       // 이 서버에서만 봇을 쓸 수 있는 인증 유저 (봇을 서버에 추가한 사람 등, 서버백업 권한 없음)
  antiBotAdd: true,    // 허가 없는 봇 추가 차단
  antiRoleGrant: true, // 관리자/서버관리/역할관리 권한 역할을 허가 없이 주면 되돌림
  antiWebhook: false,  // 허가 없는 웹훅 생성 삭제 (기본 꺼짐)
  antiMassPunish: true,// 통합 안티누크 비활성 시에도 밴/킥 위험 이벤트 감시
  afk: {},             // { userId: {reason, at} } 잠수 중인 유저
  emergencyUntil: 0,   // 비상 모드 종료 시각 (0이면 꺼짐)
  suspectLog: true,    // 판단이 애매한 의심 행동을 유저 정보와 함께 로그 채널에 알림
  leftLog: {},         // { userId: 마지막 퇴장 시각 }
  serverPw: null,      // { salt, hash } 서버 비밀번호 (평문은 저장하지 않아요)
  pwFails: 0,          // 비밀번호 연속 실패 횟수
  pwLockUntil: 0,      // 비밀번호 입력 잠금 해제 시각
};

function gs(guildId) {
  if (!db.guilds[guildId]) db.guilds[guildId] = {};
  const g = db.guilds[guildId];
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (g[k] === undefined) g[k] = structuredClone(v);
  }
  return g;
}

// 저장하지 않는 실시간 상태 (main.js 와 공유)
const state = {
  startedAt: Date.now(),
  raidUntil: new Map(),   // guildId -> 레이드 모드 종료 시각
  ddosFlags: new Map(),   // guildId -> [{key, until, keptId}]
  nameLog: new Map(),     // guildId -> [{id, keys, at}]
};

/* ───────────── 공용 유틸 ───────────── */
// 시간 문자열 → ms. "10m" "1시간" "1h30m" "2일" 지원, bareMs 를 주면 숫자만 써도 그 단위로 해석(예: 60000 = 분)
function parseDuration(s, cap = true, bareMs = null) {
  s = String(s || '').trim().toLowerCase();
  if (!s) return null;
  const MULT = { '초': 1e3, s: 1e3, '분': 6e4, m: 6e4, '시간': 36e5, h: 36e5, '일': 864e5, d: 864e5 };
  let ms = 0;
  if (/^\d+$/.test(s)) {
    if (!bareMs) return null;
    ms = Number(s) * bareMs;
  } else {
    const re = /(\d+)(초|시간|분|일|s|m|h|d)/g;
    let pos = 0;
    let x;
    while ((x = re.exec(s))) {
      if (x.index !== pos) return null;
      ms += Number(x[1]) * MULT[x[2]];
      pos = re.lastIndex;
    }
    if (pos !== s.length) return null;
  }
  if (!ms) return null;
  return cap ? Math.min(ms, 28 * 864e5) : Math.min(ms, 365 * 864e5);
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}초`;
  if (s < 3600) return `${Math.round(s / 60)}분`;
  if (s < 86400) return `${Math.round(s / 3600)}시간`;
  return `${Math.round(s / 86400)}일`;
}

async function log(guild, text) {
  const id = gs(guild.id).logChannel;
  if (!id) return;
  const ch = guild.channels.cache.get(id);
  if (ch?.isTextBased()) ch.send({ content: text.slice(0, 1900), allowedMentions: { parse: [] } }).catch(() => {});
}

async function resolveMember(m, args) {
  const mentioned = m.mentions.members.first();
  if (mentioned) return mentioned;
  const id = (args[0] || '').replace(/\D/g, '');
  if (!id) return null;
  return m.guild.members.fetch(id).catch(() => null);
}

// 봇 소유자: .권한부여 / .권한해제 / .권한목록 은 이 ID만 쓸 수 있어요. (환경변수 BOT_OWNER_ID 로 변경 가능)
const OWNER_ID = String(process.env.BOT_OWNER_ID || '1510598626718781500').trim();
function isOwner(userId) {
  return String(userId) === OWNER_ID;
}

// 봇 관리자: 소유자 + 환경변수 BOT_ADMIN_IDS(쉼표 구분) + .권한부여 로 추가한 유저 (data.json 에 저장)
const ENV_ADMINS = (process.env.BOT_ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
function isBotAdmin(userId) {
  const id = String(userId);
  return id === OWNER_ID || ENV_ADMINS.includes(id) || db.botAdmins.includes(id);
}

// 서버 단위 인증: 봇 관리자 + 그 서버의 방장(자동) + 그 서버의 인증 유저(authUsers)
function isAuthed(userId, guild) {
  const id = String(userId);
  if (isBotAdmin(id)) return true;
  if (!guild) return false;
  return id === String(guild.ownerId) || gs(guild.id).authUsers.includes(id);
}

// 서버백업 / 서버복원 / 서버백업정보 : 봇 소유자 + 그 서버의 방장만
function canBackup(userId, guild) {
  return isOwner(userId) || (!!guild && String(userId) === String(guild.ownerId));
}

// 봇을 서버에 추가한 사람 등을 그 서버의 인증 유저로 등록 (서버백업 권한은 없음). 새로 등록했으면 true
function addGuildAuth(guildId, userId) {
  const g = gs(guildId);
  const id = String(userId);
  if (g.authUsers.includes(id)) return false;
  g.authUsers.push(id);
  save();
  return true;
}

// 백업 저장소 (db 가 다시 불러와져도 항상 현재 객체를 돌려줘요)
function extraStore() {
  normalizeDb();
  return db.extra;
}

function blacklistStore() {
  normalizeDb();
  return db.blacklist;
}

function backupStore() {
  normalizeDb();
  return db.backups;
}

function isExempt(member) {
  if (!member) return false;
  const g = gs(member.guild.id);
  return (
    isBotAdmin(member.id) ||
    member.id === member.guild.ownerId ||
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageMessages) ||
    g.whitelist.includes(member.id) ||
    g.authUsers.includes(member.id)
  );
}

function checkTarget(m, target) {
  if (!target) return '대상 유저를 찾을 수 없어요. 멘션하거나 ID를 입력해주세요.';
  if (target.id === m.author.id) return '자기 자신에게는 사용할 수 없어요.';
  if (target.id === m.guild.ownerId) return '서버 주인에게는 사용할 수 없어요.';
  if (target.id === m.client.user.id) return '저한테는 사용할 수 없어요 😅';
  if (m.author.id !== m.guild.ownerId && !isBotAdmin(m.author.id) && target.roles.highest.position >= m.member.roles.highest.position)
    return '나와 같거나 더 높은 역할의 유저에게는 사용할 수 없어요.';
  return null;
}

/* ───────────── 경계(Watch) ───────────── */
function isWatched(guildId, userId) {
  const g = gs(guildId);
  const exp = g.watch[userId];
  if (!exp) return false;
  if (exp < Date.now()) { delete g.watch[userId]; save(); return false; }
  return true;
}

function addWatch(guildId, userId, hours) {
  const g = gs(guildId);
  g.watch[userId] = Date.now() + (hours || g.watchHours) * 36e5;
  save();
}

/* ───────────── 경고 누적 자동 처벌 (3회 1시간 타임아웃 / 5회 킥) ───────────── */
async function addWarn(guild, member, reason, by = 'AutoMod') {
  const g = gs(guild.id);
  (g.warns[member.id] ||= []).push({ reason, by, at: Date.now() });
  save();
  const count = g.warns[member.id].length;
  let extra = '';
  if (count >= 5 && member.kickable) {
    await member.kick(`경고 ${count}회 누적`).catch(() => {});
    extra = ' → 경고 5회 누적으로 **킥**';
  } else if (count >= 3 && member.moderatable) {
    await member.timeout(36e5, `경고 ${count}회 누적`).catch(() => {});
    extra = ' → 경고 3회 이상 누적으로 **1시간 타임아웃**';
  }
  await log(guild, `⚠️ 경고 | ${member.user.tag} (${count}회) | ${reason} | by ${by}${extra}`);
  return { count, extra };
}

/* ═════════════ 명령어 기능들 ═════════════ */
const F = {};

/* ── 처벌 ── */
F.ban = async (m, args) => {
  const t = await resolveMember(m, args);
  const err = checkTarget(m, t);
  if (err) return err;
  if (!t.bannable) return '제가 밴할 수 없는 유저예요. (제 역할이 더 낮아요)';
  const reason = args.slice(1).join(' ') || '사유 없음';
  await t.ban({ reason: `${m.author.tag}: ${reason}`, deleteMessageSeconds: 0 });
  await log(m.guild, `🔨 밴 | ${t.user.tag} | by ${m.author.tag} | ${reason}`);
  return `🔨 **${t.user.tag}** 님을 밴했어요. (사유: ${reason})`;
};

F.tempban = async (m, args) => {
  const t = await resolveMember(m, args);
  const err = checkTarget(m, t);
  if (err) return err;
  const ms = parseDuration(args[1], false);
  if (!ms) return '사용법: `.임시밴 @유저 <1h|1d|7d> [사유]` (최대 365일)';
  if (!t.bannable) return '제가 밴할 수 없는 유저예요.';
  const reason = args.slice(2).join(' ') || '사유 없음';
  await t.ban({ reason: `[임시밴 ${fmtDuration(ms)}] ${m.author.tag}: ${reason}` });
  gs(m.guild.id).tempBans[t.id] = Date.now() + ms;
  save();
  await log(m.guild, `⏳ 임시밴 | ${t.user.tag} | ${fmtDuration(ms)} | by ${m.author.tag} | ${reason}`);
  return `⏳ **${t.user.tag}** 님을 ${fmtDuration(ms)} 동안 밴했어요. 시간이 지나면 자동으로 풀려요.`;
};

F.softban = async (m, args) => {
  const t = await resolveMember(m, args);
  const err = checkTarget(m, t);
  if (err) return err;
  if (!t.bannable) return '제가 밴할 수 없는 유저예요.';
  const reason = args.slice(1).join(' ') || '사유 없음';
  await t.ban({ reason: `[소프트밴] ${m.author.tag}: ${reason}`, deleteMessageSeconds: 86400 });
  await m.guild.bans.remove(t.id, '소프트밴 해제').catch(() => {});
  await log(m.guild, `🧹 소프트밴 | ${t.user.tag} | by ${m.author.tag} | ${reason}`);
  return `🧹 **${t.user.tag}** 님을 소프트밴했어요. (최근 24시간 메시지 삭제 + 즉시 밴 해제)`;
};

F.massban = async (m, args) => {
  const ids = [...new Set(args.filter((a) => /^\d{17,20}$/.test(a)))].slice(0, 20);
  if (!ids.length) return '사용법: `.일괄밴 <유저ID> <유저ID> ...` (최대 20명)';
  let ok = 0;
  for (const id of ids) {
    if (id === m.author.id || id === m.guild.ownerId || id === m.client.user.id) continue;
    const mem = await m.guild.members.fetch(id).catch(() => null);
    if (mem && (!mem.bannable || (m.author.id !== m.guild.ownerId && mem.roles.highest.position >= m.member.roles.highest.position))) continue;
    await m.guild.bans.create(id, { reason: `[일괄밴] ${m.author.tag}`, deleteMessageSeconds: 3600 }).then(() => ok++).catch(() => {});
  }
  await log(m.guild, `🔨 일괄밴 | ${ok}/${ids.length}명 | by ${m.author.tag}`);
  return `🔨 ${ids.length}명 중 **${ok}명**을 밴했어요.`;
};

F.unban = async (m, args) => {
  const id = (args[0] || '').replace(/\D/g, '');
  if (!id) return '사용법: `.언밴 <유저ID>`';
  await m.guild.bans.remove(id, `${m.author.tag}`).catch(() => { throw new Error('밴 목록에 없는 유저예요.'); });
  delete gs(m.guild.id).tempBans[id];
  save();
  await log(m.guild, `♻️ 언밴 | ${id} | by ${m.author.tag}`);
  return `♻️ \`${id}\` 님의 밴을 해제했어요.`;
};

F.banlist = async (m) => {
  const bans = await m.guild.bans.fetch({ limit: 20 });
  if (!bans.size) return '✅ 밴된 유저가 없어요.';
  const lines = bans.map((b) => `• ${b.user.tag} (\`${b.user.id}\`) — ${(b.reason || '사유 없음').slice(0, 60)}`);
  return `🔨 최근 밴 ${bans.size}명\n${lines.join('\n')}`;
};

F.kick = async (m, args) => {
  const t = await resolveMember(m, args);
  const err = checkTarget(m, t);
  if (err) return err;
  if (!t.kickable) return '제가 킥할 수 없는 유저예요.';
  const reason = args.slice(1).join(' ') || '사유 없음';
  await t.kick(`${m.author.tag}: ${reason}`);
  await log(m.guild, `👢 킥 | ${t.user.tag} | by ${m.author.tag} | ${reason}`);
  return `👢 **${t.user.tag}** 님을 킥했어요. (사유: ${reason})`;
};

F.mute = async (m, args) => {
  const t = await resolveMember(m, args);
  const err = checkTarget(m, t);
  if (err) return err;
  if (!t.moderatable) return '제가 타임아웃할 수 없는 유저예요.';
  // 유저는 멘션 또는 ID, 시간은 10m / 1h / 1d / 1시간30분 / 숫자만 쓰면 분 단위
  const parsed = parseDuration(args[1], true, 6e4);
  const ms = parsed ?? 10 * 6e4;
  const reason = args.slice(parsed ? 2 : 1).join(' ') || '사유 없음';
  await t.timeout(ms, `${m.author.tag}: ${reason}`);
  await log(m.guild, `🔇 타임아웃 | ${t.user.tag} | ${fmtDuration(ms)} | by ${m.author.tag} | ${reason}`);
  return `🔇 **${t.user.tag}** 님을 ${fmtDuration(ms)} 동안 타임아웃했어요. (사유: ${reason})`;
};

F.unmute = async (m, args) => {
  const t = await resolveMember(m, args);
  if (!t) return '대상 유저를 찾을 수 없어요.';
  await t.timeout(null);
  await log(m.guild, `🔊 타임아웃 해제 | ${t.user.tag} | by ${m.author.tag}`);
  return `🔊 **${t.user.tag}** 님의 타임아웃을 해제했어요.`;
};

/* ── 경고 ── */
F.warn = async (m, args) => {
  const t = await resolveMember(m, args);
  const err = checkTarget(m, t);
  if (err) return err;
  const reason = args.slice(1).join(' ') || '사유 없음';
  const { count, extra } = await addWarn(m.guild, t, reason, m.author.tag);
  return `⚠️ **${t.user.tag}** 님에게 경고를 줬어요. (누적 ${count}회)${extra}\n사유: ${reason}`;
};

F.warnings = async (m, args) => {
  const t = (await resolveMember(m, args)) || m.member;
  const list = gs(m.guild.id).warns[t.id] || [];
  if (!list.length) return `✅ **${t.user.tag}** 님은 경고가 없어요.`;
  const start = Math.max(0, list.length - 10);
  const lines = list.slice(start).map((w, i) => `${start + i + 1}. ${w.reason} — ${w.by} (<t:${Math.floor(w.at / 1000)}:R>)`);
  return `⚠️ **${t.user.tag}** 님의 경고 ${list.length}회\n${lines.join('\n')}\n(경고 하나만 지우려면 \`.경고삭제 @유저 <번호>\`)`;
};

F.clearwarns = async (m, args) => {
  const t = await resolveMember(m, args);
  if (!t) return '대상 유저를 찾을 수 없어요.';
  delete gs(m.guild.id).warns[t.id];
  save();
  await log(m.guild, `🧹 경고 초기화 | ${t.user.tag} | by ${m.author.tag}`);
  return `🧹 **${t.user.tag}** 님의 경고를 모두 지웠어요.`;
};

/* ── 채널 관리 ── */
F.clear = async (m, args) => {
  const n = Number(args[0]);
  if (!Number.isInteger(n) || n < 1 || n > 100) return '사용법: `.청소 <1~100>`';
  const deleted = await m.channel.bulkDelete(n + 1, true);
  await log(m.guild, `🧽 청소 | #${m.channel.name} | ${deleted.size - 1}개 | by ${m.author.tag}`);
  return `🧽 메시지 ${Math.max(deleted.size - 1, 0)}개를 삭제했어요.`;
};

F.cleanuser = async (m, args) => {
  const t = await resolveMember(m, args);
  if (!t) return '사용법: `.청소유저 @유저 [개수]`';
  const n = Math.min(Math.max(Number(args[1]) || 50, 1), 100);
  const recent = await m.channel.messages.fetch({ limit: 100 });
  const mine = recent.filter((x) => x.author.id === t.id).first(n);
  const deleted = await m.channel.bulkDelete(mine, true);
  await log(m.guild, `🧽 유저 메시지 청소 | ${t.user.tag} | ${deleted.size}개 | #${m.channel.name} | by ${m.author.tag}`);
  return `🧽 **${t.user.tag}** 님의 메시지 ${deleted.size}개를 삭제했어요.`;
};

F.cleanbots = async (m) => {
  const recent = await m.channel.messages.fetch({ limit: 100 });
  const bots = recent.filter((x) => x.author.bot);
  const deleted = await m.channel.bulkDelete(bots, true);
  return `🤖 봇 메시지 ${deleted.size}개를 삭제했어요.`;
};

F.lock = async (m) => {
  await m.channel.permissionOverwrites.edit(m.guild.roles.everyone, { SendMessages: false });
  await log(m.guild, `🔒 채널 잠금 | #${m.channel.name} | by ${m.author.tag}`);
  return '🔒 이 채널을 잠갔어요. (`.잠금해제`로 풀 수 있어요)';
};

F.unlock = async (m) => {
  await m.channel.permissionOverwrites.edit(m.guild.roles.everyone, { SendMessages: null });
  await log(m.guild, `🔓 채널 잠금 해제 | #${m.channel.name} | by ${m.author.tag}`);
  return '🔓 이 채널의 잠금을 해제했어요.';
};

// 서버 전체 잠금 (이미 잠긴 채널은 건드리지 않고, 푸는 것도 우리가 잠근 채널만)
F.lockdown = async (m) => {
  const g = gs(m.guild.id);
  const everyone = m.guild.roles.everyone;
  let n = 0;
  for (const c of m.guild.channels.cache.filter((x) => x.type === ChannelType.GuildText).values()) {
    const ow = c.permissionOverwrites.cache.get(everyone.id);
    if (ow?.deny.has(PermissionFlagsBits.SendMessages)) continue;
    try {
      await c.permissionOverwrites.edit(everyone, { SendMessages: false });
      if (!g.lockdown.includes(c.id)) g.lockdown.push(c.id);
      n++;
    } catch { /* 권한 없는 채널 */ }
  }
  save();
  await log(m.guild, `🚨 서버 전체 잠금 | ${n}개 채널 | by ${m.author.tag}`);
  return `🚨 채널 ${n}개를 잠갔어요. 풀려면 \`.서버잠금해제\``;
};

F.unlockdown = async (m) => {
  const g = gs(m.guild.id);
  let n = 0;
  for (const id of g.lockdown) {
    const c = m.guild.channels.cache.get(id);
    if (!c) continue;
    try {
      await c.permissionOverwrites.edit(m.guild.roles.everyone, { SendMessages: null });
      n++;
    } catch { /* 무시 */ }
  }
  g.lockdown = [];
  save();
  await log(m.guild, `✅ 서버 전체 잠금 해제 | ${n}개 채널 | by ${m.author.tag}`);
  return `✅ 채널 ${n}개의 잠금을 풀었어요.`;
};

F.slowmode = async (m, args) => {
  const sec = parseDuration(args[0]) ? parseDuration(args[0]) / 1000 : Number(args[0]);
  if (!Number.isFinite(sec) || sec < 0 || sec > 21600) return '사용법: `.슬로우모드 <초>` (0이면 해제, 최대 6시간)';
  await m.channel.setRateLimitPerUser(sec);
  return sec === 0 ? '🐇 슬로우모드를 해제했어요.' : `🐢 슬로우모드를 ${fmtDuration(sec * 1000)}로 설정했어요.`;
};

F.announce = async (m, args) => {
  const ch = m.mentions.channels.first() || m.channel;
  const text = args.filter((a) => !/^<#\d+>$/.test(a)).join(' ');
  if (!text) return '사용법: `.공지 [#채널] <내용>`';
  const e = new EmbedBuilder().setColor(0xfee75c).setTitle('📢 공지').setDescription(text.slice(0, 3500)).setFooter({ text: m.author.tag });
  await ch.send({ embeds: [e], allowedMentions: { parse: [] } });
  return ch.id === m.channel.id ? '📢 공지를 보냈어요.' : `📢 ${ch} 에 공지를 보냈어요.`;
};

/* ── 역할/닉네임 ── */
F.addrole = async (m, args) => {
  const t = await resolveMember(m, args);
  const role = m.mentions.roles.first();
  if (!t || !role) return '사용법: `.역할지급 @유저 @역할`';
  const bad = checkRole(m, role);
  if (bad) return bad;
  await t.roles.add(role, `${m.author.tag}`);
  await log(m.guild, `🏷️ 역할 지급 | ${t.user.tag} ← ${role.name} | by ${m.author.tag}`);
  return `🏷️ **${t.user.tag}** 님에게 **${role.name}** 역할을 줬어요.`;
};

F.removerole = async (m, args) => {
  const t = await resolveMember(m, args);
  const role = m.mentions.roles.first();
  if (!t || !role) return '사용법: `.역할회수 @유저 @역할`';
  const bad = checkRole(m, role);
  if (bad) return bad;
  await t.roles.remove(role, `${m.author.tag}`);
  await log(m.guild, `🏷️ 역할 회수 | ${t.user.tag} ✕ ${role.name} | by ${m.author.tag}`);
  return `🏷️ **${t.user.tag}** 님의 **${role.name}** 역할을 회수했어요.`;
};

function checkRole(m, role) {
  if (role.managed || role.id === m.guild.id) return '봇/부스트 전용 역할이거나 @everyone 은 사용할 수 없어요.';
  if (m.author.id !== m.guild.ownerId && !isBotAdmin(m.author.id)) {
    if (role.position >= m.member.roles.highest.position) return '내 최고 역할보다 높거나 같은 역할은 다룰 수 없어요.';
    if (role.permissions.has(PermissionFlagsBits.Administrator)) return '관리자 권한이 있는 역할은 서버 주인만 다룰 수 있어요.';
  }
  if (role.position >= m.guild.members.me.roles.highest.position) return '제 역할보다 높은 역할이라 다룰 수 없어요.';
  return null;
}

F.nick = async (m, args) => {
  const t = await resolveMember(m, args);
  const err = checkTarget(m, t);
  if (err) return err;
  if (!t.manageable) return '제가 닉네임을 바꿀 수 없는 유저예요.';
  const name = args.slice(1).join(' ').slice(0, 32);
  await t.setNickname(name || null, `${m.author.tag}`);
  return name ? `✏️ **${t.user.username}** 님의 닉네임을 \`${name}\` 으로 바꿨어요.` : `✏️ **${t.user.username}** 님의 닉네임을 초기화했어요.`;
};

/* ── 자동 보안 설정 ── */
F.logchannel = async (m) => {
  const ch = m.mentions.channels.first() || m.channel;
  gs(m.guild.id).logChannel = ch.id;
  save();
  return `📝 로그 채널을 ${ch} 로 설정했어요.`;
};

const FEATURES = {
  스팸: ['antiSpam', '스팸 방지'], spam: ['antiSpam', '스팸 방지'],
  초대: ['antiInvite', '초대링크 차단'], invite: ['antiInvite', '초대링크 차단'],
  링크: ['antiLink', '모든 링크 차단'], link: ['antiLink', '모든 링크 차단'],
  링크검사: ['antiScan', '미검증 링크 악성 검사'], scan: ['antiScan', '미검증 링크 악성 검사'],
  멘션: ['antiMention', '멘션 도배 방지'], mention: ['antiMention', '멘션 도배 방지'],
  욕설: ['antiBadword', '금칙어 필터'], badword: ['antiBadword', '금칙어 필터'],
  레이드: ['antiRaid', '레이드(대량 입장) 방어'], raid: ['antiRaid', '레이드(대량 입장) 방어'],
  디도스: ['antiDdos', '비슷한 이름 대량 입장(디도스) 방어'], ddos: ['antiDdos', '비슷한 이름 대량 입장(디도스) 방어'],
  테러: ['antiNuke', '서버 테러 통합 감시'], nuke: ['antiNuke', '서버 테러 통합 감시'], 복구: ['antiNukeRecover', '삭제된 채널/역할 자동 복구'], nukerecover: ['antiNukeRecover', '삭제된 채널/역할 자동 복구'],
  누크격리: ['antiNukeContain', '전용 격리 채팅방 생성 및 일반 채널 접근 차단'], nukecontain: ['antiNukeContain', '전용 격리 채팅방 생성 및 일반 채널 접근 차단'],
    봇추가: ['antiBotAdd', '허가 없는 봇 추가 차단'], botadd: ['antiBotAdd', '허가 없는 봇 추가 차단'],
  권한감시: ['antiRoleGrant', '위험 권한 역할 부여 되돌리기'], rolegrant: ['antiRoleGrant', '위험 권한 역할 부여 되돌리기'],
  웹훅: ['antiWebhook', '허가 없는 웹훅 생성 삭제'], webhook: ['antiWebhook', '허가 없는 웹훅 생성 삭제'],
  대량처벌: ['antiMassPunish', '대량 밴/킥 감시'], masspunish: ['antiMassPunish', '대량 밴/킥 감시'],
  의심: ['suspectLog', '의심 행동 로그 알림'], suspect: ['suspectLog', '의심 행동 로그 알림'],
};

F.security = async (m, args) => {
  const g = gs(m.guild.id);
  const key = (args[0] || '').toLowerCase();
  if (!key || key === '상태' || key === 'status') {
    const on = (b) => (b ? '🟢 켜짐' : '🔴 꺼짐');
    const watching = Object.keys(g.watch).filter((id) => isWatched(m.guild.id, id)).length;
    const e = new EmbedBuilder()
      .setTitle('🛡️ 보안 상태')
      .setColor(0x5865f2)
      .setDescription([
        `스팸 방지: ${on(g.antiSpam)} (${g.spamSeconds}초에 ${g.spamLimit}개)`,
        `초대링크 차단: ${on(g.antiInvite)}`,
        `모든 링크 차단: ${on(g.antiLink)}`,
        `미검증 링크 악성 검사: ${on(g.antiScan)} (신뢰 도메인 ${TRUSTED_DEFAULT.length + g.trustedDomains.length}개)`,
        `멘션 도배 방지: ${on(g.antiMention)} (${g.mentionLimit}개 이상)`,
        `금칙어 필터: ${on(g.antiBadword)} (${g.badWords.length}개 등록)`,
        `레이드 방어: ${on(g.antiRaid)}`,
        `디도스(비슷한 이름) 방어: ${on(g.antiDdos)}`,
        `테러 방어: ${on(g.antiNuke)}`,
        `누크 자동 복구: ${on(g.antiNukeRecover)}`,
        `누크 격리(격리 역할·전용 채팅방·일반 채널 차단): ${on(g.antiNukeContain)}`,
        `누크 자동 밴: 🔴 사용 안 함 (격리 후 관리자 판단)`,
        `허가 없는 봇 추가 차단: ${on(g.antiBotAdd)}`,
        `위험 권한 역할 부여 되돌리기: ${on(g.antiRoleGrant)}`,
        `허가 없는 웹훅 삭제: ${on(g.antiWebhook)}`,
        `대량 밴/킥 감시: ${on(g.antiMassPunish)}`,
        `의심 행동 로그 알림: ${on(g.suspectLog)}`,
        `최소 계정 나이: ${g.minAccountAgeDays ? g.minAccountAgeDays + '일' : '제한 없음'}`,
        `경계 대상: ${watching}명 (경계 유지 ${g.watchHours}시간)`,
        `로그 채널: ${g.logChannel ? `<#${g.logChannel}>` : '미설정'}`,
        `화이트리스트: ${g.whitelist.length}명`,
        `Safe Browsing 연동: ${process.env.GSB_API_KEY ? '🟢 사용 중' : '⚪ 미설정(선택)'}`,
      ].join('\n'));
    return { embeds: [e] };
  }
  const feat = FEATURES[key];
  const toggle = (args[1] || '').toLowerCase();
  if (!feat || !['켜기', '끄기', 'on', 'off'].includes(toggle))
    return '사용법: `.보안 <스팸|초대|링크|링크검사|멘션|욕설|레이드|디도스|테러|복구|누크격리|봇추가|권한감시|웹훅|대량처벌|의심> <켜기|끄기>`\n현재 상태: `.보안 상태`';
  g[feat[0]] = ['켜기', 'on'].includes(toggle);
  save();
  await log(m.guild, `🛡️ 보안 설정 | ${feat[1]} ${g[feat[0]] ? 'ON' : 'OFF'} | by ${m.author.tag}`);
  return `🛡️ **${feat[1]}** 기능을 ${g[feat[0]] ? '켰어요 🟢' : '껐어요 🔴'}`;
};

F.spamset = async (m, args) => {
  const n = Number(args[0]);
  const s = Number(args[1]);
  if (!Number.isInteger(n) || !Number.isInteger(s) || n < 2 || n > 20 || s < 2 || s > 30)
    return '사용법: `.스팸설정 <개수 2~20> <초 2~30>` (예: `.스팸설정 5 5` = 5초에 5개)';
  const g = gs(m.guild.id);
  g.spamLimit = n;
  g.spamSeconds = s;
  save();
  return `⚙️ 이제 ${s}초 안에 메시지 ${n}개를 보내면 도배로 판단해요.`;
};

F.mentionset = async (m, args) => {
  const n = Number(args[0]);
  if (!Number.isInteger(n) || n < 2 || n > 20) return '사용법: `.멘션설정 <개수 2~20>`';
  gs(m.guild.id).mentionLimit = n;
  save();
  return `⚙️ 한 메시지에 멘션이 ${n}개 이상이면 도배로 판단해요.`;
};

F.badword = async (m, args) => {
  const g = gs(m.guild.id);
  const sub = args[0];
  const word = args.slice(1).join(' ').toLowerCase();
  if (sub === '목록') return g.badWords.length ? `🚫 금칙어: ||${g.badWords.join(', ')}||` : '등록된 금칙어가 없어요.';
  if (!word || !['추가', '삭제'].includes(sub)) return '사용법: `.금칙어 <추가|삭제|목록> [단어]`';
  if (sub === '추가') { if (!g.badWords.includes(word)) g.badWords.push(word); }
  else g.badWords = g.badWords.filter((w) => w !== word);
  save();
  return sub === '추가' ? '🚫 금칙어를 추가했어요.' : '✅ 금칙어를 삭제했어요.';
};

F.whitelist = async (m, args) => {
  const g = gs(m.guild.id);
  const sub = args[0];
  if (sub === '목록') return g.whitelist.length ? `✅ 화이트리스트: ${g.whitelist.map((i) => `<@${i}>`).join(' ')}` : '화이트리스트가 비어 있어요.';
  const t = await resolveMember(m, args.slice(1));
  if (!['추가', '삭제'].includes(sub) || !t) return '사용법: `.화이트리스트 <추가|삭제|목록> [@유저]`';
  if (sub === '추가') { if (!g.whitelist.includes(t.id)) g.whitelist.push(t.id); }
  else g.whitelist = g.whitelist.filter((i) => i !== t.id);
  save();
  return sub === '추가' ? `✅ **${t.user.tag}** 님을 자동 보안 예외로 등록했어요.` : `🗑️ **${t.user.tag}** 님을 화이트리스트에서 뺐어요.`;
};

F.accountage = async (m, args) => {
  const d = Number(args[0]);
  if (!Number.isInteger(d) || d < 0 || d > 365) return '사용법: `.계정나이 <일수>` (0이면 해제)';
  gs(m.guild.id).minAccountAgeDays = d;
  save();
  return d === 0 ? '✅ 계정 나이 제한을 해제했어요.' : `🛡️ 가입한 지 ${d}일 미만인 계정은 입장 시 자동 킥돼요.`;
};

// 경계 대상 관리
F.watch = async (m, args) => {
  const g = gs(m.guild.id);
  const sub = args[0];
  if (sub === '목록') {
    const ids = Object.keys(g.watch).filter((id) => isWatched(m.guild.id, id));
    if (!ids.length) return '👀 경계 대상이 없어요.';
    return `👀 경계 대상\n${ids.map((id) => `• <@${id}> — 남은 시간 ${fmtDuration(g.watch[id] - Date.now())}`).join('\n')}`;
  }
  if (sub === '시간') {
    const h = Number(args[1]);
    if (!Number.isInteger(h) || h < 1 || h > 720) return '사용법: `.경계 시간 <1~720>` (시간 단위, 자동 경계 유지 시간)';
    g.watchHours = h;
    save();
    return `👀 자동 경계 유지 시간을 ${h}시간으로 설정했어요.`;
  }
  const t = await resolveMember(m, args.slice(1));
  if (!['추가', '해제'].includes(sub) || !t) return '사용법: `.경계 <추가|해제|목록|시간> [@유저|시간]`';
  if (sub === '추가') {
    if (isExempt(t)) return '관리자/관리 권한이 있는 유저는 경계 대상으로 둘 수 없어요.';
    addWatch(m.guild.id, t.id);
    await log(m.guild, `👀 경계 지정 | ${t.user.tag} | by ${m.author.tag}`);
    return `👀 **${t.user.tag}** 님을 ${g.watchHours}시간 동안 경계해요. 도배/미검증 링크를 보내면 바로 차단돼요.`;
  }
  delete g.watch[t.id];
  save();
  return `✅ **${t.user.tag}** 님의 경계를 해제했어요.`;
};

// 신뢰 도메인 관리
F.trust = async (m, args) => {
  const g = gs(m.guild.id);
  const sub = args[0];
  if (sub === '목록') {
    return `✅ 이 서버가 추가한 신뢰 도메인: ${g.trustedDomains.length ? g.trustedDomains.map((d) => `\`${d}\``).join(' ') : '없음'}\n기본 신뢰 도메인 ${TRUSTED_DEFAULT.length}개(유튜브, 깃허브, 구글 등)는 항상 포함돼요.`;
  }
  const dom = (args[1] || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  if (!['추가', '삭제'].includes(sub) || !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(dom)) return '사용법: `.신뢰링크 <추가|삭제|목록> [도메인]` (예: `.신뢰링크 추가 example.com`)';
  if (sub === '추가') { if (!g.trustedDomains.includes(dom)) g.trustedDomains.push(dom); }
  else g.trustedDomains = g.trustedDomains.filter((d) => d !== dom);
  save();
  return sub === '추가' ? `✅ \`${dom}\` 을(를) 신뢰 도메인으로 추가했어요. (하위 도메인 포함)` : `🗑️ \`${dom}\` 을(를) 신뢰 목록에서 뺐어요.`;
};

// 링크 수동 검사 (누구나, 10초 쿨다운)
const scanCooldown = new Map();
F.scanlink = async (m, args) => {
  const last = scanCooldown.get(m.author.id) || 0;
  if (Date.now() - last < 10000) return '⏱️ 링크 검사는 10초에 한 번만 할 수 있어요.';
  const urls = extractUrls(args.join(' '));
  if (!urls.length) return '사용법: `.링크검사 <주소>`';
  scanCooldown.set(m.author.id, Date.now());
  await m.channel.sendTyping().catch(() => {});
  const r = await scanUrl(urls[0], gs(m.guild.id).trustedDomains);
  const verdict = r.trusted ? '✅ 신뢰 도메인' : r.malicious ? '🚨 악성 의심' : r.score >= 25 ? '⚠️ 주의' : '🟢 뚜렷한 위험 징후 없음';
  const e = new EmbedBuilder()
    .setColor(r.malicious ? 0xed4245 : r.score >= 25 ? 0xfee75c : 0x57f287)
    .setTitle(`🔎 링크 검사: ${verdict}`)
    .addFields(
      { name: '주소', value: `\`${defang(r.url)}\`` },
      ...(r.finalUrl !== r.url ? [{ name: '최종 도착지', value: `\`${defang(r.finalUrl)}\`` }] : []),
      { name: '위험 점수', value: `${r.score} / 50 (50 이상이면 악성 판단)`, inline: true },
      { name: '직접 접속 검사', value: r.visited ? '했어요' : r.trusted ? '필요 없음' : '하지 못했어요', inline: true },
      { name: '근거', value: r.reasons.length ? r.reasons.map((x) => `• ${x}`).join('\n').slice(0, 1000) : '없음' },
    )
    .setFooter({ text: '자동 검사는 100% 정확하지 않아요. "뚜렷한 위험 징후 없음"이 안전 보장은 아니에요.' });
  return { embeds: [e] };
};

// 레이드/디도스 방어 상태 초기화
F.resetraid = async (m) => {
  state.raidUntil.delete(m.guild.id);
  state.ddosFlags.delete(m.guild.id);
  state.nameLog.delete(m.guild.id);
  await log(m.guild, `✅ 레이드/디도스 방어 상태 초기화 | by ${m.author.tag}`);
  return '✅ 레이드 방어 모드와 디도스 감지 기록을 초기화했어요.';
};

/* ── 정보 ── */
F.userinfo = async (m, args) => {
  const t = (await resolveMember(m, args)) || m.member;
  const warns = (gs(m.guild.id).warns[t.id] || []).length;
  const e = new EmbedBuilder()
    .setTitle(`👤 ${t.user.tag}`)
    .setThumbnail(t.user.displayAvatarURL())
    .setColor(t.displayColor || 0x5865f2)
    .addFields(
      { name: 'ID', value: t.id, inline: true },
      { name: '경고', value: `${warns}회`, inline: true },
      { name: '메모', value: `${(gs(m.guild.id).memos[t.id] || []).length}개`, inline: true },
      { name: '경계 대상', value: isWatched(m.guild.id, t.id) ? '👀 예' : '아니요', inline: true },
      { name: '계정 생성', value: `<t:${Math.floor(t.user.createdTimestamp / 1000)}:R>`, inline: true },
      { name: '서버 입장', value: `<t:${Math.floor(t.joinedTimestamp / 1000)}:R>`, inline: true },
    );
  return { embeds: [e] };
};

F.avatar = async (m, args) => {
  const t = (await resolveMember(m, args)) || m.member;
  const e = new EmbedBuilder().setTitle(`🖼️ ${t.user.tag}`).setImage(t.user.displayAvatarURL({ size: 512 })).setColor(0x5865f2);
  return { embeds: [e] };
};

F.serverinfo = async (m) => {
  const g = m.guild;
  const e = new EmbedBuilder()
    .setTitle(`🏠 ${g.name}`)
    .setThumbnail(g.iconURL())
    .setColor(0x5865f2)
    .addFields(
      { name: '멤버', value: `${g.memberCount}명`, inline: true },
      { name: '채널', value: `${g.channels.cache.size}개`, inline: true },
      { name: '역할', value: `${g.roles.cache.size}개`, inline: true },
      { name: '주인', value: `<@${g.ownerId}>`, inline: true },
      { name: '생성일', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:R>`, inline: true },
    );
  return { embeds: [e] };
};

F.ping = async (m) => `🏓 퐁! ${Math.round(m.client.ws.ping)}ms`;

F.uptime = async () => `⏱️ 봇이 켜진 지 **${fmtDuration(Date.now() - state.startedAt)}** 됐어요.`;

/* ═════════════ 추가 기능 ═════════════ */

// 경고 하나만 삭제
F.delwarn = async (m, args) => {
  const t = await resolveMember(m, args);
  const n = Number(args[1]);
  if (!t || !Number.isInteger(n)) return '사용법: `.경고삭제 @유저 <번호>` (번호는 `.경고목록`에서 확인)';
  const list = gs(m.guild.id).warns[t.id] || [];
  if (n < 1 || n > list.length) return `그 번호의 경고가 없어요. (현재 ${list.length}개)`;
  const [removed] = list.splice(n - 1, 1);
  if (!list.length) delete gs(m.guild.id).warns[t.id];
  save();
  await log(m.guild, `🧹 경고 1개 삭제 | ${t.user.tag} | "${removed.reason}" | by ${m.author.tag}`);
  return `🧹 **${t.user.tag}** 님의 ${n}번 경고(${removed.reason})를 지웠어요. (남은 경고 ${list.length}회)`;
};

// 관리자 메모 (유저에 대해 관리자끼리 공유하는 기록)
F.memo = async (m, args) => {
  const g = gs(m.guild.id);
  const sub = args[0];
  if (!['추가', '목록', '삭제'].includes(sub)) return '사용법: `.메모 <추가|목록|삭제> @유저 [내용|번호]`';
  const t = await resolveMember(m, args.slice(1));
  if (!t) return '대상 유저를 찾을 수 없어요.';
  const list = g.memos[t.id] || [];
  if (sub === '목록') {
    if (!list.length) return `📝 **${t.user.tag}** 님에 대한 메모가 없어요.`;
    return `📝 **${t.user.tag}** 님의 메모 ${list.length}개\n` +
      list.slice(-15).map((x, i) => `${Math.max(0, list.length - 15) + i + 1}. ${x.text} — ${x.by} (<t:${Math.floor(x.at / 1000)}:R>)`).join('\n');
  }
  if (sub === '추가') {
    const text = args.slice(2).join(' ').trim().slice(0, 300);
    if (!text) return '사용법: `.메모 추가 @유저 <내용>`';
    if (list.length >= 50) return '메모는 유저당 최대 50개예요. 오래된 메모를 먼저 지워주세요.';
    list.push({ text, by: m.author.tag, at: Date.now() });
    g.memos[t.id] = list;
    save();
    return `📝 **${t.user.tag}** 님에게 메모를 남겼어요. (총 ${list.length}개)`;
  }
  const n = Number(args[2]);
  if (!Number.isInteger(n) || n < 1 || n > list.length) return '사용법: `.메모 삭제 @유저 <번호>` (번호는 `.메모 목록 @유저`에서 확인)';
  list.splice(n - 1, 1);
  if (!list.length) delete g.memos[t.id];
  save();
  return `🗑️ ${n}번 메모를 지웠어요.`;
};

// 최근 가입자 (레이드 의심 시 확인용)
F.recentjoins = async (m, args) => {
  const n = Math.min(Math.max(Number(args[0]) || 10, 1), 25);
  const members = [...m.guild.members.cache.values()]
    .filter((x) => x.joinedTimestamp && !x.user.bot)
    .sort((a, b) => b.joinedTimestamp - a.joinedTimestamp)
    .slice(0, n);
  if (!members.length) return '표시할 가입자가 없어요.';
  const lines = members.map((x) => {
    const ageDays = (Date.now() - x.user.createdTimestamp) / 864e5;
    const flag = ageDays < 7 ? '⚠️' : '•';
    return `${flag} ${x.user.tag} (\`${x.id}\`) — 가입 <t:${Math.floor(x.joinedTimestamp / 1000)}:R> · 계정 ${ageDays < 1 ? '하루 미만' : Math.floor(ageDays) + '일'}`;
  });
  const e = new EmbedBuilder().setColor(0x5865f2).setTitle(`🆕 최근 가입자 ${members.length}명`).setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({ text: '⚠️ = 만든 지 7일 미만인 계정 · 봇이 캐시한 멤버 기준이에요' });
  return { embeds: [e] };
};

// 이름으로 멤버 검색
F.finduser = async (m, args) => {
  const q = args.join(' ').trim();
  if (!q) return '사용법: `.유저검색 <이름 일부>`';
  const found = await m.guild.members.search({ query: q.slice(0, 32), limit: 10 }).catch(() => null);
  if (!found?.size) return `🔍 \`${q}\` 와(과) 비슷한 유저를 찾지 못했어요.`;
  return `🔍 검색 결과 ${found.size}명\n` + found.map((x) => `• ${x.user.tag}${x.nickname ? ` (${x.nickname})` : ''} — \`${x.id}\``).join('\n');
};

// 역할 정보 (위험 권한 표시)
const DANGEROUS = {
  Administrator: '관리자', ManageGuild: '서버 관리', ManageRoles: '역할 관리', ManageChannels: '채널 관리',
  BanMembers: '멤버 차단', KickMembers: '멤버 추방', ManageWebhooks: '웹훅 관리', MentionEveryone: '@everyone 멘션',
  ManageMessages: '메시지 관리', ModerateMembers: '타임아웃',
};
F.roleinfo = async (m, args) => {
  let role = m.mentions.roles.first();
  if (!role && args.length) {
    const q = args.join(' ').toLowerCase();
    role = m.guild.roles.cache.get(q.replace(/\D/g, '')) || m.guild.roles.cache.find((r) => r.name.toLowerCase() === q) ||
      m.guild.roles.cache.find((r) => r.name.toLowerCase().includes(q));
  }
  if (!role) return '사용법: `.역할정보 @역할` (이름 일부나 ID도 가능)';
  const danger = Object.entries(DANGEROUS).filter(([k]) => role.permissions.has(PermissionFlagsBits[k])).map(([, v]) => v);
  const e = new EmbedBuilder()
    .setColor(role.color || 0x5865f2)
    .setTitle(`🏷️ ${role.name}`)
    .addFields(
      { name: 'ID', value: role.id, inline: true },
      { name: '멤버', value: `${role.members.size}명`, inline: true },
      { name: '위치', value: `${role.position}번째 (높을수록 위)`, inline: true },
      { name: '색상', value: role.hexColor, inline: true },
      { name: '따로 표시', value: role.hoist ? '예' : '아니요', inline: true },
      { name: '멘션 가능', value: role.mentionable ? '예' : '아니요', inline: true },
      { name: '생성', value: `<t:${Math.floor(role.createdTimestamp / 1000)}:R>`, inline: true },
      { name: '봇/부스트 역할', value: role.managed ? '예' : '아니요', inline: true },
      { name: '⚠️ 주의할 권한', value: danger.length ? danger.map((d) => `\`${d}\``).join(' ') : '없음' },
    );
  return { embeds: [e] };
};

// 봇 정보
F.botinfo = async (m) => {
  const mem = process.memoryUsage();
  const e = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🤖 ${m.client.user.username}`)
    .setThumbnail(m.client.user.displayAvatarURL())
    .addFields(
      { name: '서버', value: `${m.client.guilds.cache.size}개`, inline: true },
      { name: '핑', value: `${Math.round(m.client.ws.ping)}ms`, inline: true },
      { name: '업타임', value: fmtDuration(Date.now() - state.startedAt), inline: true },
      { name: '명령어', value: `${require('./cmd').commands.length}개`, inline: true },
      { name: '메모리', value: `${(mem.rss / 1048576).toFixed(0)}MB`, inline: true },
      { name: '버전', value: `Node ${process.version} · discord.js ${DJS_VERSION}`, inline: true },
    );
  return { embeds: [e] };
};

// 보안 점검: 현재 서버 설정에서 허술한 부분 찾기
F.audit = async (m) => {
  const g = gs(m.guild.id);
  const guild = m.guild;
  const me = guild.members.me;
  const ok = [], warn = [], bad = [];

  // 1) 봇 권한
  const NEED = {
    BanMembers: '멤버 차단하기', KickMembers: '멤버 추방하기', ModerateMembers: '멤버 타임아웃', ManageMessages: '메시지 관리',
    ManageChannels: '채널 관리', ManageRoles: '역할 관리', ViewAuditLog: '감사 로그 보기',
  };
  const missing = Object.entries(NEED).filter(([k]) => !me.permissions.has(PermissionFlagsBits[k])).map(([, v]) => v);
  (missing.length ? bad : ok).push(missing.length ? `봇에게 없는 권한: ${missing.join(', ')}` : '봇 필수 권한이 모두 있어요');

  // 2) 봇 역할 위치
  const above = guild.roles.cache.filter((r) => !r.managed && r.id !== guild.id && r.position > me.roles.highest.position).size;
  (above ? warn : ok).push(above ? `봇 역할보다 높은 역할이 ${above}개 있어요. 그 역할 유저는 봇이 처벌할 수 없어요. (봇 역할을 위로 올리세요)` : '봇 역할이 충분히 높아요');

  // 3) @everyone 권한
  const ev = guild.roles.everyone.permissions;
  if (ev.has(PermissionFlagsBits.Administrator)) bad.push('@everyone 에 **관리자** 권한이 있어요!');
  else if (ev.has(PermissionFlagsBits.MentionEveryone)) warn.push('@everyone 이 전체 멘션(@everyone/@here)을 보낼 수 있어요');
  else ok.push('@everyone 권한이 안전해요');

  // 4) 서버 인증 수준 / 2단계 인증
  (guild.verificationLevel >= 2 ? ok : warn).push(guild.verificationLevel >= 2 ? '서버 인증 수준이 적절해요' : '서버 인증 수준이 낮아요. (설정 → 안전 설정에서 "중간" 이상 권장)');
  (guild.mfaLevel === 1 ? ok : warn).push(guild.mfaLevel === 1 ? '관리자 2단계 인증이 필수예요' : '관리자 2단계 인증이 필수가 아니에요. (계정 탈취 대비 권장)');

  // 5) 봇 보안 기능 / 로그
  const off = [['antiSpam', '스팸'], ['antiInvite', '초대링크'], ['antiScan', '링크검사'], ['antiMention', '멘션도배'], ['antiRaid', '레이드'], ['antiDdos', '디도스'], ['antiNuke', '테러'], ['antiNukeContain', '누크격리'], ['antiBotAdd', '봇추가'], ['antiRoleGrant', '권한감시'], ['antiMassPunish', '대량처벌']]
    .filter(([k]) => !g[k]).map(([, v]) => v);
  (off.length ? warn : ok).push(off.length ? `꺼져 있는 자동 보안: ${off.join(', ')}` : '자동 보안 기능이 모두 켜져 있어요');
  (g.logChannel && guild.channels.cache.has(g.logChannel) ? ok : warn).push(g.logChannel && guild.channels.cache.has(g.logChannel) ? '로그 채널이 설정돼 있어요' : '로그 채널이 없어요. `.로그채널 #채널` 로 설정하세요');
  (g.minAccountAgeDays > 0 ? ok : warn).push(g.minAccountAgeDays > 0 ? `최소 계정 나이 ${g.minAccountAgeDays}일 설정됨` : '최소 계정 나이 제한이 없어요. (`.계정나이 <일수>` 권장)');

  // 6) 관리자 권한을 가진 사람 수
  const admins = guild.roles.cache.filter((r) => r.permissions.has(PermissionFlagsBits.Administrator) && !r.managed && r.id !== guild.id)
    .reduce((n, r) => n + r.members.size, 0);
  (admins > 5 ? warn : ok).push(admins > 5 ? `관리자 권한 역할을 가진 사람이 ${admins}명으로 많아요. 꼭 필요한 사람만 두세요` : `관리자 권한 역할 보유자 ${admins}명`);

  const score = Math.max(0, 100 - bad.length * 20 - warn.length * 8);
  const e = new EmbedBuilder()
    .setColor(bad.length ? 0xed4245 : warn.length ? 0xfee75c : 0x57f287)
    .setTitle(`🩺 보안 점검 — ${score}점`)
    .setDescription('서버 설정을 훑어서 허술한 부분을 찾았어요.');
  if (bad.length) e.addFields({ name: `🚨 위험 (${bad.length})`, value: bad.map((x) => `• ${x}`).join('\n').slice(0, 1000) });
  if (warn.length) e.addFields({ name: `⚠️ 개선 권장 (${warn.length})`, value: warn.map((x) => `• ${x}`).join('\n').slice(0, 1000) });
  e.addFields({ name: `✅ 좋아요 (${ok.length})`, value: ok.map((x) => `• ${x}`).join('\n').slice(0, 1000) });
  return { embeds: [e] };
};

/* ── 봇 사용 권한 (소유자 전용) ── */
function pickUserId(m, args) {
  return m.mentions.users.first()?.id || (args[0] || '').replace(/\D/g, '') || null;
}

const AUTH_ROLE = '✅봇 권한';
async function ensureAuthRole(guild) {
  let role = guild.roles.cache.find((r) => r.name === AUTH_ROLE);
  if (!role) role = await guild.roles.create({ name: AUTH_ROLE, color: 0x57f287, reason: '봇 사용 권한을 받은 유저 표시용 역할' });
  return role;
}

F.grant = async (m, args) => {
  const id = pickUserId(m, args);
  if (!id || !/^\d{17,20}$/.test(id)) return '사용법: `.권한부여 @유저` (멘션 또는 유저 ID)';
  if (isOwner(id) || ENV_ADMINS.includes(id)) return '이미 봇을 쓸 수 있는 유저예요.';
  const already = db.botAdmins.includes(id);
  if (!already) { db.botAdmins.push(id); save(); }

  // ✅봇 권한 역할 부여 (없으면 만들어요)
  let roleMsg = '';
  const mem = await m.guild.members.fetch(id).catch(() => null);
  if (mem) {
    try {
      const role = await ensureAuthRole(m.guild);
      if (!mem.roles.cache.has(role.id)) await mem.roles.add(role, `봇 권한 부여 by ${m.author.tag}`);
      roleMsg = `\n🏷️ **${AUTH_ROLE}** 역할도 부여했어요.`;
    } catch {
      roleMsg = `\n⚠️ **${AUTH_ROLE}** 역할을 줄 수 없었어요. 봇에게 '역할 관리' 권한이 있는지, 봇 역할이 충분히 높은지 확인해주세요.`;
    }
  } else {
    roleMsg = '\nℹ️ 이 서버에 없는 유저라 역할은 주지 못했어요. (권한은 적용돼요)';
  }
  if (!already) await log(m.guild, `🔑 봇 사용 권한 부여 | <@${id}> (${id}) | by ${m.author.tag}`);
  return (already ? `이미 권한이 있는 유저예요.` : `🔑 <@${id}> 님에게 봇 사용 권한을 줬어요. 이제 소유자 전용을 뺀 모든 봇 명령어를 쓸 수 있어요.`) + roleMsg;
};

F.revoke = async (m, args) => {
  const id = pickUserId(m, args);
  if (!id) return '사용법: `.권한해제 @유저`';
  if (isOwner(id)) return '소유자의 권한은 해제할 수 없어요.';
  if (!db.botAdmins.includes(id)) return ENV_ADMINS.includes(id) ? '이 유저는 환경변수(BOT_ADMIN_IDS)로 등록돼 있어서 거기서 지워야 해요.' : '권한을 받은 유저가 아니에요.';
  db.botAdmins = db.botAdmins.filter((x) => x !== id);
  save();
  const mem = await m.guild.members.fetch(id).catch(() => null);
  const role = m.guild.roles.cache.find((r) => r.name === AUTH_ROLE);
  if (mem && role) await mem.roles.remove(role, `봇 권한 해제 by ${m.author.tag}`).catch(() => {});
  await log(m.guild, `🔒 봇 사용 권한 해제 | <@${id}> (${id}) | by ${m.author.tag}`);
  return `🔒 <@${id}> 님의 봇 사용 권한을 해제했어요. (${AUTH_ROLE} 역할도 회수)`;
};

/* ── 자동킥채널 (소유자 전용): 여기에 메시지를 보내면 1일 타임아웃 ── */
F.trapchannel = async (m, args) => {
  const g = gs(m.guild.id);
  const sub = (args[0] || '').toLowerCase();
  if (['해제', 'off', '끄기'].includes(sub)) {
    g.trapChannel = null;
    save();
    return '✅ 자동킥채널을 해제했어요.';
  }
  if (['상태', 'status'].includes(sub) || (!args.length && !m.mentions.channels.size)) {
    return g.trapChannel ? `🪤 자동킥채널: <#${g.trapChannel}>` : '🪤 자동킥채널이 설정돼 있지 않아요. `.자동킥채널 #채널`';
  }
  const ch = m.mentions.channels.first() || m.guild.channels.cache.get((args[0] || '').replace(/\D/g, ''));
  if (!ch || !ch.isTextBased() || ch.isThread()) return '사용법: `.자동킥채널 #채널` (해제: `.자동킥채널 해제`)';
  g.trapChannel = ch.id;
  save();
  const sent = await ch.send('🚫 **여기에 메세지 절대로 보내지 마세요.**\n보내면 **1일 타임아웃**돼요. (소유자와 인증된 유저 제외)').catch(() => null);
  if (sent) await sent.pin().catch(() => {});
  await log(m.guild, `🪤 자동킥채널 설정 | #${ch.name} | by ${m.author.tag}`);
  return sent ? `🪤 ${ch} 을(를) 자동킥채널로 설정하고 경고 문구를 보냈어요.` : `🪤 ${ch} 을(를) 자동킥채널로 설정했어요. 하지만 그 채널에 메시지를 보낼 수 없어서 경고 문구는 못 보냈어요. 봇 권한을 확인해주세요.`;
};

// 자동킥채널에 메시지가 오면 처리. 처리했으면 true
async function trapCheck(message) {
  const g = gs(message.guild.id);
  if (!g.trapChannel || message.channel.id !== g.trapChannel) return false;
  if (isOwner(message.author.id) || isAuthed(message.author.id, message.guild)) return false;   // 소유자/인증된 유저/방장은 통과
  await message.delete().catch(() => {});
  let result = '메시지만 삭제';
  if (message.member?.moderatable) {
    const ok = await message.member.timeout(864e5, '[자동킥채널] 금지된 채널에 메시지 전송').then(() => true).catch(() => false);
    if (ok) result = '1일 타임아웃';
  }
  await log(message.guild, `🪤 자동킥채널 | ${message.author.tag} (${message.author.id}) | ${result}`);
  return true;
}

F.grantlist = async () => {
  const all = [...new Set([...ENV_ADMINS, ...db.botAdmins])].filter((x) => x !== OWNER_ID);
  return `👑 소유자: <@${OWNER_ID}>\n🔑 권한 받은 유저 ${all.length}명${all.length ? '\n' + all.map((i) => `• <@${i}> (\`${i}\`)${db.botAdmins.includes(i) ? '' : ' — 환경변수'}`).join('\n') : ''}`;
};

/* ── 저장 상태 / 백업 (소유자 전용) ── */
F.storage = async () => {
  const i = storeInfo;
  const e = new EmbedBuilder()
    .setColor(i.errors && !i.lastSavedAt ? 0xed4245 : 0x57f287)
    .setTitle('💾 저장 상태')
    .addFields(
      { name: '저장 방식', value: i.mode === 'turso' ? '☁️ Turso (libSQL)' : (i.mode === 'mongodb' ? '🗄️ MongoDB' : '📄 파일 (data.json)'), inline: true },
      { name: '저장 주기', value: '1초마다 (바뀐 게 있을 때)', inline: true },
      { name: '데이터 크기', value: `${(i.bytes / 1024).toFixed(1)}KB`, inline: true },
      { name: '마지막 저장', value: i.lastSavedAt ? `<t:${Math.floor(i.lastSavedAt / 1000)}:R>` : '아직 없음', inline: true },
      { name: '저장 횟수', value: `${i.saves}회`, inline: true },
      { name: '오류', value: `${i.errors}회${i.lastError ? `\n\`${i.lastError}\`` : ''}`, inline: true },
    );
  return { embeds: [e] };
};

// 전체 데이터를 JSON 파일로 DM 전송 (채널에 올라가지 않게 DM 으로만)
F.backup = async (m) => {
  const buf = Buffer.from(JSON.stringify(db, null, 2));
  await m.author.send({ content: '🗂️ 봇 전체 데이터 백업이에요. 타인에게 공유하지 마세요.', files: [{ attachment: buf, name: `security-backup-${new Date().toISOString().slice(0, 10)}.json` }] })
    .catch(() => { throw new Error('DM 을 보낼 수 없어요. 서버 멤버의 DM 허용을 켜주세요.'); });
  return '🗂️ 백업 파일을 DM 으로 보냈어요.';
};

/* ── 환영 메시지 / 자동 역할 ── */
function fillWelcome(tpl, member) {
  return tpl.replaceAll('{user}', `<@${member.id}>`).replaceAll('{name}', member.user.username)
    .replaceAll('{server}', member.guild.name).replaceAll('{count}', String(member.guild.memberCount));
}

F.welcome = async (m, args) => {
  const g = gs(m.guild.id);
  const sub = args[0];
  if (['해제', 'off'].includes(sub)) { g.welcomeChannel = null; save(); return '✅ 환영 메시지를 껐어요.'; }
  if (sub === '메시지') {
    const text = args.slice(1).join(' ').trim().slice(0, 500);
    if (!text) return '사용법: `.환영 메시지 <내용>`\n쓸 수 있는 값: `{user}`(멘션) `{name}`(이름) `{server}`(서버 이름) `{count}`(멤버 수)';
    g.welcomeMessage = text;
    save();
    return `✅ 환영 문구를 바꿨어요.\n미리보기: ${fillWelcome(text, m.member)}`;
  }
  if (sub === '테스트') {
    if (!g.welcomeChannel) return '환영 채널이 설정돼 있지 않아요. `.환영 #채널`';
    return `미리보기: ${fillWelcome(g.welcomeMessage, m.member)}`;
  }
  const ch = m.mentions.channels.first();
  if (!ch) {
    return `👋 환영 채널: ${g.welcomeChannel ? `<#${g.welcomeChannel}>` : '꺼짐'}\n문구: ${g.welcomeMessage}\n\n\`.환영 #채널\` · \`.환영 메시지 <내용>\` · \`.환영 테스트\` · \`.환영 해제\``;
  }
  g.welcomeChannel = ch.id;
  save();
  return `👋 새 멤버가 들어오면 ${ch} 에 환영 메시지를 보내요.`;
};

F.autorole = async (m, args) => {
  const g = gs(m.guild.id);
  if (['해제', 'off'].includes(args[0])) { g.autoRole = null; save(); return '✅ 자동 역할을 껐어요.'; }
  const role = m.mentions.roles.first();
  if (!role) return `🏷️ 자동 역할: ${g.autoRole ? `<@&${g.autoRole}>` : '꺼짐'}\n사용법: \`.자동역할 @역할\` · \`.자동역할 해제\``;
  const bad = checkRole(m, role);
  if (bad) return bad;
  g.autoRole = role.id;
  save();
  return `🏷️ 새 멤버가 들어오면 **${role.name}** 역할을 자동으로 줘요.`;
};

// 입장 시 환영 + 자동 역할 (main.js 에서 호출)
async function onMemberJoined(member) {
  const g = gs(member.guild.id);
  if (g.autoRole) await member.roles.add(g.autoRole, '자동 역할').catch(() => {});
  if (db.botAdmins.includes(member.id)) {
    const role = member.guild.roles.cache.find((r) => r.name === AUTH_ROLE);
    if (role) await member.roles.add(role, '봇 권한 유저 재입장').catch(() => {});
  }
  if (g.welcomeChannel) {
    const ch = member.guild.channels.cache.get(g.welcomeChannel);
    if (ch?.isTextBased()) await ch.send({ content: fillWelcome(g.welcomeMessage, member), allowedMentions: { users: [member.id] } }).catch(() => {});
  }
}


module.exports = { initStore, shutdownStore, onMemberJoined, trapCheck, F, gs, save, log, addWarn, isExempt, isBotAdmin, isOwner, isAuthed, canBackup, addGuildAuth, backupStore, blacklistStore, extraStore, OWNER_ID, isWatched, addWatch, parseDuration, fmtDuration, state, DEFAULTS };

