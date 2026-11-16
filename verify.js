// verify.js - 인증 시스템 (버튼 → DM 보안코드 이미지 → DM으로 코드 입력 → 인증 역할 부여)
// 캡차 이미지는 외부 패키지 없이 직접 PNG 로 그려요. (굵은 글자 + 글자를 가로지르는 선 1줄)
const zlib = require('zlib');
const crypto = require('crypto');
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder,
} = require('discord.js');
const { gs, save, log } = require('./server');

/* ───────────── 캡차 이미지 ───────────── */
const GLYPHS = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  // 소문자 (x높이는 5줄, b d f h i j t 는 위로, j y 는 아래로 내려와요)
  a: ['.....', '.....', '.###.', '....#', '.####', '#...#', '.####'],
  b: ['#....', '#....', '####.', '#...#', '#...#', '#...#', '####.'],
  d: ['....#', '....#', '.####', '#...#', '#...#', '#...#', '.####'],
  e: ['.....', '.....', '.###.', '#...#', '#####', '#....', '.###.'],
  f: ['..###', '.#...', '####.', '.#...', '.#...', '.#...', '.#...'],
  h: ['#....', '#....', '#.##.', '##..#', '#...#', '#...#', '#...#'],
  i: ['..#..', '.....', '.##..', '..#..', '..#..', '..#..', '.###.'],
  j: ['...#.', '.....', '..##.', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  m: ['.....', '.....', '##.#.', '#.#.#', '#.#.#', '#.#.#', '#.#.#'],
  n: ['.....', '.....', '#.##.', '##..#', '#...#', '#...#', '#...#'],
  r: ['.....', '.....', '#.##.', '##..#', '#....', '#....', '#....'],
  t: ['.#...', '.#...', '####.', '.#...', '.#...', '.#..#', '..##.'],
  y: ['.....', '.....', '#...#', '#...#', '#...#', '.####', '....#', '#...#', '.###.'],
};
// 모든 글자를 9줄로 맞춰요 (소문자 아래로 내려오는 부분용)
for (const k of Object.keys(GLYPHS)) while (GLYPHS[k].length < 9) GLYPHS[k].push('.....');
// 숫자 + 영어 대문자 + 영어 소문자 (0/O/o, 1/l/I, 5/S, 2/Z 처럼 헷갈리는 글자는 뺐어요)
const CHARSET = '2345679ABCDEFGHJKLMNPRTUVWXYabdefhijmnrty'.split('');

const CODE_LEN = 5;

const rnd = (n) => crypto.randomInt(n);
const rndRange = (a, b) => a + rnd(b - a + 1);

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeCaptcha() {
  const code = Array.from({ length: CODE_LEN }, () => CHARSET[rnd(CHARSET.length)]).join('');
  const W = 300, H = 110, S = 8, GAP = 11, GW = 5 * S, GH = 9 * S;
  const px = Buffer.alloc(W * H * 3);
  const set = (x, y, c) => { if (x >= 0 && y >= 0 && x < W && y < H) { const i = (y * W + x) * 3; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; } };
  const rect = (x, y, w, h, c) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(x + i, y + j, c); };

  rect(0, 0, W, H, [236, 238, 242]);                         // 배경
  for (let i = 0; i < 260; i++) { const g = rndRange(190, 225); rect(rnd(W), rnd(H), 2, 2, [g, g, g]); }   // 점 노이즈

  // 굵은 글자 (글자마다 위아래/색이 조금씩 달라요)
  const totalW = CODE_LEN * GW + (CODE_LEN - 1) * GAP;
  let x0 = Math.floor((W - totalW) / 2);
  for (const ch of code) {
    const y0 = Math.floor((H - GH) / 2) + rndRange(-6, 6);
    const col = [rndRange(20, 80), rndRange(20, 80), rndRange(50, 120)];
    GLYPHS[ch].forEach((row, r) => {
      for (let c = 0; c < 5; c++) if (row[c] === '#') rect(x0 + c * S, y0 + r * S, S, S, col);
    });
    x0 += GW + GAP;
  }

  // 글자를 가로지르는 굵은 선 1줄 (살짝 굽은 선)
  const base = Math.floor(H / 2) + rndRange(-3, 3);
  const amp = rndRange(2, 5), freq = (Math.PI * 2) / rndRange(120, 200), phase = Math.random() * 6.28, slope = (Math.random() - 0.5) * 0.06;
  const lineCol = [rndRange(200, 235), rndRange(40, 90), rndRange(40, 90)];
  for (let x = 0; x < W; x++) {
    const y = Math.round(base + Math.sin(x * freq + phase) * amp + (x - W / 2) * slope);
    rect(x, y - 2, 1, 4, lineCol);
  }
  return { code, png: encodePng(W, H, px) };
}

