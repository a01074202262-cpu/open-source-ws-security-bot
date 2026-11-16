// moderation.js - 구조화된 모더레이션 감사 로그 + 메시지 아카이브
// 저장 데이터는 서버별로 분리하고 항목 수를 제한해 저장소가 무한히 커지지 않게 합니다.
const { EmbedBuilder, AuditLogEvent, PermissionFlagsBits } = require('discord.js');
const { gs, save, log, isAuthed } = require('./server');

const MAX_MOD_LOGS = 500;
const MAX_ARCHIVE = 500;
const MAX_TEXT = 1800;
const AUDIT_LABELS = new Map([
  [AuditLogEvent.MemberBanAdd, '밴'],
  [AuditLogEvent.MemberBanRemove, '언밴'],
  [AuditLogEvent.MemberKick, '킥'],
  [AuditLogEvent.MemberPrune, '멤버 일괄 정리'],
  [AuditLogEvent.MemberUpdate, '멤버 변경/타임아웃'],
  [AuditLogEvent.MemberRoleUpdate, '멤버 역할 변경'],
  [AuditLogEvent.MessageDelete, '메시지 삭제'],
  [AuditLogEvent.MessageBulkDelete, '메시지 일괄 삭제'],
  [AuditLogEvent.ChannelCreate, '채널 생성'],
  [AuditLogEvent.ChannelDelete, '채널 삭제'],
  [AuditLogEvent.ChannelUpdate, '채널 변경'],
  [AuditLogEvent.ChannelOverwriteCreate, '채널 권한 덮어쓰기 생성'],
  [AuditLogEvent.ChannelOverwriteUpdate, '채널 권한 덮어쓰기 변경'],
  [AuditLogEvent.ChannelOverwriteDelete, '채널 권한 덮어쓰기 삭제'],
  [AuditLogEvent.RoleCreate, '역할 생성'],
  [AuditLogEvent.RoleDelete, '역할 삭제'],
  [AuditLogEvent.RoleUpdate, '역할 변경'],
  [AuditLogEvent.WebhookCreate, '웹훅 생성'],
  [AuditLogEvent.WebhookDelete, '웹훅 삭제'],
  [AuditLogEvent.WebhookUpdate, '웹훅 변경'],
  [AuditLogEvent.InviteCreate, '초대 생성'],
  [AuditLogEvent.InviteDelete, '초대 삭제'],
  [AuditLogEvent.InviteUpdate, '초대 변경'],
  [AuditLogEvent.GuildUpdate, '서버 설정 변경'],
  [AuditLogEvent.BotAdd, '봇 추가'],
]);

