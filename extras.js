// extras.js - .서버인원 / .서버봇 (페이지 목록) + .기본서버 (기본 채널 꾸미기)
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, PermissionFlagsBits: P, MessageFlags,
} = require('discord.js');
const { gs, save, log } = require('./server');
const V = require('./verify');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────────────────── 공용 페이지 목록 ─────────────────────────
 * ◀ ▶ 버튼 / 🔍 검색(입력창) / 🆔 이 페이지 ID 전체 / 메뉴에서 고르면 ID 만 따로 보내줘요.
 * ID 는 코드 블록으로 보내서 PC 는 복사 버튼, 모바일은 길게 눌러 복사할 수 있어요. (명령어 쓴 사람만 조작 가능)
 */
async function runPager(message, o) {
  let page = 0;
  let query = o.query || '';

  const view = () => {
    const items = o.getItems(query);
    const pages = Math.max(1, Math.ceil(items.length / o.perPage));
    page = Math.min(Math.max(page, 0), pages - 1);
    const slice = items.slice(page * o.perPage, (page + 1) * o.perPage);

    const embed = new EmbedBuilder()
      .setColor(o.color)
      .setTitle(o.title)
      .setDescription(slice.length ? slice.map(o.render).join('\n\n').slice(0, 4000) : '조건에 맞는 항목이 없어요.')
      .setFooter({ text: `페이지 ${page + 1} / ${pages} · 총 ${items.length}${query ? ` · 검색: ${query}` : ''}` });

    const rows = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pg:first').setEmoji('⏮️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId('pg:prev').setEmoji('◀️').setStyle(ButtonStyle.Primary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId('pg:next').setEmoji('▶️').setStyle(ButtonStyle.Primary).setDisabled(page >= pages - 1),
        new ButtonBuilder().setCustomId('pg:last').setEmoji('⏭️').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pg:search').setLabel('검색').setEmoji('🔍').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('pg:clear').setLabel('검색 해제').setStyle(ButtonStyle.Secondary).setDisabled(!query),
        new ButtonBuilder().setCustomId('pg:ids').setLabel('이 페이지 ID').setEmoji('🆔').setStyle(ButtonStyle.Secondary).setDisabled(!slice.length),
        new ButtonBuilder().setCustomId('pg:close').setEmoji('✖️').setStyle(ButtonStyle.Danger),
      ),
    ];
    if (slice.length) {
      rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('pg:copy')
          .setPlaceholder('📋 ID 복사할 사람 고르기')
          .addOptions(slice.map((it) => o.option(it))),
      ));
    }
    return { slice, payload: { embeds: [embed], components: rows, allowedMentions: { parse: [] } } };
  };

  const sent = await message.channel.send(view().payload);
  const collector = sent.createMessageComponentCollector({
    filter: (i) => i.user.id === message.author.id, idle: 2 * 60 * 1000, time: 10 * 60 * 1000,
  });

  collector.on('collect', async (i) => {
    try {
      const id = i.customId;
      if (id === 'pg:close') { collector.stop('close'); await i.update({ components: [] }); return; }
      if (id === 'pg:search') {
        const modalId = `pg:q:${i.id}`;
        await i.showModal(new ModalBuilder().setCustomId(modalId).setTitle('검색').addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('q').setLabel('이름 / 닉네임 / ID 일부').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(60),
          )));
        const sub = await i.awaitModalSubmit({ time: 60000, filter: (x) => x.customId === modalId && x.user.id === i.user.id }).catch(() => null);
        if (!sub) return;
        query = sub.fields.getTextInputValue('q').trim();
        page = 0;
        await sub.update(view().payload);
        return;
      }
      if (id === 'pg:clear') { query = ''; page = 0; await i.update(view().payload); return; }
      if (id === 'pg:ids') {
        const text = view().slice.map(o.idLine).join('\n');
        await i.reply({ content: '```\n' + text.slice(0, 1900) + '\n```', flags: MessageFlags.Ephemeral });
        return;
      }
      if (i.isStringSelectMenu()) {
        await i.reply({ content: '```\n' + i.values[0] + '\n```', flags: MessageFlags.Ephemeral });
        return;
      }
      if (id === 'pg:first') page = 0;
      else if (id === 'pg:prev') page -= 1;
      else if (id === 'pg:next') page += 1;
      else if (id === 'pg:last') page = 1e9;
      await i.update(view().payload);
    } catch (err) {
      console.error('[페이지 목록 오류]', err.message);
    }
  });
  collector.on('end', (_c, reason) => {
    if (reason !== 'close') sent.edit({ components: [] }).catch(() => {});
  });
}

