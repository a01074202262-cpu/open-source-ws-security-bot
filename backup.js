// backup.js - 서버 백업 / 복원 / 백업정보 (서버 방장 + 봇 소유자 전용)
//  - 백업은 봇의 저장소(MongoDB 또는 data.json)에 서버별로 저장돼요.
//  - 서버마다 최신 백업(latest) 1개 + 직전 상태(prev) 1개를 보관해요.
//      · .서버백업 을 다시 하면 기존 latest 가 prev 로 밀려나요. (망가진 상태를 백업해도 이전 백업이 남아요)
//      · .서버복원 은 지우기 전에 현재 상태를 자동으로 prev 에 저장해요. (되돌리기 가능)
const { EmbedBuilder, ChannelType, PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const { backupStore, gs, save, log } = require('./server');

const SCHEMA = 1;
const MAX_BACKUP_BYTES = 2 * 1024 * 1024;   // 백업 1개 최대 크기 (넘으면 멤버 역할 기록을 뺌) — MongoDB 문서 16MB 제한 보호
const busy = new Set();                      // 백업/복원이 진행 중인 서버
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BACKUP_TYPES = new Set([
  ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory,
  ChannelType.GuildAnnouncement, ChannelType.GuildStageVoice, ChannelType.GuildForum, ChannelType.GuildMedia,
].filter((t) => t !== undefined));

const TYPE_LABEL = {
  [ChannelType.GuildText]: '텍스트',
  [ChannelType.GuildVoice]: '음성',
  [ChannelType.GuildCategory]: '카테고리',
  [ChannelType.GuildAnnouncement]: '공지',
  [ChannelType.GuildStageVoice]: '스테이지',
  [ChannelType.GuildForum]: '포럼',
  [ChannelType.GuildMedia]: '미디어',
};

const PERM_KO = {
  CreateInstantInvite: '초대 코드 만들기', KickMembers: '멤버 추방', BanMembers: '멤버 차단', Administrator: '관리자',
  ManageChannels: '채널 관리', ManageGuild: '서버 관리', AddReactions: '반응 추가', ViewAuditLog: '감사 로그 보기',
  PrioritySpeaker: '우선 발언권', Stream: '영상', ViewChannel: '채널 보기', SendMessages: '메시지 보내기',
  SendTTSMessages: 'TTS 전송', ManageMessages: '메시지 관리', EmbedLinks: '링크 임베드', AttachFiles: '파일 첨부',
  ReadMessageHistory: '메시지 기록 보기', MentionEveryone: '전체 멘션', UseExternalEmojis: '외부 이모지',
  ViewGuildInsights: '서버 인사이트', Connect: '음성 연결', Speak: '말하기', MuteMembers: '멤버 음소거',
  DeafenMembers: '멤버 헤드셋 음소거', MoveMembers: '멤버 이동', UseVAD: '음성 감지 사용', ChangeNickname: '닉네임 변경',
  ManageNicknames: '닉네임 관리', ManageRoles: '역할 관리', ManageWebhooks: '웹훅 관리',
  ManageGuildExpressions: '표현 관리', UseApplicationCommands: '앱 명령어 사용', RequestToSpeak: '발언 요청',
  ManageEvents: '이벤트 관리', ManageThreads: '스레드 관리', CreatePublicThreads: '공개 스레드 만들기',
  CreatePrivateThreads: '비공개 스레드 만들기', UseExternalStickers: '외부 스티커', SendMessagesInThreads: '스레드에서 메시지',
  UseEmbeddedActivities: '액티비티 사용', ModerateMembers: '멤버 타임아웃', ViewCreatorMonetizationAnalytics: '수익화 분석 보기',
  UseSoundboard: '사운드보드 사용', CreateGuildExpressions: '표현 만들기', CreateEvents: '이벤트 만들기',
  UseExternalSounds: '외부 사운드', SendVoiceMessages: '음성 메시지 전송', SendPolls: '투표 만들기',
  UseExternalApps: '외부 앱 사용',
};

const permKo = (n) => PERM_KO[n] || n;
const permList = (bits) => new PermissionsBitField(BigInt(bits)).toArray();
const fmtTime = (ms) => new Date(ms).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
const hex = (n) => '#' + Number(n || 0).toString(16).padStart(6, '0');

/* ───────────────────────── 백업 만들기 ───────────────────────── */

function packOverwrites(guild, ch) {
  return [...ch.permissionOverwrites.cache.values()].map((o) => {
    const row = { id: o.id, type: o.type, allow: String(o.allow.bitfield), deny: String(o.deny.bitfield) };
    if (o.type === 1) row.name = guild.members.cache.get(o.id)?.user.tag || null;   // 1 = 멤버
    return row;
  });
}

async function buildBackup(guild, author, kind = 'manual') {
  await guild.roles.fetch();
  // 멤버 목록은 멤버별 역할 기록과 멤버 권한 덮어쓰기 이름 표시에 써요. 실패해도 나머지 백업은 진행해요.
  const members = await guild.members.fetch({ time: 60000 }).catch(() => null);
  const channels = await guild.channels.fetch();

  const roles = [...guild.roles.cache.values()].sort((a, b) => a.position - b.position).map((r) => ({
    id: r.id, name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable,
    permissions: String(r.permissions.bitfield), position: r.position, managed: r.managed, everyone: r.id === guild.id,
  }));

  const chs = [...channels.values()].filter((c) => c && BACKUP_TYPES.has(c.type)).map((c) => ({
    id: c.id, name: c.name, type: c.type, parentId: c.parentId || null, position: c.rawPosition,
    topic: c.topic ?? null, nsfw: !!c.nsfw, rateLimitPerUser: c.rateLimitPerUser || 0,
    bitrate: c.bitrate ?? null, userLimit: c.userLimit ?? null, rtcRegion: c.rtcRegion ?? null,
    videoQualityMode: c.videoQualityMode ?? null,
    defaultAutoArchiveDuration: c.defaultAutoArchiveDuration ?? null,
    availableTags: c.availableTags ? c.availableTags.map((t) => ({ name: t.name, moderated: t.moderated })) : null,
    defaultThreadRateLimitPerUser: c.defaultThreadRateLimitPerUser ?? null,
    defaultSortOrder: c.defaultSortOrder ?? null,
    defaultForumLayout: c.defaultForumLayout ?? null,
    overwrites: packOverwrites(guild, c),
  }));

  let memberRoles = null;
  if (members) {
    memberRoles = {};
    const managed = new Set(roles.filter((r) => r.managed).map((r) => r.id));
    for (const m of members.values()) {
      const ids = [...m.roles.cache.keys()].filter((id) => id !== guild.id && !managed.has(id));
      if (ids.length) memberRoles[m.id] = ids;
    }
  }

  const backup = {
    v: SCHEMA, kind, createdAt: Date.now(),
    createdBy: { id: author.id, tag: author.tag },
    guildId: guild.id, guildName: guild.name,
    guild: {
      afkChannelId: guild.afkChannelId || null, afkTimeout: guild.afkTimeout || null,
      systemChannelId: guild.systemChannelId || null, rulesChannelId: guild.rulesChannelId || null,
      publicUpdatesChannelId: guild.publicUpdatesChannelId || null,
    },
    roles, channels: chs, memberRoles,
  };
  // 너무 크면 멤버 역할 기록을 뺀다 (구조 백업은 항상 유지)
  if (Buffer.byteLength(JSON.stringify(backup)) > MAX_BACKUP_BYTES) backup.memberRoles = null;
  return backup;
}

function summarize(b) {
  const count = (t) => b.channels.filter((c) => c.type === t).length;
  const realRoles = b.roles.filter((r) => !r.everyone);
  return {
    categories: count(ChannelType.GuildCategory),
    text: count(ChannelType.GuildText),
    voice: count(ChannelType.GuildVoice),
    announce: count(ChannelType.GuildAnnouncement),
    stage: count(ChannelType.GuildStageVoice),
    forum: count(ChannelType.GuildForum) + (ChannelType.GuildMedia !== undefined ? count(ChannelType.GuildMedia) : 0),
    channels: b.channels.length,
    roles: realRoles.length,
    managedRoles: realRoles.filter((r) => r.managed).length,
    members: b.memberRoles ? Object.keys(b.memberRoles).length : null,
  };
}

async function dmTo(client, userId, payload) {
  const u = await client.users.fetch(userId);
  await u.send(payload);
}

/* ───────────────────────── .서버백업 ───────────────────────── */

async function serverBackup(m) {
  const guild = m.guild;
  if (busy.has(guild.id)) return '⏳ 이 서버는 지금 백업/복원이 진행 중이에요. 끝난 뒤 다시 시도해주세요.';
  busy.add(guild.id);
  try {
    const store = backupStore();
    const prevRec = store[guild.id];
    const backup = await buildBackup(guild, m.author, 'manual');
    store[guild.id] = { latest: backup, prev: prevRec?.latest || prevRec?.prev || null };
    save();
    const s = summarize(backup);
    await log(guild, `💾 서버 백업 | by ${m.author.tag} | 채널 ${s.channels} · 역할 ${s.roles}`);
    const e = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('💾 서버 백업 완료')
      .setDescription('백업은 봇에 저장됐어요. 자세한 내용은 `.서버백업정보`, 되돌리려면 `.서버복원` 을 쓰세요.')
      .addFields(
        { name: '채널', value: `${s.channels}개 (카테고리 ${s.categories} · 텍스트 ${s.text} · 음성 ${s.voice}${s.announce ? ` · 공지 ${s.announce}` : ''}${s.stage ? ` · 스테이지 ${s.stage}` : ''}${s.forum ? ` · 포럼 ${s.forum}` : ''})`, inline: false },
        { name: '역할', value: `${s.roles}개 (봇 전용 ${s.managedRoles}개 포함)`, inline: true },
        { name: '멤버 역할 기록', value: s.members === null ? '저장 안 됨 (멤버를 불러오지 못했거나 용량 초과)' : `${s.members}명`, inline: true },
      )
      .setFooter({ text: prevRec?.latest ? '이전 백업은 한 단계 보관돼요. (.서버복원 이전)' : '첫 백업이에요.' })
      .setTimestamp(backup.createdAt);
    return { embeds: [e] };
  } finally {
    busy.delete(guild.id);
  }
}

/* ───────────────────────── .서버백업정보 ───────────────────────── */

function buildInfoText(b) {
  const roleById = new Map(b.roles.map((r) => [r.id, r]));
  const L = [];
  const s = summarize(b);
  L.push('═══ 서버 백업 정보 ═══');
  L.push(`서버: ${b.guildName} (${b.guildId})`);
  L.push(`백업 시각: ${fmtTime(b.createdAt)}   (종류: ${b.kind === 'pre-restore' ? '복원 직전 자동 저장' : '수동 백업'})`);
  L.push(`백업한 사람: ${b.createdBy.tag} (${b.createdBy.id})`);
  L.push(`채널 ${s.channels}개 · 역할 ${s.roles}개 · 멤버 역할 기록 ${s.members === null ? '없음' : s.members + '명'}`);
  L.push('');

  const rs = b.roles.filter((r) => !r.everyone).sort((a, c) => c.position - a.position);
  const ev = b.roles.find((r) => r.everyone);
  L.push(`═══ 역할 ${rs.length}개 (위에서 아래 순서 = 높은 역할부터) ═══`);
  rs.forEach((r, i) => {
    const perms = permList(r.permissions);
    L.push(`${String(i + 1).padStart(2, ' ')}. ${r.name}${r.managed ? '  [봇 전용]' : ''}`);
    L.push(`    색 ${hex(r.color)} · 따로 표시 ${r.hoist ? 'O' : 'X'} · 멘션 가능 ${r.mentionable ? 'O' : 'X'}`);
    L.push(`    권한(${perms.length}): ${perms.length ? perms.map(permKo).join(', ') : '없음'}`);
  });
  if (ev) {
    const perms = permList(ev.permissions);
    L.push(`@everyone 권한(${perms.length}): ${perms.length ? perms.map(permKo).join(', ') : '없음'}`);
  }
  L.push('');

  const ovLines = (c, indent) => {
    const out = [];
    for (const o of c.overwrites) {
      const target = o.type === 0 ? (o.id === b.guildId ? '@everyone' : `@${roleById.get(o.id)?.name || '삭제된 역할(' + o.id + ')'}`) : `유저 ${o.name || o.id}`;
      const allow = permList(o.allow).map(permKo);
      const deny = permList(o.deny).map(permKo);
      out.push(`${indent}└ ${target} → 허용 [${allow.join(', ') || '-'}] / 거부 [${deny.join(', ') || '-'}]`);
    }
    return out;
  };
  const byPos = (a, c) => a.position - c.position;
  const cats = b.channels.filter((c) => c.type === ChannelType.GuildCategory).sort(byPos);
  const loose = b.channels.filter((c) => c.type !== ChannelType.GuildCategory && !c.parentId).sort(byPos);
  L.push(`═══ 채널 ${s.channels}개 ═══`);
  const chLine = (c, indent) => {
    const extra = [];
    if (c.topic) extra.push(`주제: ${String(c.topic).replace(/\s+/g, ' ').slice(0, 60)}`);
    if (c.nsfw) extra.push('연령 제한');
    if (c.rateLimitPerUser) extra.push(`슬로우모드 ${c.rateLimitPerUser}초`);
    if (c.userLimit) extra.push(`인원 ${c.userLimit}`);
    return `${indent}${c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement ? '#' : '🔊'} ${c.name} [${TYPE_LABEL[c.type] || c.type}]${extra.length ? '  (' + extra.join(' · ') + ')' : ''}`;
  };
  for (const c of loose) { L.push(chLine(c, '')); L.push(...ovLines(c, '    ')); }
  for (const cat of cats) {
    L.push(`📁 ${cat.name} [카테고리]`);
    L.push(...ovLines(cat, '    '));
    for (const c of b.channels.filter((x) => x.parentId === cat.id).sort(byPos)) {
      L.push(chLine(c, '  '));
      L.push(...ovLines(c, '      '));
    }
  }
  return L.join('\n');
}

async function serverBackupInfo(m, args) {
  const rec = backupStore()[m.guild.id];
  const useOld = ['이전', 'prev', 'old'].includes((args[0] || '').toLowerCase());
  const b = useOld ? rec?.prev : rec?.latest;
  if (!b) return useOld ? '보관된 이전 백업이 없어요.' : '이 서버에는 저장된 백업이 없어요. `.서버백업` 으로 먼저 만들어주세요.';

  const s = summarize(b);
  const e = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🗂️ ${b.guildName} 백업 정보${useOld ? ' (이전)' : ''}`)
    .addFields(
      { name: '백업 시각', value: `<t:${Math.floor(b.createdAt / 1000)}:F>\n(<t:${Math.floor(b.createdAt / 1000)}:R>)`, inline: true },
      { name: '백업한 사람', value: `<@${b.createdBy.id}> (${b.createdBy.tag})`, inline: true },
      { name: '종류', value: b.kind === 'pre-restore' ? '복원 직전 자동 저장' : '수동 백업', inline: true },
      { name: `채널 ${s.channels}개`, value: `카테고리 ${s.categories} · 텍스트 ${s.text} · 음성 ${s.voice} · 공지 ${s.announce} · 스테이지 ${s.stage} · 포럼/미디어 ${s.forum}` },
      { name: `역할 ${s.roles}개`, value: `봇 전용 ${s.managedRoles}개 포함 · 멤버 역할 기록 ${s.members === null ? '없음' : s.members + '명'}` },
    )
    .setFooter({ text: '역할 이름/순서/권한, 채널별 권한 덮어쓰기는 첨부된 txt 파일에 있어요.' });

  const buf = Buffer.from('\ufeff' + buildInfoText(b), 'utf8');   // BOM: 메모장에서도 한글이 안 깨지게
  const safe = b.guildName.replace(/[^\w가-힣-]+/g, '_').slice(0, 30) || 'server';
  const payload = { embeds: [e], files: [{ attachment: buf, name: `서버백업정보-${safe}.txt` }] };

  // 백업한 사람 DM 으로 보내요. 명령어를 쓴 사람이 다르면 그 사람에게도 보내요.
  const targets = [...new Set([b.createdBy.id, m.author.id])];
  const sent = [];
  for (const id of targets) {
    try { await dmTo(m.client, id, payload); sent.push(id); } catch { /* DM 차단 */ }
  }
  if (!sent.length) throw new Error('DM 을 보낼 수 없어요. DM 허용 설정을 확인해주세요.');
  return `📬 백업 정보를 ${sent.map((id) => `<@${id}>`).join(', ')} 님의 DM 으로 보냈어요.`;
}

/* ───────────────────────── .서버복원 ───────────────────────── */

const mapId = (map, id) => (id ? map.get(id) || null : null);

async function serverRestore(m, args) {
  const guild = m.guild;
  const rec = backupStore()[guild.id];
  const sub = (args[0] || '').toLowerCase();
  const useOld = ['이전', 'prev', 'old'].includes(sub);
  const b = useOld ? rec?.prev : rec?.latest;
  if (!b) return useOld ? '보관된 이전 백업이 없어요.' : '이 서버에는 저장된 백업이 없어요. `.서버백업` 으로 먼저 만들어주세요.';

  const me = guild.members.me;
  if (!me.permissions.has(PermissionFlagsBits.Administrator)) {
    return '❌ 복원하려면 봇에게 **관리자** 권한이 필요해요. (역할/채널 권한을 그대로 되살리려면 봇이 그 권한을 가지고 있어야 해요)';
  }
  if (busy.has(guild.id)) return '⏳ 이 서버는 지금 백업/복원이 진행 중이에요.';

  // ── 확인 ──
  const s = summarize(b);
  const warn = await m.channel.send({
    embeds: [new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('⚠️ 서버 복원 — 되돌릴 수 없는 작업이에요')
      .setDescription(
        `**${fmtTime(b.createdAt)}** 에 만든 백업${useOld ? '(이전)' : ''}으로 서버를 되돌려요.\n\n` +
        '• 지금 있는 **모든 채널과 (봇이 지울 수 있는) 역할이 삭제**되고 백업대로 다시 만들어요.\n' +
        '• 채널 안의 **메시지는 복원되지 않아요.** (구조·이름·순서·권한만 복원)\n' +
        `• 복원할 내용: 채널 ${s.channels}개 · 역할 ${s.roles}개${s.members === null ? '' : ` · 멤버 역할 ${s.members}명`}\n` +
        '• 시작 전에 **현재 상태를 자동 저장**해요. (`.서버복원 이전` 으로 되돌릴 수 있어요)\n' +
        '• 진행 상황과 결과는 **DM** 으로 알려드려요. (이 채널도 삭제되기 때문이에요)\n\n' +
        '진행하려면 **30초 안에** `확인` 이라고 입력하세요.')],
  });
  const got = await m.channel.awaitMessages({
    filter: (x) => x.author.id === m.author.id && x.content.trim() === '확인', max: 1, time: 30000,
  });
  warn.delete().catch(() => {});
  if (!got.size) return '🛑 확인이 없어서 복원을 취소했어요.';

  if (busy.has(guild.id)) return '⏳ 이 서버는 지금 백업/복원이 진행 중이에요.';
  busy.add(guild.id);
  const report = [];
  const dm = async (text) => { try { await dmTo(m.client, m.author.id, { content: text.slice(0, 1900) }); } catch { /* 무시 */ } };
  try {
    await dm(`🔄 **${guild.name}** 서버 복원을 시작해요. 현재 상태를 먼저 저장하고 있어요…`);

    // 0) 현재 상태 자동 저장 (되돌리기용). 저장소를 직접 갱신: latest 는 그대로, prev 만 교체
    const snapshot = await buildBackup(guild, m.author, 'pre-restore');
    const store = backupStore();
    const curRec = store[guild.id];
    // 복원 대상이 prev 였다면 snapshot 이 prev 자리를 차지하므로, 복원하는 백업을 latest 로 올려 보존
    if (useOld) store[guild.id] = { latest: b, prev: snapshot };
    else store[guild.id] = { latest: curRec.latest, prev: snapshot };
    save();

    await guild.roles.fetch();
    const members = await guild.members.fetch({ time: 60000 }).catch(() => null);
    const botTop = me.roles.highest.position;

    // 1) 채널 전부 삭제
    let delCh = 0; let failCh = 0;
    const chans = await guild.channels.fetch();
    for (const ch of chans.values()) {
      if (!ch) continue;
      try { await ch.delete('[서버복원] 백업으로 복원 중'); delCh++; } catch { failCh++; }
    }
    // 2) 역할 삭제 (@everyone, 봇 전용, 봇보다 높은/같은 역할은 못 지워요)
    let delRole = 0; let failRole = 0;
    for (const r of [...guild.roles.cache.values()]) {
      if (r.id === guild.id || r.managed) continue;
      if (r.position >= botTop) { failRole++; continue; }
      try { await r.delete('[서버복원] 백업으로 복원 중'); delRole++; } catch { failRole++; }
    }
    await dm(`🧹 정리 완료 (채널 ${delCh}개, 역할 ${delRole}개 삭제${failCh || failRole ? ` · 못 지운 것: 채널 ${failCh}, 역할 ${failRole}` : ''}). 이제 백업대로 다시 만들어요…`);

    // 3) 역할 생성 — 남아 있는(봇 전용/봇보다 높은) 역할은 이름이 같으면 그걸로 대응시켜요
    const roleMap = new Map([[guild.id, guild.id]]);
    const keepByName = new Map();
    for (const r of guild.roles.cache.values()) if (r.id !== guild.id && !keepByName.has(r.name)) keepByName.set(r.name, r);
    const created = [];
    let roleFail = 0;
    for (const r of b.roles.filter((x) => !x.everyone).sort((a, c) => a.position - c.position)) {
      const kept = keepByName.get(r.name);
      if (kept && (r.managed || kept.position >= botTop)) { roleMap.set(r.id, kept.id); continue; }
      if (r.managed) continue;   // 이미 없는 봇 전용 역할은 만들 수 없어요
      try {
        const nr = await guild.roles.create({
          name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable,
          permissions: BigInt(r.permissions), reason: '[서버복원]',
        });
        roleMap.set(r.id, nr.id);
        created.push({ nr, pos: r.position });
      } catch (err) { roleFail++; report.push(`역할 "${r.name}" 생성 실패: ${err.message}`); }
    }
    const ev = b.roles.find((x) => x.everyone);
    if (ev) await guild.roles.everyone.setPermissions(BigInt(ev.permissions), '[서버복원]').catch(() => report.push('@everyone 권한 복원 실패'));
    if (created.length) {
      try {
        await guild.roles.setPositions(created.map((c, i) => ({ role: c.nr.id, position: Math.min(i + 1, Math.max(1, botTop - 1)) })));
      } catch (err) { report.push(`역할 순서 정리 실패: ${err.message}`); }
    }

    // 4) 채널 생성 (카테고리 → 나머지, 각각 원래 순서대로)
    const memberIds = members ? new Set(members.keys()) : null;
    const remapOverwrites = (list) => list
      .map((o) => {
        if (o.type === 0) { const nid = roleMap.get(o.id); return nid ? { id: nid, type: 0, allow: BigInt(o.allow), deny: BigInt(o.deny) } : null; }
        if (memberIds && !memberIds.has(o.id)) return null;   // 서버를 나간 유저
        return { id: o.id, type: 1, allow: BigInt(o.allow), deny: BigInt(o.deny) };
      })
      .filter(Boolean);

    const chanMap = new Map();
    const keptCh = new Map();   // 못 지운 채널(커뮤니티 규칙 채널 등)은 이름+종류가 같으면 대응
    for (const c of guild.channels.cache.values()) keptCh.set(`${c.type}:${c.name}`, c);
    const byPos = (a, c) => a.position - c.position;
    const catsB = b.channels.filter((c) => c.type === ChannelType.GuildCategory).sort(byPos);
    const restB = b.channels.filter((c) => c.type !== ChannelType.GuildCategory).sort(byPos);
    const textLike = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
    const voiceLike = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);
    let chOk = 0; let chFail = 0; let overwriteLost = 0;

    const makeChannel = async (c) => {
      const kept = keptCh.get(`${c.type}:${c.name}`);
      if (kept) { chanMap.set(c.id, kept.id); return; }
      const base = { name: c.name, type: c.type, parent: mapId(chanMap, c.parentId) || undefined, reason: '[서버복원]' };
      if (textLike.has(c.type) || c.type === ChannelType.GuildForum || c.type === ChannelType.GuildMedia) {
        if (c.topic) base.topic = c.topic;
        base.nsfw = c.nsfw;
        if (c.rateLimitPerUser) base.rateLimitPerUser = c.rateLimitPerUser;
        if (c.defaultAutoArchiveDuration) base.defaultAutoArchiveDuration = c.defaultAutoArchiveDuration;
      }
      if (c.type === ChannelType.GuildForum || c.type === ChannelType.GuildMedia) {
        if (c.availableTags?.length) base.availableTags = c.availableTags;
        if (c.defaultThreadRateLimitPerUser) base.defaultThreadRateLimitPerUser = c.defaultThreadRateLimitPerUser;
        if (c.defaultSortOrder !== null) base.defaultSortOrder = c.defaultSortOrder;
        if (c.defaultForumLayout !== null && c.type === ChannelType.GuildForum) base.defaultForumLayout = c.defaultForumLayout;
      }
      if (voiceLike.has(c.type)) {
        if (c.bitrate) base.bitrate = Math.max(8000, Math.min(c.bitrate, guild.maximumBitrate));
        if (c.type === ChannelType.GuildVoice) {
          if (c.userLimit) base.userLimit = c.userLimit;
          if (c.videoQualityMode) base.videoQualityMode = c.videoQualityMode;
        }
        if (c.rtcRegion) base.rtcRegion = c.rtcRegion;
      }
      const ows = remapOverwrites(c.overwrites);
      const attempts = [
        { ...base, permissionOverwrites: ows },
        { ...base },                                                     // 권한 덮어쓰기 없이
        ...(c.type === ChannelType.GuildAnnouncement ? [{ name: c.name, type: ChannelType.GuildText, parent: base.parent, topic: base.topic, reason: '[서버복원]' }] : []),
      ];
      let lastErr;
      for (let i = 0; i < attempts.length; i++) {
        try {
          const nc = await guild.channels.create(attempts[i]);
          chanMap.set(c.id, nc.id);
          chOk++;
          if (i === 1) { overwriteLost++; report.push(`#${c.name}: 권한 덮어쓰기를 복원하지 못했어요.`); }
          if (i === 2) report.push(`#${c.name}: 공지 채널을 만들 수 없어 텍스트 채널로 만들었어요.`);
          return;
        } catch (err) { lastErr = err; }
      }
      chFail++;
      report.push(`채널 "${c.name}" [${TYPE_LABEL[c.type] || c.type}] 생성 실패: ${lastErr?.message}`);
    };
    for (const c of catsB) await makeChannel(c);
    for (const c of restB) await makeChannel(c);

    // 5) 서버 설정(AFK/시스템/규칙/업데이트 채널) 되살리기
    const gi = b.guild || {};
    await guild.edit({
      afkChannel: mapId(chanMap, gi.afkChannelId), afkTimeout: gi.afkTimeout || undefined,
      systemChannel: mapId(chanMap, gi.systemChannelId), reason: '[서버복원]',
    }).catch(() => report.push('AFK/시스템 채널 설정을 복원하지 못했어요.'));
    if (gi.rulesChannelId && chanMap.get(gi.rulesChannelId) && guild.rulesChannelId !== chanMap.get(gi.rulesChannelId)) {
      await guild.setRulesChannel(chanMap.get(gi.rulesChannelId)).catch(() => {});
    }
    if (gi.publicUpdatesChannelId && chanMap.get(gi.publicUpdatesChannelId) && guild.publicUpdatesChannelId !== chanMap.get(gi.publicUpdatesChannelId)) {
      await guild.setPublicUpdatesChannel(chanMap.get(gi.publicUpdatesChannelId)).catch(() => {});
    }

    // 6) 봇 설정에 저장돼 있던 채널/역할 ID 를 새 ID 로 바꿔요 (로그 채널, 환영 채널, 인증 등)
    const g = gs(guild.id);
    for (const k of ['logChannel', 'welcomeChannel', 'trapChannel', 'verifyChannel']) g[k] = mapId(chanMap, g[k]);
    for (const k of ['autoRole', 'verifyRole']) g[k] = mapId(roleMap, g[k]);
    g.lockdown = (g.lockdown || []).map((id) => chanMap.get(id)).filter(Boolean);
    const verifyWasOn = !!g.verifyMessage;
    g.verifyMessage = null;   // 인증 버튼 메시지는 채널과 함께 사라졌어요
    save();

    await dm(
      `🏗️ 구조 복원 완료!\n• 채널 ${chOk}개 생성${chFail ? ` (실패 ${chFail})` : ''}\n• 역할 ${created.length}개 생성${roleFail ? ` (실패 ${roleFail})` : ''}` +
      (b.memberRoles ? `\n• 멤버 역할 ${Object.keys(b.memberRoles).length}명 분을 되돌리는 중이에요… (인원이 많으면 오래 걸려요)` : ''));

    // 7) 멤버 역할 되돌리기
    let mrOk = 0; let mrSkip = 0;
    if (b.memberRoles && members) {
      for (const [uid, oldIds] of Object.entries(b.memberRoles)) {
        const mem = members.get(uid);
        if (!mem) { mrSkip++; continue; }
        const ids = oldIds.map((id) => roleMap.get(id)).filter((id) => id && id !== guild.id && !mem.roles.cache.has(id));
        if (!ids.length) continue;
        try { await mem.roles.add(ids, '[서버복원] 멤버 역할 복원'); mrOk++; } catch { mrSkip++; }
      }
    }

    // 8) 결과 보고 (DM + 새로 만든 첫 텍스트 채널)
    const lines = [
      `✅ **${guild.name}** 서버 복원이 끝났어요!`,
      `• 채널 ${chOk}개, 역할 ${created.length}개 생성${b.memberRoles ? `, 멤버 ${mrOk}명 역할 복원${mrSkip ? ` (건너뜀 ${mrSkip})` : ''}` : ''}`,
      `• 복원 전 상태는 자동 저장됐어요 → 되돌리려면 \`.서버복원 이전\``,
    ];
    if (failCh || failRole) lines.push(`• 못 지운 항목: 채널 ${failCh}, 역할 ${failRole} (봇 역할보다 높거나 커뮤니티 필수 채널)`);
    if (verifyWasOn) lines.push('• 인증 버튼 메시지는 사라졌어요. `.인증채널` 로 다시 올려주세요.');
    if (report.length) lines.push('', '⚠️ 참고', ...report.slice(0, 12).map((x) => `• ${x}`), report.length > 12 ? `…외 ${report.length - 12}건` : '');
    const text = lines.filter((x) => x !== undefined).join('\n');
    await dm(text);
    const firstText = guild.channels.cache.filter((c) => c.type === ChannelType.GuildText).sort((a, c) => a.rawPosition - c.rawPosition).first();
    if (firstText) await firstText.send({ content: text.slice(0, 1900), allowedMentions: { parse: [] } }).catch(() => {});
    await log(guild, `🔄 서버 복원 완료 | by ${m.author.tag} | 채널 ${chOk} · 역할 ${created.length}`);
  } catch (err) {
    console.error('[서버복원 오류]', err);
    await dm(`❌ 복원 중 오류가 났어요: ${err.message}\n일부만 복원됐을 수 있어요. 복원 직전 상태는 \`.서버복원 이전\` 으로 되돌릴 수 있어요.`);
  } finally {
    busy.delete(guild.id);
  }
  // 채널이 모두 새로 만들어졌기 때문에 원래 채널로는 답장하지 않아요 (DM 으로 안내함)
  return null;
}

const isBusy = (guildId) => busy.has(guildId);

module.exports = { isBusy, serverBackup, serverRestore, serverBackupInfo, buildInfoText, summarize };