function pushBounded(list, item, max) {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}
function safeText(value, max = MAX_TEXT) {
  return String(value || '').replace(/\u0000/g, '').slice(0, max);
}
function addModeration(guild, data) {
  if (!guild) return;
  const g = gs(guild.id);
  if (!Array.isArray(g.moderationLogs)) g.moderationLogs = [];
  const item = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    action: safeText(data.action, 80),
    targetId: safeText(data.targetId, 32),
    targetTag: safeText(data.targetTag, 100),
    moderatorId: safeText(data.moderatorId, 32),
    moderatorTag: safeText(data.moderatorTag, 100),
    reason: safeText(data.reason, 300),
    source: safeText(data.source || '명령어', 40),
    channelId: safeText(data.channelId, 32),
    details: safeText(data.details, 300),
  };
  pushBounded(g.moderationLogs, item, MAX_MOD_LOGS);
  save();
  return item;
}
function archiveMessage(message, action, before = null) {
  if (!message?.guild) return;
  const g = gs(message.guild.id);
  if (g.archiveEnabled === false) return;
  if (!Array.isArray(g.messageArchive)) g.messageArchive = [];
  const author = message.author;
  const item = {
    id: message.id,
    at: Date.now(),
    createdAt: message.createdTimestamp || Date.now(),
    action,
    authorId: author?.id || message.authorId || '',
    authorTag: author?.tag || '알 수 없음',
    channelId: message.channelId || message.channel?.id || '',
    channelName: message.channel?.name || '',
    content: safeText(message.content, MAX_TEXT),
    before: safeText(before, MAX_TEXT),
    attachments: [...(message.attachments?.values?.() || [])].slice(0, 5).map(a => ({
      name: safeText(a.name, 100), url: safeText(a.url, 500), contentType: safeText(a.contentType, 80),
    })),
  };
  // 동일 메시지의 중복 삭제 이벤트 방지
  if (action !== '수정' && g.messageArchive.some(x => x.id === item.id && x.action === action)) return;
  pushBounded(g.messageArchive, item, MAX_ARCHIVE);
  save();
}
function attach(client) {
  client.on('messageDelete', async (message) => {
    try {
      if (message.partial) message = await message.fetch().catch(() => message);
      if (!message.guild || message.author?.bot) return;
      archiveMessage(message, '삭제');
      addModeration(message.guild, {
        action: '메시지 삭제', targetId: message.author?.id, targetTag: message.author?.tag,
        source: '이벤트', channelId: message.channelId, details: `메시지 ID ${message.id}`,
      });
    } catch (e) { console.error('[메시지 아카이브 삭제]', e.message); }
  });
  client.on('messageUpdate', async (oldMessage, newMessage) => {
    try {
      if (oldMessage.partial) oldMessage = await oldMessage.fetch().catch(() => oldMessage);
      if (newMessage.partial) newMessage = await newMessage.fetch().catch(() => newMessage);
      if (!newMessage.guild || newMessage.author?.bot) return;
      const before = oldMessage.content || '';
      const after = newMessage.content || '';
      if (before === after) return;
      archiveMessage(newMessage, '수정', before);
    } catch (e) { console.error('[메시지 아카이브 수정]', e.message); }
  });
  client.on('messageDeleteBulk', (messages, channel) => {
    for (const message of messages.values()) {
      try { archiveMessage(message, '일괄삭제'); } catch {}
    }
    if (channel?.guild) addModeration(channel.guild, {
      action: '메시지 일괄 삭제', source: '이벤트', channelId: channel.id,
      details: `${messages.size}개 메시지`,
    });
  });
  // Discord 감사 로그 이벤트: 실행자와 사유가 제공되는 범위에서 자동 수집합니다.
  client.on('guildAuditLogEntryCreate', (entry, guild) => {
    try {
      const label = AUDIT_LABELS.get(entry.action);
      if (!label) return;
      addModeration(guild, {
        action: label, targetId: entry.targetId,
        targetTag: entry.target?.tag || entry.target?.name || '',
        moderatorId: entry.executorId,
        moderatorTag: entry.executor?.tag || '',
        reason: entry.reason || '사유 미기재',
        source: '감사로그',
        details: entry.extra?.channel?.name ? `채널 #${entry.extra.channel.name}` : '',
      });
    } catch (e) { console.error('[감사로그 수집]', e.message); }
  });
}