/* ───────────────────────── 멤버/봇 공통 ───────────────────────── */
async function loadMembers(guild) {
  await guild.members.fetch({ time: 60000 }).catch(() => null);
  const all = [...guild.members.cache.values()]
    .sort((a, b) => (a.joinedTimestamp || 0) - (b.joinedTimestamp || 0))
    .map((m, i) => ({ m, no: i + 1 }));   // 서버 입장 순번 (검색해도 번호는 그대로)
  return all;
}

function memberText({ m, no }, extra = '') {
  const roles = [...m.roles.cache.values()].filter((r) => r.id !== m.guild.id).sort((a, b) => b.position - a.position);
  const roleText = roles.length
    ? roles.slice(0, 8).map((r) => `<@&${r.id}>`).join(' ') + (roles.length > 8 ? ` 외 ${roles.length - 8}개` : '')
    : '없음';
  const ts = m.joinedTimestamp ? Math.floor(m.joinedTimestamp / 1000) : null;
  return (
    `**#${no}** ${m.user.bot ? '🤖 ' : ''}<@${m.id}> · ${m.user.username}${m.nickname ? ` (${m.nickname})` : ''}\n` +
    `📅 입장: ${ts ? `<t:${ts}:f> (<t:${ts}:R>)` : '알 수 없음'}\n` +
    `🏷️ 역할: ${roleText}\n` +
    `🆔 \`${m.id}\`${extra}`
  );
}

const matchMember = (q) => ({ m }) => {
  if (!q) return true;
  const s = q.toLowerCase();
  return [m.user.username, m.user.globalName, m.nickname, m.displayName, m.id].some((x) => x && String(x).toLowerCase().includes(s));
};

const memberOption = ({ m, no }) => ({
  label: `#${no} ${m.displayName}`.slice(0, 100),
  description: m.id,
  value: m.id,
});
const memberIdLine = ({ m, no }) => `#${no} ${m.user.username} ${m.id}`;

/* ───────────────────────── .서버인원 ───────────────────────── */
async function memberList(m, args) {
  const guild = m.guild;
  const all = await loadMembers(guild);
  await runPager(m, {
    title: `👥 ${guild.name} 인원 (${all.length}명) — 입장 순서`,
    color: 0x5865f2,
    query: args.join(' ').trim(),
    perPage: 6,
    getItems: (q) => all.filter(matchMember(q)),
    render: (it) => memberText(it),
    option: memberOption,
    idLine: memberIdLine,
  });
  return null;
}

/* ───────────────────────── .서버봇 ───────────────────────── */
const DANGER = {
  Administrator: '관리자', ManageGuild: '서버 관리', ManageRoles: '역할 관리', ManageChannels: '채널 관리',
  BanMembers: '차단', KickMembers: '추방', MentionEveryone: '전체 멘션', ManageWebhooks: '웹훅 관리',
};

async function botList(m, args) {
  const guild = m.guild;
  const bots = (await loadMembers(guild)).filter((x) => x.m.user.bot);
  const warn = (m2) => {
    const found = Object.entries(DANGER).filter(([k]) => m2.permissions.has(P[k])).map(([, v]) => v);
    if (m2.permissions.has(P.Administrator)) return '\n⚠️ **관리자 권한** — 이 봇이 뚫리면 서버 전체가 위험해요.';
    return found.length ? `\n⚠️ 위험 권한: ${found.join(', ')}` : '';
  };
  await runPager(m, {
    title: `🤖 ${guild.name} 봇 목록 (${bots.length}개)`,
    color: 0xfee75c,
    query: args.join(' ').trim(),
    perPage: 5,
    getItems: (q) => bots.filter(matchMember(q)),
    render: (it) => memberText(it, warn(it.m) + (it.m.user.flags?.has('VerifiedBot') ? '\n✅ 디스코드 인증 봇' : '')),
    option: memberOption,
    idLine: memberIdLine,
  });
  return null;
}