/* ───────────── 인증 진행 상태 (메모리) ───────────── */
const pending = new Map();           // userId -> { guildId, code, tries, expires, createdAt }
const TTL = 5 * 60 * 1000;
const MAX_TRIES = 3;
setInterval(() => { const now = Date.now(); for (const [k, v] of pending) if (v.expires < now) pending.delete(k); }, 60 * 1000).unref();

/* ───────────── 소유자 명령어 ───────────── */
function roleProblem(m, role) {
  if (role.managed || role.id === m.guild.id) return '봇/부스트 전용 역할이거나 @everyone 은 인증 역할로 쓸 수 없어요.';
  if (role.position >= m.guild.members.me.roles.highest.position) return '봇 역할보다 높거나 같은 역할이라 제가 줄 수 없어요. 봇 역할을 위로 올려주세요.';
  return null;
}

async function postVerifyMessage(channel, g) {
  if (g.verifyMessage && g.verifyChannel) {   // 이전 인증 메시지 정리
    const oldCh = channel.guild.channels.cache.get(g.verifyChannel);
    await oldCh?.messages?.delete(g.verifyMessage).catch(() => {});
  }
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('🔐 서버 인증')
    .setDescription(
      '봇이 아닌 사람인지 확인할게요.\n\n' +
      '**1.** 아래 초록색 **인증** 버튼을 눌러요.\n' +
      '**2.** 봇이 **DM**으로 보안코드 그림을 보내줘요.\n' +
      '**3.** 그림 속 글자(숫자/대문자/소문자)를 **DM으로 그대로 입력**하면 끝!\n\n' +
      '글자는 굵은 선에 가려져 있어요. DM이 안 오면 **서버 개인정보 설정에서 DM 허용**을 켜주세요.'
    )
    .setFooter({ text: '제한시간 5분 · 3번까지 틀릴 수 있어요' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('verify:start').setLabel('인증').setEmoji('✅').setStyle(ButtonStyle.Success),
  );
  const msg = await channel.send({ embeds: [embed], components: [row] });
  g.verifyChannel = channel.id;
  g.verifyMessage = msg.id;
  save();
  return msg;
}

const verifychannel = async (m, args) => {
  const g = gs(m.guild.id);
  if (['해제', 'off'].includes(args[0])) {
    if (g.verifyChannel && g.verifyMessage) await m.guild.channels.cache.get(g.verifyChannel)?.messages?.delete(g.verifyMessage).catch(() => {});
    g.verifyChannel = null; g.verifyMessage = null; save();
    return '✅ 인증 채널을 해제했어요. (인증 메시지도 지웠어요)';
  }
  const role = m.mentions.roles.first();
  if (role) {
    const bad = roleProblem(m, role);
    if (bad) return bad;
    g.verifyRole = role.id;
    save();
  }
  const ch = m.mentions.channels.first();
  if (!ch) {
    return `🔐 인증 채널: ${g.verifyChannel ? `<#${g.verifyChannel}>` : '꺼짐'} · 인증 역할: ${g.verifyRole ? `<@&${g.verifyRole}>` : '미설정'}\n` +
      '사용법: `.인증채널 #채널 @인증역할` (역할을 이미 정했다면 `.인증채널 #채널`) · 해제: `.인증채널 해제`';
  }
  if (!g.verifyRole) return '먼저 인증 역할을 정해주세요. `.인증채널 #채널 @인증역할` 또는 `.인증역할 @역할`';
  if (!ch.isTextBased() || ch.isThread()) return '텍스트 채널을 지정해주세요.';
  await postVerifyMessage(ch, g).catch((e) => { throw new Error('그 채널에 메시지를 보낼 수 없어요. 봇 권한을 확인해주세요. (' + e.message + ')'); });
  await log(m.guild, `🔐 인증 채널 설정 | #${ch.name} | 역할 ${g.verifyRole} | by ${m.author.tag}`);
  return `🔐 ${ch} 에 인증 메시지를 올렸어요. 인증하면 <@&${g.verifyRole}> 역할이 부여돼요.`;
};

const verifyrole = async (m) => {
  const g = gs(m.guild.id);
  const role = m.mentions.roles.first();
  if (!role) return `🏷️ 인증 역할: ${g.verifyRole ? `<@&${g.verifyRole}>` : '미설정'}\n사용법: \`.인증역할 @역할\``;
  const bad = roleProblem(m, role);
  if (bad) return bad;
  g.verifyRole = role.id;
  save();
  return `🏷️ 인증에 성공하면 **${role.name}** 역할을 줘요.`;
};

/* ───────────── 버튼 클릭 → DM 코드 전송 ───────────── */
async function startVerification(i) {
  if (!i.guild) return;
  const g = gs(i.guild.id);
  const reply = (content) => i.reply({ content, flags: 64 }).catch(() => {});
  const role = g.verifyRole && i.guild.roles.cache.get(g.verifyRole);
  if (!role) return reply('❌ 인증 역할이 설정돼 있지 않아요. 관리자에게 알려주세요.');
  if (i.member.roles.cache.has(role.id)) return reply('✅ 이미 인증된 상태예요!');

  const prev = pending.get(i.user.id);
  if (prev && Date.now() - prev.createdAt < 5000) return reply('⏱️ 잠시 후에 다시 눌러주세요.');

  const { code, png } = makeCaptcha();
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('🔐 보안코드 입력')
    .setDescription(`**${i.guild.name}** 인증이에요.\n그림 속 글자 **${CODE_LEN}자**를 이 DM에 그대로 입력해주세요. (**대문자/소문자를 구분**해요)\n숫자, 영어 대문자, 영어 소문자가 섞여 있고 굵은 선 뒤에 글자가 있어요.`)
    .setImage('attachment://captcha.png')
    .setFooter({ text: '5분 안에, 3번까지 시도할 수 있어요. 코드가 안 보이면 인증 버튼을 다시 눌러 새 코드를 받으세요.' });
  try {
    await i.user.send({ embeds: [embed], files: [new AttachmentBuilder(png, { name: 'captcha.png' })] });
  } catch {
    return reply('❌ DM을 보낼 수 없어요. **서버 우클릭 → 개인정보 보호 설정 → 서버 멤버가 보내는 다이렉트 메시지 허용**을 켜고 다시 눌러주세요.');
  }
  pending.set(i.user.id, { guildId: i.guild.id, code, tries: 0, expires: Date.now() + TTL, createdAt: Date.now() });
  return reply('📩 DM으로 보안코드를 보냈어요! DM을 확인하고 그림 속 글자를 입력해주세요.');
}

/* ───────────── DM 으로 코드 입력 ───────────── */
async function handleVerifyDM(message) {
  const p = pending.get(message.author.id);
  if (!p) return false;
  if (p.expires < Date.now()) {
    pending.delete(message.author.id);
    await message.reply('⌛ 시간이 지났어요. 인증 채널에서 **인증** 버튼을 다시 눌러 새 코드를 받아주세요.').catch(() => {});
    return true;
  }
  const input = message.content.trim().replace(/\s+/g, '');   // 대소문자를 구분해요
  if (!input) return true;

  if (input === p.code) {
    pending.delete(message.author.id);
    const guild = message.client.guilds.cache.get(p.guildId);
    const g = guild && gs(guild.id);
    const member = guild && (await guild.members.fetch(message.author.id).catch(() => null));
    const role = g?.verifyRole && guild.roles.cache.get(g.verifyRole);
    if (!member || !role) {
      await message.reply('❌ 서버나 인증 역할을 찾을 수 없어요. 서버에 있는지 확인하고 관리자에게 알려주세요.').catch(() => {});
      return true;
    }
    try {
      await member.roles.add(role, '인증 완료');
    } catch {
      await message.reply('⚠️ 코드는 맞았지만 역할을 줄 수 없었어요. 관리자에게 봇 역할 위치/권한 확인을 부탁해주세요.').catch(() => {});
      await log(guild, `⚠️ 인증 역할 부여 실패 | ${member.user.tag} (${member.id}) — 봇 역할 순서/권한 확인 필요`);
      return true;
    }
    await message.reply(`✅ **인증 완료!** **${guild.name}** 에서 **${role.name}** 역할을 받았어요. 🎉`).catch(() => {});
    await log(guild, `✅ 인증 완료 | ${member.user.tag} (${member.id})`);
    return true;
  }

  p.tries++;
  if (p.tries >= MAX_TRIES) {
    pending.delete(message.author.id);
    await message.reply('❌ 3번 모두 틀렸어요. 인증 채널에서 **인증** 버튼을 다시 눌러 새 코드를 받아주세요.').catch(() => {});
  } else {
    await message.reply(`❌ 틀렸어요. 다시 입력해주세요. (남은 기회 ${MAX_TRIES - p.tries}번)`).catch(() => {});
  }
  return true;
}

module.exports = { postVerifyMessage, verifychannel, verifyrole, startVerification, handleVerifyDM, makeCaptcha };