async function moderationLogCommand(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
    return '🚫 상세 모더레이션 로그를 보려면 감사 로그 보기 또는 서버 관리 권한이 필요해요.';
  }
  const g = gs(message.guild.id);
  const q = args.join(' ').trim().toLowerCase();
  const rows = (g.moderationLogs || []).filter(x => !q ||
    [x.action, x.targetId, x.targetTag, x.moderatorId, x.moderatorTag, x.reason].join(' ').toLowerCase().includes(q));
  const page = rows.slice(-15).reverse();
  if (!page.length) return '기록이 없어요.';
  const embed = new EmbedBuilder().setColor(0x5865f2)
    .setTitle(`📋 모더레이션 로그 (${rows.length}건 중 최근 ${page.length}건)`)
    .setDescription(page.map(x =>
      `**${x.action}** · <t:${Math.floor(x.at / 1000)}:R>\n` +
      `대상: ${x.targetTag ? `${x.targetTag} ` : ''}\`${x.targetId || '미상'}\`\n` +
      `실행자: ${x.moderatorTag || '확인 불가'} ${x.moderatorId ? `(\`${x.moderatorId}\`)` : ''}\n` +
      `사유: ${x.reason || '미기재'} · 출처: ${x.source}` +
      (x.details ? `\n세부: ${x.details}` : '')
    ).join('\n\n').slice(0, 4000))
    .setFooter({ text: q ? `검색: ${q.slice(0, 50)} · 최근 500건 보관` : '최근 500건 보관 · Discord 감사 로그 권한이 있어야 일부 실행자를 확인할 수 있어요.' });
  return { embeds: [embed] };
}

async function archiveCommand(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
    return '🚫 메시지 아카이브 조회에는 메시지 관리 권한이 필요해요.';
  }
  const g = gs(message.guild.id);
  const sub = (args[0] || '').toLowerCase();
  if (['끄기', 'off', 'disable'].includes(sub)) {
    g.archiveEnabled = false; save();
    addModeration(message.guild, { action: '메시지 아카이브 중지', moderatorId: message.author.id, moderatorTag: message.author.tag, source: '명령어' });
    return '🔒 메시지 아카이브를 중지했어요. 기존 기록은 삭제되지 않아요.';
  }
  if (['켜기', 'on', 'enable'].includes(sub)) {
    g.archiveEnabled = true; save();
    addModeration(message.guild, { action: '메시지 아카이브 재개', moderatorId: message.author.id, moderatorTag: message.author.tag, source: '명령어' });
    return '🗃️ 메시지 아카이브를 다시 켰어요.';
  }
  if (['초기화', '삭제', 'clear'].includes(sub)) {
    const removed = (g.messageArchive || []).length;
    g.messageArchive = []; save();
    addModeration(message.guild, { action: '메시지 아카이브 초기화', moderatorId: message.author.id, moderatorTag: message.author.tag, source: '명령어', details: `${removed}건 삭제` });
    return `🧹 저장된 메시지 아카이브 ${removed}건을 모두 삭제했어요.`;
  }
  if (['복원', '재게시', 'restore', 'repost'].includes(sub)) {
    const originalId = String(args[1] || '').trim();
    if (!/^\d{15,22}$/.test(originalId)) return '사용법: `.메시지기록 복원 <원본 메시지 ID>`';
    const record = (g.messageArchive || []).find((item) => item.id === originalId && ['삭제', '일괄삭제'].includes(item.action));
    if (!record) return '해당 원본 ID의 삭제 아카이브를 찾지 못했어요. 수정 기록은 복원 대상이 아니에요.';
    const channel = message.guild.channels.cache.get(record.channelId) ||
      await message.guild.channels.fetch(record.channelId).catch(() => null);
    if (!channel?.isTextBased?.() || typeof channel.send !== 'function') return '원래 채널을 찾을 수 없거나 메시지를 보낼 수 없어요.';
    const body = String(record.content || '').slice(0, 1350);
    if (!body && !(record.attachments || []).length) return '저장된 메시지 본문/첨부 정보가 없어 재게시할 수 없어요.';
    const attachmentLinks = (record.attachments || []).slice(0, 3)
      .map((item) => item.url ? `\n첨부: ${item.url}` : '') .join('');
    const restoredText = `♻️ **메시지 아카이브 재게시**\n원 작성자: ${record.authorTag || record.authorId || '알 수 없음'} · 원본 시각: <t:${Math.floor((record.createdAt || record.at) / 1000)}:F>\n원본 ID: \`${record.id}\`\n\n${body}${attachmentLinks}`.slice(0, 1950);
    const sent = await channel.send({ content: restoredText, allowedMentions: { parse: [] } }).catch(() => null);
    if (!sent) return '재게시하지 못했어요. 봇의 채널 보기/메시지 보내기 권한을 확인해주세요.';
    addModeration(message.guild, {
      action: '아카이브 메시지 재게시', targetId: record.authorId, targetTag: record.authorTag,
      moderatorId: message.author.id, moderatorTag: message.author.tag, source: '명령어',
      channelId: channel.id, details: `원본 메시지 ${record.id} → 새 메시지 ${sent.id}`,
    });
    return `✅ ${channel}에 아카이브 메시지를 새 메시지로 재게시했어요. 원본 ID와 작성 시각은 유지되지 않아요.`;
  }
  const query = args.join(' ').trim().toLowerCase();
  const rows = (g.messageArchive || []).filter(x => !query ||
    [x.authorTag, x.authorId, x.channelName, x.channelId, x.content, x.before, x.action].join(' ').toLowerCase().includes(query));
  const page = rows.slice(-10).reverse();
  if (!page.length) return '🗃️ 조건에 맞는 메시지 기록이 없어요.';
  const embed = new EmbedBuilder().setColor(0xfee75c)
    .setTitle(`🗃️ 메시지 아카이브 (${rows.length}건 중 최근 ${page.length}건)`)
    .setDescription(page.map(x =>
      `**${x.action}** · <t:${Math.floor(x.at / 1000)}:R>\n` +
      `작성자: <@${x.authorId}> (\`${x.authorTag}\`) · 채널: <#${x.channelId}>\n` +
      `${x.before ? `이전: ${safeText(x.before, 450)}\n` : ''}` +
      `내용: ${safeText(x.content, 650) || '(내용 없음/캐시되지 않음)'}` +
      (x.attachments?.length ? `\n첨부: ${x.attachments.map(a => a.name || '파일').join(', ')}` : '')
    ).join('\n\n').slice(0, 4000))
    .setFooter({ text: '최근 500건 보관 · 검색은 작성자/ID/채널/내용 · 아카이브는 삭제된 메시지를 Discord에 복원하지 않아요.' });
  return { embeds: [embed] };
}

module.exports = { attach, addModeration, moderationLogCommand, archiveCommand };