/* ───────────────────────── .기본서버 ─────────────────────────
 * 서버 방장 / 봇 소유자 전용. 기존 채널은 건드리지 않고 새로 추가만 해요.
 */
const VERIFIED_ROLE = '✅ 인증됨';
const setupBusy = new Set();

const RULES = [
  '**1.** 서로 존중해요. 욕설·비하·혐오 표현은 금지예요.',
  '**2.** 도배, 홍보, 초대 링크, 의심스러운 링크는 자동으로 삭제돼요.',
  '**3.** 개인정보(전화번호·주소 등)를 공유하지 마세요.',
  '**4.** 불법·유해 콘텐츠와 해킹/사칭 시도는 즉시 영구 차단돼요.',
  '**5.** 운영진의 안내에 따라주세요.',
].join('\n');

async function baseServer(m, args) {
  const guild = m.guild;
  const g = gs(guild.id);
  const me = guild.members.me;
  if (!me.permissions.has(P.ManageChannels) || !me.permissions.has(P.ManageRoles)) {
    return '❌ 봇에게 **채널 관리**와 **역할 관리** 권한이 필요해요.';
  }
  const force = args.some((a) => ['다시', '재설치', 'force'].includes(a));
  const grantAll = args.includes('기존멤버인증');
  if (g.baseSetup && !force) {
    return `이미 기본 서버를 만들었어요. (<t:${Math.floor(g.baseSetup / 1000)}:R>)\n또 만들려면 \`.기본서버 다시\` — 채널이 중복으로 생겨요.`;
  }
  if (setupBusy.has(guild.id)) return '⏳ 지금 기본 서버를 만드는 중이에요.';

  const warn = await m.channel.send({
    embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('🏗️ 기본 서버 만들기').setDescription(
      '기존 채널·역할은 그대로 두고 아래를 **새로 추가**해요.\n\n' +
      '📢 **안내**: 규칙 · 공지 · 환영 · 인증\n' +
      '💬 **채팅**: 일반-채팅 · 사진-영상 · 게임-이야기 · 봇-명령어\n' +
      '🔊 **음성**: 일반 · 게임 · 음악 · 휴식\n' +
      '🛡️ **관리**: 보안-로그 (운영진 전용)\n' +
      `🏷️ 인증 역할 **${VERIFIED_ROLE}** (이미 인증 역할이 있으면 그걸 써요)\n\n` +
      '⚠️ 채팅·음성 채널은 **인증된 사람만** 볼 수 있어요. 지금 있는 멤버는 인증 역할이 없어서 안 보여요.\n' +
      `→ 지금 멤버 전원에게 역할을 주려면 \`.기본서버 기존멤버인증\` 으로 실행하세요${grantAll ? ' (이번에 포함됨)' : ''}.\n\n` +
      '진행하려면 **30초 안에** `확인` 을 입력하세요.')],
  });
  const got = await m.channel.awaitMessages({ filter: (x) => x.author.id === m.author.id && x.content.trim() === '확인', max: 1, time: 30000 });
  warn.delete().catch(() => {});
  if (!got.size) return '🛑 확인이 없어서 취소했어요.';
  if (setupBusy.has(guild.id)) return '⏳ 지금 기본 서버를 만드는 중이에요.';
  setupBusy.add(guild.id);

  try {
    const reason = `[기본서버] by ${m.author.tag}`;
    // 인증 역할
    let role = g.verifyRole ? guild.roles.cache.get(g.verifyRole) : null;
    if (!role) role = guild.roles.cache.find((r) => r.name === VERIFIED_ROLE && !r.managed);
    if (!role) role = await guild.roles.create({ name: VERIFIED_ROLE, color: 0x57f287, reason });
    g.verifyRole = role.id;

    const everyone = guild.id;
    const botId = me.id;
    const VIEW = P.ViewChannel, READ = P.ReadMessageHistory, SEND = P.SendMessages;
    const botOw = { id: botId, type: 1, allow: [VIEW, SEND, READ, P.EmbedLinks, P.ManageMessages] };
    const OW = {
      info: [{ id: everyone, type: 0, allow: [VIEW, READ], deny: [SEND, P.AddReactions] }, botOw],
      chat: [
        { id: everyone, type: 0, deny: [VIEW] },
        { id: role.id, type: 0, allow: [VIEW, SEND, READ, P.EmbedLinks, P.AttachFiles, P.AddReactions, P.UseExternalEmojis] },
        botOw,
      ],
      voice: [
        { id: everyone, type: 0, deny: [VIEW] },
        { id: role.id, type: 0, allow: [VIEW, P.Connect, P.Speak, P.Stream, P.UseVAD] },
      ],
      staff: [{ id: everyone, type: 0, deny: [VIEW] }, { id: role.id, type: 0, deny: [VIEW] }, botOw],
    };

    const spec = [
      { cat: '📢・안내', kind: 'info', chans: [['📜・규칙', 'rules', '서버 규칙을 꼭 읽어주세요.'], ['📢・공지', 'notice', '서버 공지사항'], ['👋・환영', 'welcome', '새로 오신 분을 환영해요!'], ['🔐・인증', 'verify', '아래 버튼으로 인증하고 서버를 이용하세요.']] },
      { cat: '💬・채팅', kind: 'chat', chans: [['💬・일반-채팅', 'text', '자유롭게 대화해요.'], ['📷・사진-영상', 'text', '사진과 영상을 공유해요.'], ['🎮・게임-이야기', 'text', '게임 이야기를 나눠요.'], ['🤖・봇-명령어', 'text', '봇 명령어는 여기서!']] },
      { cat: '🔊・음성', kind: 'voice', chans: [['🔊 일반', 'voice'], ['🎮 게임', 'voice'], ['🎵 음악', 'voice'], ['💤 휴식', 'voice']] },
      { cat: '🛡️・관리', kind: 'staff', chans: [['📋・보안-로그', 'log', '봇의 보안 로그가 올라와요. (운영진 전용)']] },
    ];

    const made = {};
    for (const grp of spec) {
      const cat = await guild.channels.create({ name: grp.cat, type: ChannelType.GuildCategory, permissionOverwrites: OW[grp.kind], reason });
      for (const [name, key, topic] of grp.chans) {
        const isVoice = key === 'voice';
        made[key + (isVoice ? ':' + name : '')] = await guild.channels.create({
          name, type: isVoice ? ChannelType.GuildVoice : ChannelType.GuildText, parent: cat.id,
          topic: isVoice ? undefined : topic, permissionOverwrites: OW[grp.kind], reason,
        });
      }
    }

    // 내용 채우기
    await made.rules.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📜 서버 규칙').setDescription(RULES)] }).catch(() => {});
    await made.notice.send({ embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle('📢 공지').setDescription(`**${guild.name}** 에 오신 걸 환영해요!\n공지는 이 채널에 올라와요.`)] }).catch(() => {});
    await made.welcome.send({ content: `👋 **${guild.name}** 에 오신 걸 환영해요! 먼저 <#${made.verify.id}> 에서 인증해주세요.` }).catch(() => {});
    await V.postVerifyMessage(made.verify, g).catch(() => {});
    g.welcomeChannel = made.welcome.id;
    if (!g.logChannel) g.logChannel = made.log.id;
    g.baseSetup = Date.now();
    save();
    await log(guild, `🏗️ 기본 서버 생성 | by ${m.author.tag}`);

    let grantMsg = '';
    if (grantAll) {
      const members = await guild.members.fetch({ time: 60000 }).catch(() => null);
      let ok = 0;
      if (members) {
        for (const mem of members.values()) {
          if (mem.user.bot || mem.roles.cache.has(role.id)) continue;
          try { await mem.roles.add(role, reason); ok++; } catch { /* 권한 부족 */ }
        }
      }
      grantMsg = `\n🏷️ 기존 멤버 ${ok}명에게 ${role} 역할을 줬어요.`;
    }
    return (
      `✅ 기본 서버를 만들었어요!\n` +
      `• 인증: ${made.verify} (인증하면 ${role} 역할이 부여돼요)\n` +
      `• 환영: ${made.welcome} · 로그: ${made.log}` + grantMsg +
      (grantAll ? '' : '\n⚠️ 기존 멤버는 인증해야 채팅 채널이 보여요. 한 번에 주려면 `.기본서버 다시 기존멤버인증`')
    );
  } finally {
    setupBusy.delete(guild.id);
  }
}

module.exports = { memberList, botList, baseServer };
