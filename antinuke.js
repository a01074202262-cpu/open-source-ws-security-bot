// antinuke.js - 통합 안티누크 점수화 / 즉시 격리 / 직렬 복구
// Discord API가 제공하지 않는 데이터(삭제된 메시지 본문, 웹훅 토큰/ID 유지 등)는 복구할 수 없습니다.
const { AuditLogEvent, PermissionFlagsBits: P, ChannelType } = require('discord.js');
const { gs, log, save, isBotAdmin } = require('./server');
const { addModeration } = require('./moderation');
const { postVerifyMessage } = require('./verify');

const WINDOW_MS = 30_000;
const AUDIT_MAX_AGE_MS = 20_000;
const CONTAIN_SCORE = 4;
const HIGH_IMPACT_ACTIONS = new Set([
  AuditLogEvent.ChannelDelete, AuditLogEvent.RoleDelete, AuditLogEvent.BotAdd,
  AuditLogEvent.WebhookCreate, AuditLogEvent.MemberBanAdd, AuditLogEvent.MemberKick,
  AuditLogEvent.MemberPrune, AuditLogEvent.RoleUpdate, AuditLogEvent.MemberRoleUpdate,
]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cases = new Map();             // guild:executor -> 최근 위험 신호
const seenEntries = new Map();       // 감사 로그 ID -> 처리 시각 (중복/메모리 정리)
const pendingDeletionEntries = new Map(); // 삭제 감사 로그를 객체 삭제 이벤트보다 먼저 캐시
const recoveryQueues = new Map();    // guild별 복구 직렬화
const trackedMemberRoles = new Map(); // guild:member -> 마지막 관측 역할 ID
const trackedRoleMembers = new Map();  // guild:role -> 마지막 관측 멤버 ID
const deletedRoleMarkers = new Map();  // 방금 삭제된 역할의 뒤늦은 멤버 업데이트가 스냅샷을 되살리지 않게 함

const DANGEROUS_PERMS = [
  P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels,
  P.BanMembers, P.KickMembers, P.ManageWebhooks, P.ManageMessages,
  P.ModerateMembers, P.ManageGuildExpressions, P.ManageEvents,
  P.MentionEveryone, P.ManageNicknames, P.ManageThreads, P.CreateInstantInvite,
].filter((x) => x !== undefined);
const DANGEROUS_MASK = DANGEROUS_PERMS.reduce((mask, flag) => mask | BigInt(flag), 0n);

const LABELS = new Map([
  [AuditLogEvent.ChannelCreate, '채널 생성'],
  [AuditLogEvent.ChannelDelete, '채널 삭제'],
  [AuditLogEvent.RoleCreate, '역할 생성'],
  [AuditLogEvent.RoleDelete, '역할 삭제'],
  [AuditLogEvent.BotAdd, '봇 추가'],
  [AuditLogEvent.WebhookCreate, '웹훅 생성'],
  [AuditLogEvent.WebhookDelete, '웹훅 삭제'],
  [AuditLogEvent.WebhookUpdate, '웹훅 변경'],
  [AuditLogEvent.MemberBanAdd, '멤버 밴'],
  [AuditLogEvent.MemberKick, '멤버 킥'],
  [AuditLogEvent.InviteDelete, '초대 삭제'],
  [AuditLogEvent.InviteCreate, '초대 생성'],
  [AuditLogEvent.MessageBulkDelete, '메시지 대량 삭제'],
  [AuditLogEvent.GuildUpdate, '서버 보안 설정 변경'],
  [AuditLogEvent.RoleUpdate, '위험 역할 권한 변경'],
  [AuditLogEvent.ChannelUpdate, '채널 권한 변경'],
  [AuditLogEvent.ChannelOverwriteCreate, '채널 권한 덮어쓰기 생성'],
  [AuditLogEvent.ChannelOverwriteUpdate, '채널 권한 덮어쓰기 변경'],
  [AuditLogEvent.ChannelOverwriteDelete, '채널 권한 덮어쓰기 삭제'],
  [AuditLogEvent.MemberPrune, '멤버 일괄 정리'],
  [AuditLogEvent.MemberRoleUpdate, '위험 역할 지급'],
]);

function toBigInt(value) {
  try { return BigInt(value ?? 0); } catch { return 0n; }
}

function hasDangerousBits(bits) {
  const n = toBigInt(bits);
  return DANGEROUS_PERMS.some((flag) => (n & BigInt(flag)) !== 0n);
}

function gainedDangerousBits(change) {
  if (!change) return false;
  const before = toBigInt(change.old);
  const after = toBigInt(change.new);
  return hasDangerousBits(after & ~before);
}

function dangerousOverwriteEscalation(change) {
  const afterRows = Array.isArray(change?.new) ? change.new : [];
  const beforeRows = Array.isArray(change?.old) ? change.old : [];
  return afterRows.some((row) => {
    const previous = beforeRows.find((item) => item.id === row.id);
    const addedAllow = toBigInt(row?.allow) & ~toBigInt(previous?.allow);
    const removedDeny = toBigInt(previous?.deny) & ~toBigInt(row?.deny);
    return hasDangerousBits(addedAllow) || hasDangerousBits(removedDeny);
  });
}

function getPruneCount(entry) {
  // discord.js 14.18의 MemberPrune extra는 count가 아닌 removed 필드를 제공합니다.
  return Math.max(0, Number(entry.extra?.removed ?? entry.extra?.count ?? entry.extra?.membersRemoved ?? 0));
}

function classify(entry, guild) {
  const a = entry.action;
  // 생성 이벤트도 점수화해 공격자가 새 객체를 만들고 곧바로 삭제하는 패턴을 식별합니다.
  if (a === AuditLogEvent.ChannelCreate) return { points: 1, reason: '채널 생성' };
  if (a === AuditLogEvent.RoleCreate) return { points: 1, reason: '역할 생성' };
  if (a === AuditLogEvent.BotAdd) return { points: 4, reason: '봇 추가' };
  if (a === AuditLogEvent.ChannelDelete) return { points: 4, reason: '채널 삭제' };
  if (a === AuditLogEvent.RoleDelete) return { points: 5, reason: '역할 삭제' };
  if (a === AuditLogEvent.WebhookCreate) return { points: 2, reason: '웹훅 생성' };
  if (a === AuditLogEvent.WebhookDelete) return { points: 1, reason: '웹훅 삭제' };
  if (a === AuditLogEvent.WebhookUpdate) return { points: 1, reason: '웹훅 변경' };
  if (a === AuditLogEvent.MemberBanAdd) return { points: 3, reason: '멤버 밴' };
  if (a === AuditLogEvent.MemberKick) return { points: 3, reason: '멤버 킥' };
  if (a === AuditLogEvent.MemberPrune) {
    const count = getPruneCount(entry);
    if (count >= 25) return { points: 5, reason: `멤버 ${count}명 일괄 정리` };
    if (count >= 10) return { points: 3, reason: `멤버 ${count}명 일괄 정리` };
    return { points: 1, reason: '멤버 일괄 정리' };
  }
  if (a === AuditLogEvent.InviteDelete) return { points: 1, reason: '초대 삭제' };
  if (a === AuditLogEvent.InviteCreate) return { points: 1, reason: '초대 생성' };
  if (a === AuditLogEvent.MessageBulkDelete) {
    const count = Number(entry.extra?.count || 0);
    if (count >= 50) return { points: 3, reason: `메시지 ${count}개 대량 삭제` };
    if (count >= 10) return { points: 2, reason: `메시지 ${count}개 대량 삭제` };
  }
  if (a === AuditLogEvent.GuildUpdate) {
    const weakened = (entry.changes || []).some((change) => {
      if (!['verification_level', 'explicit_content_filter'].includes(change.key)) return false;
      const before = Number(change.old);
      const after = Number(change.new);
      return Number.isFinite(before) && Number.isFinite(after) && after < before;
    });
    if (weakened) return { points: 3, reason: '서버 보안/인증 수준 하향' };
  }

  if (a === AuditLogEvent.RoleUpdate) {
    const change = entry.changes?.find((x) => x.key === 'permissions');
    if (gainedDangerousBits(change)) return { points: 5, reason: '역할에 위험 권한 추가' };
  }
  if (a === AuditLogEvent.ChannelUpdate) {
    const change = entry.changes?.find((x) => x.key === 'permission_overwrites');
    if (dangerousOverwriteEscalation(change)) return { points: 4, reason: '채널 권한 덮어쓰기 위험 변경' };
  }
  if (a === AuditLogEvent.ChannelOverwriteCreate) {
    const allow = entry.changes?.find((x) => x.key === 'allow');
    return hasDangerousBits(allow?.new)
      ? { points: 4, reason: '채널에 위험 권한 덮어쓰기 생성' }
      : { points: 1, reason: '채널 권한 덮어쓰기 생성' };
  }
  if (a === AuditLogEvent.ChannelOverwriteUpdate) {
    const allow = entry.changes?.find((x) => x.key === 'allow');
    const deny = entry.changes?.find((x) => x.key === 'deny');
    const newlyAllowed = gainedDangerousBits(allow);
    const removedDeny = hasDangerousBits(toBigInt(deny?.old) & ~toBigInt(deny?.new));
    if (newlyAllowed || removedDeny) return { points: 4, reason: '채널 권한 덮어쓰기에서 위험 권한 허용' };
    return { points: 1, reason: '채널 권한 덮어쓰기 변경' };
  }
  if (a === AuditLogEvent.ChannelOverwriteDelete) {
    const deny = entry.changes?.find((x) => x.key === 'deny');
    return hasDangerousBits(deny?.old)
      ? { points: 4, reason: '채널의 위험 권한 차단 덮어쓰기 삭제' }
      : { points: 1, reason: '채널 권한 덮어쓰기 삭제' };
  }
  if (a === AuditLogEvent.MemberRoleUpdate) {
    const added = entry.changes?.find((x) => x.key === '$add')?.new;
    if (Array.isArray(added)) {
      const elevated = added.some((item) => {
        const role = guild.roles.cache.get(item.id);
        return role && !role.managed && role.id !== guild.id && hasDangerousBits(role.permissions.bitfield);
      });
      if (elevated) return { points: 4, reason: '위험 권한 역할 지급' };
    }
  }
  return null;
}

function isTrusted(guild, userId) {
  if (!userId) return false;
  const g = gs(guild.id);
  return userId === guild.client.user?.id || userId === guild.ownerId || isBotAdmin(userId) ||
    (g.whitelist || []).includes(userId) || (g.authUsers || []).includes(userId);
}

function captureDeletedArtifact(entry) {
  const target = entry.target || {};
  const changes = entry.changes || [];
  const oldValue = (key) => changes.find((item) => item.key === key)?.old;
  const channelId = target.channelId || target.channel?.id || entry.extra?.channel?.id ||
    oldValue('channel_id') || changes.find((item) => item.key === 'channel_id')?.new || null;
  if (entry.action === AuditLogEvent.WebhookDelete) {
    return {
      channelId,
      name: String(target.name || oldValue('name') || 'Recovered webhook').slice(0, 80),
    };
  }
  if (entry.action === AuditLogEvent.InviteDelete) {
    const createdAt = target.createdTimestamp || target.createdAt?.getTime?.() || Date.now();
    const originalMaxAge = Math.max(0, Number(target.maxAge) || 0);
    const remainingSeconds = originalMaxAge > 0
      ? Math.ceil((createdAt + originalMaxAge * 1000 - Date.now()) / 1000)
      : 0;
    const expiresIn = originalMaxAge > 0 ? Math.max(60, remainingSeconds) : 0;
    const originalMaxUses = Math.max(0, Number(target.maxUses) || 0);
    const uses = Math.max(0, Number(target.uses) || 0);
    if ((originalMaxAge > 0 && remainingSeconds <= 0) || (originalMaxUses > 0 && uses >= originalMaxUses)) return null;
    return {
      channelId,
      maxAge: expiresIn,
      maxUses: originalMaxUses > 0 ? Math.max(1, originalMaxUses - uses) : 0,
      temporary: Boolean(target.temporary),
    };
  }
  return null;
}

function trackMember(member, previousMember = null) {
  if (!member?.guild || !member?.id) return;
  const guildId = member.guild.id;
  const memberKey = `${guildId}:${member.id}`;
  const oldRoles = trackedMemberRoles.get(memberKey) || new Set(previousMember?.roles?.cache?.keys?.() || []);
  const currentRoles = new Set(member.roles?.cache?.keys?.() || []);

  for (const roleId of oldRoles) {
    if (currentRoles.has(roleId)) continue;
    // 역할이 이미 길드 캐시에서 사라졌다면 삭제 이벤트 처리를 기다리며 마지막 멤버 목록을 보존합니다.
    if (!member.guild.roles.cache.has(roleId)) {
      const key = `${guildId}:${roleId}`;
      if (!deletedRoleMarkers.has(key)) {
        if (!trackedRoleMembers.has(key)) trackedRoleMembers.set(key, new Set());
        trackedRoleMembers.get(key).add(member.id);
      }
      continue;
    }
    const key = `${guildId}:${roleId}`;
    const set = trackedRoleMembers.get(key);
    if (set) {
      set.delete(member.id);
      if (!set.size) trackedRoleMembers.delete(key);
    }
  }

  for (const roleId of currentRoles) {
    const key = `${guildId}:${roleId}`;
    if (!trackedRoleMembers.has(key)) trackedRoleMembers.set(key, new Set());
    trackedRoleMembers.get(key).add(member.id);
  }
  trackedMemberRoles.set(memberKey, currentRoles);
}

function untrackMember(member) {
  if (!member?.guild || !member?.id) return;
  const memberKey = `${member.guild.id}:${member.id}`;
  const roles = trackedMemberRoles.get(memberKey) || new Set(member.roles?.cache?.keys?.() || []);
  for (const roleId of roles) {
    const key = `${member.guild.id}:${roleId}`;
    const set = trackedRoleMembers.get(key);
    if (set) {
      set.delete(member.id);
      if (!set.size) trackedRoleMembers.delete(key);
    }
  }
  trackedMemberRoles.delete(memberKey);
}

function primeGuild(guild) {
  if (!guild?.members?.cache) return;
  for (const member of guild.members.cache.values()) trackMember(member);
}

function pruneCase(key, now = Date.now()) {
  const old = cases.get(key);
  if (!old) return { events: [], contained: false, banned: false, lastLogAt: 0 };
  // 이벤트 처리 중 await가 발생하더라도 같은 실행자의 사건 상태를 공유해
  // 동시 감사 로그가 서로의 점수/격리/밴 성공 상태를 덮어쓰지 않게 합니다.
  old.events = old.events.filter((x) => now - x.at <= WINDOW_MS);
  if (!old.events.length) return { events: [], contained: false, banned: false, lastLogAt: 0 };
  return old;
}

const QUARANTINE_PREFIX = '격리-';
const QUARANTINE_TOPIC_PREFIX = 'antinuke-quarantine:';
const QUARANTINE_CHAT_PERMS = {
  ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
  AttachFiles: true, EmbedLinks: true, AddReactions: true,
  SendMessagesInThreads: true,
};
const QUARANTINE_DENY_PERMS = {
  ViewChannel: false, SendMessages: false, SendMessagesInThreads: false,
  Connect: false, Speak: false,
};

function isQuarantineRole(role) {
  return Boolean(role && role.name.startsWith(QUARANTINE_PREFIX));
}

async function applyQuarantineToChannel(channel) {
  if (!channel?.guild || !channel.permissionOverwrites?.edit) return;
  const guild = channel.guild;
  const quarantineRoles = [...guild.roles.cache.values()].filter(isQuarantineRole);
  if (!quarantineRoles.length) return;
  const ownMemberId = channel.topic?.startsWith(QUARANTINE_TOPIC_PREFIX)
    ? channel.topic.slice(QUARANTINE_TOPIC_PREFIX.length).split(':')[0] : null;
  for (const role of quarantineRoles) {
    // 격리방에는 해당 격리 역할만 접근할 수 있습니다. 일반 채널에는 모든 격리 역할을 차단합니다.
    const isOwnRoom = ownMemberId && role.name === `${QUARANTINE_PREFIX}${ownMemberId}`;
    await channel.permissionOverwrites.edit(role.id, isOwnRoom ? QUARANTINE_CHAT_PERMS : QUARANTINE_DENY_PERMS,
      '[AntiNuke] 격리 사용자 채널 접근 통제').catch(() => {});
  }
  if (ownMemberId) {
    for (const adminRole of guild.roles.cache.values()) {
      if (adminRole.id === guild.id || isQuarantineRole(adminRole)) continue;
      if (adminRole.permissions.has(P.Administrator) || adminRole.permissions.has(P.ManageGuild)) {
        await channel.permissionOverwrites.edit(adminRole.id, QUARANTINE_CHAT_PERMS,
          '[AntiNuke] 관리자 격리 채팅방 접근 허용').catch(() => {});
      }
    }
    await channel.permissionOverwrites.edit(guild.ownerId, QUARANTINE_CHAT_PERMS,
      '[AntiNuke] 서버 방장 격리 채팅방 접근 허용').catch(() => {});
  }
  for (const role of quarantineRoles) {
    const memberId = role.name.slice(QUARANTINE_PREFIX.length);
    if (!/^\d{15,22}$/.test(memberId) || memberId === ownMemberId) continue;
    await channel.permissionOverwrites.edit(memberId, QUARANTINE_DENY_PERMS,
      '[AntiNuke] 다른 격리 사용자의 채널 접근 차단').catch(() => {});
  }
}

async function quarantineExecutor(guild, executorId, score, reason) {
  const member = await guild.members.fetch(executorId).catch(() => null);
  if (!member) return '실행자가 서버에 없어 격리를 적용하지 못했습니다';
  if (executorId === guild.ownerId || executorId === guild.client.user?.id || isTrusted(guild, executorId)) {
    return '방장·봇·신뢰 사용자이므로 격리하지 않았습니다';
  }
  const g = gs(guild.id);
  if (!g.quarantines || typeof g.quarantines !== 'object') g.quarantines = {};
  const roleName = `${QUARANTINE_PREFIX}${executorId}`;
  let quarantineRole = guild.roles.cache.find((r) => r.name === roleName) || null;
  if (!quarantineRole) {
    quarantineRole = await guild.roles.create({
      name: roleName,
      permissions: [],
      hoist: false,
      mentionable: false,
      color: 0x747F8D,
      reason: `[AntiNuke] ${executorId} 위험 실행자 격리 (${score}점)`,
    });
  }

  const topic = `${QUARANTINE_TOPIC_PREFIX}${executorId}:${Date.now()}`;
  let quarantineChannel = guild.channels.cache.find((c) =>
    c.topic?.startsWith(`${QUARANTINE_TOPIC_PREFIX}${executorId}:`)
  ) || null;
  if (!quarantineChannel) {
    const safeName = (member.user.username || 'user').toLowerCase().replace(/[^a-z0-9가-힣_-]/g, '').slice(0, 35) || 'user';
    const overwrites = [
      { id: guild.id, deny: [P.ViewChannel] },
      { id: quarantineRole.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks, P.AddReactions, P.SendMessagesInThreads] },
      { id: executorId, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks, P.AddReactions, P.SendMessagesInThreads] },
    ];
    if (guild.client.user?.id) overwrites.push({
      id: guild.client.user.id,
      allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageChannels, P.ManageMessages, P.ManageRoles],
    });
    overwrites.push({ id: guild.ownerId, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] });
    for (const adminRole of guild.roles.cache.values()) {
      if (adminRole.id !== guild.id && !isQuarantineRole(adminRole) && (adminRole.permissions.has(P.Administrator) || adminRole.permissions.has(P.ManageGuild))) {
        overwrites.push({ id: adminRole.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] });
      }
    }
    for (const otherRole of guild.roles.cache.values()) {
      if (isQuarantineRole(otherRole) && otherRole.id !== quarantineRole.id) {
        overwrites.push({ id: otherRole.id, deny: [P.ViewChannel, P.SendMessages] });
      }
    }
    quarantineChannel = await guild.channels.create({
      name: `격리-${safeName}-${executorId.slice(-4)}`.slice(0, 90),
      type: ChannelType.GuildText,
      topic,
      permissionOverwrites: overwrites,
      reason: `[AntiNuke] ${executorId} 전용 격리 채팅방 생성`,
    });
  }

  const previous = g.quarantines[executorId];
  const originalRoleIds = previous?.roleIds || [...member.roles.cache.values()]
    .filter((role) => role.id !== guild.id && !role.managed)
    .map((role) => role.id);
  const memberOverwriteSnapshots = previous?.memberOverwriteSnapshots || {};
  if (!previous) {
    // 격리 전에 존재하던 사용자별 채널 권한을 저장해 해제 시 원래 상태로 되돌립니다.
    for (const channel of guild.channels.cache.values()) {
      if (!channel.permissionOverwrites?.cache) continue;
      const overwrite = channel.permissionOverwrites.cache.get(executorId);
      if (!overwrite) continue;
      const snapshot = { existed: true };
      for (const [key, bit] of Object.entries({
        ViewChannel: P.ViewChannel, SendMessages: P.SendMessages,
        SendMessagesInThreads: P.SendMessagesInThreads, Connect: P.Connect, Speak: P.Speak,
      })) {
        snapshot[key] = overwrite?.allow?.has(bit) ? true : overwrite?.deny?.has(bit) ? false : null;
      }
      memberOverwriteSnapshots[channel.id] = snapshot;
    }
  }
  g.quarantines[executorId] = {
    roleId: quarantineRole.id,
    channelId: quarantineChannel.id,
    roleIds: originalRoleIds,
    memberOverwriteSnapshots,
    at: previous?.at || Date.now(),
    score,
    reason: String(reason || '').slice(0, 250),
  };
  save();

  // 모든 기존 채널에서 격리 역할과 사용자 자체를 차단합니다. 사용자 개별 허용 오버라이드도 덮어씁니다.
  let securedChannels = 0;
  let failedChannels = 0;
  for (const channel of guild.channels.cache.values()) {
    if (!channel.permissionOverwrites?.edit || channel.id === quarantineChannel.id) continue;
    let ok = true;
    await channel.permissionOverwrites.edit(quarantineRole.id, QUARANTINE_DENY_PERMS,
      '[AntiNuke] 격리 역할의 일반 채널 접근 차단').catch(() => { ok = false; });
    if (channel.permissionOverwrites.cache.has(executorId)) {
      await channel.permissionOverwrites.edit(executorId, QUARANTINE_DENY_PERMS,
        '[AntiNuke] 격리 사용자 기존 개별 채널 접근 차단').catch(() => { ok = false; });
    }
    if (ok) securedChannels++; else failedChannels++;
    await sleep(100);
  }

  // 역할을 최대한 전부 회수합니다. 관리형/봇 상위 역할은 Discord API상 회수할 수 없습니다.
  const removableRoles = [...member.roles.cache.values()].filter((role) =>
    role.id !== guild.id && role.id !== quarantineRole.id && !role.managed && role.editable
  );
  let removedRoles = 0;
  if (removableRoles.length) {
    const removed = await member.roles.remove(removableRoles,
      `[AntiNuke] 위험 실행자 격리 (${score}점: ${reason})`).then(() => true).catch(() => false);
    if (removed) removedRoles = removableRoles.length;
  }
  const refreshed = await guild.members.fetch(executorId).catch(() => member);
  const hasQuarantineRole = refreshed.roles.cache.has(quarantineRole.id);
  let roleAdded = hasQuarantineRole;
  if (!hasQuarantineRole) {
    roleAdded = await refreshed.roles.add(quarantineRole, '[AntiNuke] 격리 역할 부여')
      .then(() => true).catch(() => false);
  }
  // 타임아웃은 격리방 대화까지 막으므로 해제합니다.
  let timeoutCleared = true;
  if (refreshed.isCommunicationDisabled?.()) {
    timeoutCleared = await refreshed.timeout(null, '[AntiNuke] 격리 채팅 사용 허용')
      .then(() => true).catch(() => false);
  }

  const leftovers = [...(await guild.members.fetch(executorId).catch(() => refreshed)).roles.cache.values()]
    .filter((role) => role.id !== guild.id && role.id !== quarantineRole.id);
  const complete = roleAdded && failedChannels === 0 && leftovers.length === 0 && timeoutCleared;
  const status = complete ? '격리 완료' : '부분 격리(권한/역할 계층 확인 필요)';
  return `${status} · 격리 역할 ${roleAdded ? '부여' : '부여 실패'} · 기존 역할 ${removedRoles}개 회수 · 일반 채널 ${securedChannels}개 보호 · 보호 실패 ${failedChannels}개 · 남은 역할 ${leftovers.length}개 · 격리방 <#${quarantineChannel.id}>`;
}

async function releaseQuarantine(guild, userId, actorId) {
  const g = gs(guild.id);
  const record = g.quarantines?.[userId];
  if (!record) return { ok: false, message: '해당 사용자의 격리 기록을 찾을 수 없습니다.' };
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return { ok: false, message: '사용자가 서버에 없어 역할을 복구할 수 없습니다.' };
  const role = guild.roles.cache.get(record.roleId) || null;
  const restored = [];
  for (const roleId of record.roleIds || []) {
    const oldRole = guild.roles.cache.get(roleId);
    if (!oldRole || oldRole.managed || !oldRole.editable || member.roles.cache.has(oldRole.id)) continue;
    const ok = await member.roles.add(oldRole, '[AntiNuke] 관리자 격리 해제 및 기존 역할 복구').then(() => true).catch(() => false);
    if (ok) restored.push(oldRole.id);
  }
  if (role && member.roles.cache.has(role.id)) await member.roles.remove(role, '[AntiNuke] 격리 해제').catch(() => {});
  // 격리 전에 있던 사용자별 권한은 원래 값으로 복원하고, 격리 중 새로 만든 덮어쓰기는 제거합니다.
  for (const channel of guild.channels.cache.values()) {
    if (!channel.permissionOverwrites?.cache?.has(userId)) continue;
    if (channel.id === record.channelId) {
      await channel.permissionOverwrites.delete(userId, '[AntiNuke] 격리 해제 - 격리방 대상 접근 제거').catch(() => {});
      continue;
    }
    const snapshot = record.memberOverwriteSnapshots?.[channel.id];
    if (!snapshot) {
      await channel.permissionOverwrites.delete(userId, '[AntiNuke] 격리 해제 - 격리 중 생성된 접근 차단 제거').catch(() => {});
      continue;
    }
    if (!snapshot.existed) {
      await channel.permissionOverwrites.delete(userId, '[AntiNuke] 격리 해제 - 원래 없던 개별 오버라이드 제거').catch(() => {});
    } else {
      const { existed, ...permissions } = snapshot;
      await channel.permissionOverwrites.edit(userId, permissions,
        '[AntiNuke] 격리 해제 - 기존 개별 채널 권한 복원').catch(() => {});
    }
  }
  if (role) await role.delete('[AntiNuke] 격리 해제 - 격리 역할 정리').catch(() => {});
  delete g.quarantines[userId];
  save();
  await log(guild, `🔓 **안티누크 격리 해제** | 대상 ${userId} | 실행 관리자 ${actorId} | 기존 역할 ${restored.length}개 복구 | 격리 채팅방은 기록 보존을 위해 관리자 전용으로 유지`);
  return { ok: true, message: `격리 해제 완료 · 기존 역할 ${restored.length}개 복구 · 격리 채팅방은 관리자 기록 보존용으로 유지했습니다.` };
}

async function revokeRecentArtifacts(guild, events, executorId) {
  let webhookRemoved = 0;
  let invitesRemoved = 0;
  const webhookIds = [...new Set(events.filter((x) => x.action === AuditLogEvent.WebhookCreate && x.targetId).map((x) => x.targetId))];
  if (webhookIds.length) {
    const hooks = await guild.fetchWebhooks().catch(() => null);
    for (const id of webhookIds) {
      const hook = hooks?.get(id);
      if (hook && await hook.delete(`[AntiNuke] 위험 실행자 ${executorId}의 웹훅 회수`).then(() => true).catch(() => false)) {
        webhookRemoved++;
        await sleep(350);
      }
    }
  }
  const inviteCodes = [...new Set(events.filter((x) => x.action === AuditLogEvent.InviteCreate && x.targetId).map((x) => x.targetId))];
  if (typeof guild.invites?.delete === 'function') {
    for (const code of inviteCodes) {
      if (await guild.invites.delete(code, `[AntiNuke] 위험 실행자 ${executorId}의 초대 회수`).then(() => true).catch(() => false)) {
        invitesRemoved++;
        await sleep(350);
      }
    }
  }
  return { webhookRemoved, invitesRemoved };
}

async function restoreDeletedArtifacts(guild, events, executorId) {
  let webhookRestored = 0;
  let inviteRestored = 0;
  for (const item of events) {
    const snapshot = item.artifact;
    if (!snapshot?.channelId) continue;
    const channel = guild.channels.cache.get(snapshot.channelId) ||
      await guild.channels.fetch(snapshot.channelId).catch(() => null);
    if (!channel) continue;
    const reason = `[AntiNuke] 위험 실행자 ${executorId}의 연결 항목 삭제 복구`;
    if (item.action === AuditLogEvent.WebhookDelete && typeof channel.createWebhook === 'function') {
      const created = await retryRecovery(() => channel.createWebhook({ name: snapshot.name, reason }), '삭제된 웹훅 대체 생성 실패')
        .then(() => true).catch(() => false);
      if (created) webhookRestored++;
      await sleep(700);
    } else if (item.action === AuditLogEvent.InviteDelete && typeof channel.createInvite === 'function') {
      const options = {
        maxAge: Math.max(0, Math.min(604800, Number(snapshot.maxAge) || 0)),
        maxUses: Math.max(0, Math.min(100, Number(snapshot.maxUses) || 0)),
        temporary: Boolean(snapshot.temporary),
        unique: true,
        reason,
      };
      const created = await retryRecovery(() => channel.createInvite(options), '삭제된 초대 대체 생성 실패')
        .then(() => true).catch(() => false);
      if (created) inviteRestored++;
      await sleep(700);
    }
  }
  return { webhookRestored, inviteRestored };
}

async function scoreSignal(guild, entry, signal) {
  const executorId = entry.executorId;
  if (!executorId || isTrusted(guild, executorId)) return;
  const key = `${guild.id}:${executorId}`;
  const now = Date.now();
  const state = pruneCase(key, now);
  state.events.push({ at: now, action: entry.action, label: signal.reason, points: signal.points, targetId: entry.targetId || null, count: (entry.action === AuditLogEvent.MemberPrune ? getPruneCount(entry) : Number(entry.extra?.count)) || 1, artifact: captureDeletedArtifact(entry) });
  const score = state.events.reduce((sum, x) => sum + x.points, 0);
  const punishActions = new Set([AuditLogEvent.MemberBanAdd, AuditLogEvent.MemberKick, AuditLogEvent.MemberPrune]);
  const punishOnly = state.events.every((x) => punishActions.has(x.action));
  const punishCount = state.events.reduce((sum, x) => sum + (punishActions.has(x.action) ? Math.max(1, Number(x.count) || 1) : 0), 0);
  const cfg = gs(guild.id);
  // 웹훅/초대 삭제 복구는 처벌 임계값과 분리합니다. 단일 삭제도 원본 메타데이터가 있으면 대체 복구합니다.
  const deletedArtifacts = state.events.filter((item) =>
    !item.artifactRestoreAttempted && item.artifact?.channelId &&
    (item.action === AuditLogEvent.WebhookDelete || item.action === AuditLogEvent.InviteDelete)
  );
  if (cfg.antiNukeRecover && deletedArtifacts.length) {
    for (const item of deletedArtifacts) item.artifactRestoreAttempted = true;
    const recoverySnapshot = deletedArtifacts.map((item) => ({ ...item }));
    enqueueRecovery(guild, '웹훅/초대 삭제 복구', async () => {
      const result = await restoreDeletedArtifacts(guild, recoverySnapshot, executorId);
      if (result.webhookRestored || result.inviteRestored) {
        await log(guild, `♻️ **안티누크 연결 항목 복구** | 실행자 ${executorId} | 웹훅 대체 ${result.webhookRestored}개 · 초대 대체 ${result.inviteRestored}개`);
      }
      return result;
    }).catch((err) => log(guild, `❌ **안티누크 연결 항목 복구 실패** | ${err.message}`));
  }
  const massPunishOnlyMode = cfg.antiNuke === false;
  const highImpactEvents = state.events.filter((x) => (HIGH_IMPACT_ACTIONS.has(x.action) && (x.action !== AuditLogEvent.MemberPrune || Number(x.count) >= 10)) || /위험|보안\/인증 수준 하향/.test(x.label) || (x.action === AuditLogEvent.MessageBulkDelete && Number(x.count) >= 50));
  const objectCreationCount = state.events.filter((x) => x.action === AuditLogEvent.ChannelCreate || x.action === AuditLogEvent.RoleCreate).length;
  const creationBurst = objectCreationCount >= 8;
  const canRetryContain = !state.contained || ((state.containAttempts || 0) < 3 && now - (state.lastContainAt || 0) >= 5000);
  const hasLargePrune = state.events.some((x) => x.action === AuditLogEvent.MemberPrune && Number(x.count) >= 25);
  const containThreshold = massPunishOnlyMode ? (hasLargePrune ? 5 : 15) : CONTAIN_SCORE;
  const nonPunishHighImpact = highImpactEvents.some((x) => !punishActions.has(x.action));
  const punishBurstConfirmed = punishOnly && punishCount >= 5;
  const shouldContain = score >= containThreshold && canRetryContain && (nonPunishHighImpact || creationBurst || punishBurstConfirmed);
  // 안티누크는 자동 밴하지 않습니다. 위험 실행자는 격리 채팅방으로 이동하고 관리자가 판단합니다.
  // 비동기 API 호출 전에 먼저 저장해 동시 감사 로그 이벤트에서 점수가 유실되지 않게 합니다.
  cases.set(key, state);
  addModeration(guild, {
    action: `안티누크 감지: ${signal.reason}`, targetId: entry.targetId,
    moderatorId: executorId, moderatorTag: entry.executor?.tag || '',
    reason: entry.reason || '감사 로그 사유 미기재', source: '안티누크',
    details: `+${signal.points}점 · 30초 누적 ${score}점`,
  });

  let containDescription = '';
  if (shouldContain && cfg.antiNukeContain !== false) {
    state.contained = true;
    state.containAttempts = (state.containAttempts || 0) + 1;
    state.lastContainAt = now;
    // 격리(위험 역할 회수/타임아웃)를 먼저 실행하고, 밴은 복구 큐/부가 정리보다 앞서 시도합니다.
    containDescription = await quarantineExecutor(guild, executorId, score, signal.reason).catch(async (err) => {
      await log(guild, `❌ **안티누크 격리 실패** | ${executorId} | ${err.message}`);
      return `격리 실패: ${String(err.message || '알 수 없는 오류').slice(0, 180)}`;
    });
  }



  if (containDescription) {
    const artifacts = await revokeRecentArtifacts(guild, state.events, executorId).catch(() => ({ webhookRemoved: 0, invitesRemoved: 0 }));
    const artifactParts = [];
    if (artifacts.webhookRemoved || artifacts.invitesRemoved) artifactParts.push(`신규 웹훅 ${artifacts.webhookRemoved}개/초대 ${artifacts.invitesRemoved}개 회수`);
    const artifactText = artifactParts.length ? ` · ${artifactParts.join(' · ')}` : '';
    await log(guild,
      `🧯 **안티누크 즉시 격리** | <@${executorId}> (${executorId}) | ${signal.reason} | 점수 ${score}점 | ${containDescription}${artifactText}`
    );
  }

  if (now - (state.lastLogAt || 0) >= 4000 && !shouldContain) {
    state.lastLogAt = now;
    await log(guild, `⚠️ **안티누크 위험 신호** | <@${executorId}> | ${signal.reason} +${signal.points}점 · 누적 ${score}점 / 30초`);
  }
}

async function findDeletionEntry(guild, action, targetId) {
  const me = guild.members.me;
  if (!me?.permissions.has(P.ViewAuditLog)) return null;
  for (let attempt = 0; attempt < 7; attempt++) {
    const logs = await guild.fetchAuditLogs({ type: action, limit: 10 }).catch(() => null);
    const entry = logs?.entries.find((item) => item.targetId === targetId &&
      Date.now() - item.createdTimestamp <= AUDIT_MAX_AGE_MS);
    if (entry) return entry;
    if (attempt < 6) await sleep(650);
  }
  return null;
}

function enqueueRecovery(guild, label, operation) {
  const previous = recoveryQueues.get(guild.id) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    // 서버별로 복구 작업을 하나씩 실행하고 작업 사이에 간격을 둬 대량 REST 요청을 피합니다.
    await sleep(1100);
    return operation();
  });
  recoveryQueues.set(guild.id, next.catch((err) => console.error(`[안티누크 복구 큐:${guild.id}]`, err.message)));
  return next;
}

async function retryRecovery(fn, label) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastError = err;
      if (attempt < 3) {
        const retryAfterMs = Number(err?.retryAfter) || (Number(err?.rawError?.retry_after) * 1000) || 0;
        const backoffMs = Math.max(1000 * attempt, retryAfterMs); // Discord가 알려준 retry_after보다 일찍 재시도하지 않습니다.
        await sleep(backoffMs);
      }
    }
  }
  throw new Error(`${label}: ${lastError?.message || '알 수 없는 오류'}`);
}


async function rollbackRiskyMutation(guild, entry, signal) {
  const reason = `[AntiNuke] ${signal.reason} 원상복구`;
  const action = entry.action;

  if (action === AuditLogEvent.RoleUpdate) {
    const change = entry.changes?.find((x) => x.key === 'permissions');
    if (!gainedDangerousBits(change) || change?.old === undefined) return false;
    const role = guild.roles.cache.get(entry.targetId) || await guild.roles.fetch(entry.targetId).catch(() => null);
    if (!role || role.managed || !role.editable) throw new Error('위험 권한이 추가된 역할을 봇이 수정할 수 없습니다');
    await retryRecovery(() => role.setPermissions(toBigInt(change.old), reason), '역할 권한 원복 실패');
    await log(guild, `🧱 **안티누크 권한 원복** | 역할 ${role.name} | 위험 권한 추가를 이전 권한으로 되돌렸습니다.`);
    return true;
  }

  if (action === AuditLogEvent.MemberRoleUpdate) {
    const added = entry.changes?.find((x) => x.key === '$add')?.new;
    const dangerousRoles = (Array.isArray(added) ? added : []).map((item) => guild.roles.cache.get(item.id))
      .filter((role) => role && role.id !== guild.id && !role.managed && role.editable && hasDangerousBits(role.permissions.bitfield));
    if (!dangerousRoles.length) return false;
    const target = await guild.members.fetch(entry.targetId).catch(() => null);
    if (!target) throw new Error('위험 역할을 받은 멤버를 찾을 수 없습니다');
    await retryRecovery(() => target.roles.remove(dangerousRoles, reason), '위험 역할 지급 취소 실패');
    await log(guild, `🧱 **안티누크 위험 역할 회수** | 대상 <@${entry.targetId}> | ${dangerousRoles.map((role) => role.name).join(', ')} | 실행자 ${entry.executorId}`);
    return true;
  }

  if (action === AuditLogEvent.GuildUpdate) {
    const patch = {};
    for (const change of entry.changes || []) {
      if (!['verification_level', 'explicit_content_filter'].includes(change.key)) continue;
      const before = Number(change.old);
      const after = Number(change.new);
      if (!Number.isFinite(before) || !Number.isFinite(after) || after >= before) continue;
      if (change.key === 'verification_level') patch.verificationLevel = before;
      if (change.key === 'explicit_content_filter') patch.explicitContentFilter = before;
    }
    if (!Object.keys(patch).length) return false;
    await retryRecovery(() => guild.edit({ ...patch, reason }), '서버 보안 설정 원복 실패');
    await log(guild, '🧱 **안티누크 서버 보안 설정 원복** | 인증/콘텐츠 필터 수준 하향을 이전 설정으로 되돌렸습니다.');
    return true;
  }

  const overwriteActions = new Set([
    AuditLogEvent.ChannelUpdate,
    AuditLogEvent.ChannelOverwriteCreate,
    AuditLogEvent.ChannelOverwriteUpdate,
    AuditLogEvent.ChannelOverwriteDelete,
  ]);
  if (!overwriteActions.has(action)) return false;

  // ChannelOverwriteCreate/Update/Delete에서는 감사 로그 target이 채널이고,
  // extra.id가 실제 오버라이드 대상(역할 또는 멤버)입니다.
  const isOverwriteAction = action !== AuditLogEvent.ChannelUpdate;
  const channelId = isOverwriteAction
    ? entry.targetId
    : (entry.targetId || entry.extra?.channel?.id || entry.extra?.channelId);
  const channel = channelId
    ? (guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null))
    : null;
  if (!channel?.permissionOverwrites) throw new Error('권한 변경 대상 채널을 찾을 수 없습니다');

  if (action === AuditLogEvent.ChannelUpdate) {
    const change = entry.changes?.find((x) => x.key === 'permission_overwrites');
    if (!dangerousOverwriteEscalation(change) || !Array.isArray(change.old)) return false;
    await retryRecovery(() => channel.permissionOverwrites.set(change.old, reason), '채널 권한 전체 원복 실패');
    await log(guild, `🧱 **안티누크 채널 권한 원복** | #${channel.name} | 변경 전 권한 덮어쓰기로 복구했습니다.`);
    return true;
  }

  const allow = entry.changes?.find((x) => x.key === 'allow');
  const deny = entry.changes?.find((x) => x.key === 'deny');
  const targetId = entry.extra?.id || entry.extra?.target?.id || entry.changes?.find((x) => x.key === 'id')?.new;
  if (!targetId) throw new Error('감사 로그에서 권한 오버라이드 대상 ID를 찾을 수 없습니다');

  if (action === AuditLogEvent.ChannelOverwriteCreate) {
    if (!hasDangerousBits(allow?.new)) return false;
    await retryRecovery(() => channel.permissionOverwrites.delete(targetId, reason), '위험 권한 덮어쓰기 삭제 실패');
    await log(guild, `🧱 **안티누크 위험 권한 덮어쓰기 삭제** | #${channel.name} | 대상 ${targetId}`);
    return true;
  }

  if (action === AuditLogEvent.ChannelOverwriteUpdate) {
    const newlyAllowed = gainedDangerousBits(allow);
    const removedDeny = hasDangerousBits(toBigInt(deny?.old) & ~toBigInt(deny?.new));
    if (!newlyAllowed && !removedDeny) return false;
    if (allow?.old === undefined && deny?.old === undefined) throw new Error('감사 로그에 이전 권한 값이 없습니다');
    const overwrite = channel.permissionOverwrites.cache.get(targetId);
    const beforeAllow = allow?.old !== undefined ? toBigInt(allow.old) : (overwrite?.allow.bitfield ?? 0n);
    const beforeDeny = deny?.old !== undefined ? toBigInt(deny.old) : (overwrite?.deny.bitfield ?? 0n);
    const oldPermissions = { allow: beforeAllow, deny: beforeDeny };
    const update = overwrite
      ? () => overwrite.edit(oldPermissions, reason)
      : () => channel.permissionOverwrites.edit(targetId, oldPermissions, { reason });
    await retryRecovery(update, '채널 권한 덮어쓰기 원복 실패');
    await log(guild, `🧱 **안티누크 채널 권한 원복** | #${channel.name} | 대상 ${targetId}`);
    return true;
  }

  if (action === AuditLogEvent.ChannelOverwriteDelete && hasDangerousBits(deny?.old)) {
    if (allow?.old === undefined && deny?.old === undefined) throw new Error('삭제된 권한 덮어쓰기의 원본 값을 찾을 수 없습니다');
    const typeChange = entry.changes?.find((x) => x.key === 'type');
    const typeValue = Number(entry.extra?.type ?? typeChange?.old ?? typeChange?.new);
    const options = { reason };
    if (typeValue === 0 || typeValue === 1) options.type = typeValue;
    await retryRecovery(() => channel.permissionOverwrites.create(targetId, {
      allow: toBigInt(allow?.old), deny: toBigInt(deny?.old),
    }, options), '삭제된 위험 차단 덮어쓰기 복구 실패');
    await log(guild, `🧱 **안티누크 채널 차단 권한 복구** | #${channel.name} | 대상 ${targetId}`);
    return true;
  }
  return false;
}

async function restoreChannel(guild, channel, actorLabel, actorId) {
  const me = guild.members.me;
  if (!me?.permissions.has(P.ManageChannels)) throw new Error('봇에게 채널 관리 권한이 없어요');
  if (typeof channel.clone !== 'function' || channel.isThread?.()) throw new Error('이 채널 유형은 자동 복제를 지원하지 않아요');
  const restored = await retryRecovery(async () => {
    const clone = await channel.clone({ reason: `[AntiNuke] ${actorLabel}의 채널 삭제 복구` });
    if (channel.parentId && guild.channels.cache.has(channel.parentId)) {
      await clone.setParent(channel.parentId, { lockPermissions: false }).catch(() => {});
    }
    if (Number.isInteger(channel.rawPosition ?? channel.position)) {
      await clone.setPosition(channel.rawPosition ?? channel.position).catch(() => {});
    }
    // 삭제 실행자에게 개별적으로 부여된 위험 권한 덮어쓰기는 복구 채널에 되살리지 않습니다.
    const executorOverwrite = actorId ? clone.permissionOverwrites.cache.get(actorId) : null;
    if (executorOverwrite && hasDangerousBits(executorOverwrite.allow.bitfield)) {
      await clone.permissionOverwrites.delete(actorId, '[AntiNuke] 공격 실행자의 개별 위험 권한 제거').catch(() => {});
    }
    return clone;
  }, '채널 복구 실패');
  // 봇 내부 설정과 서버의 일부 기본 채널 참조를 새 채널 ID로 이어 줍니다.
  const cfg = gs(guild.id);
  const wasVerifyChannel = cfg.verifyChannel === channel.id;
  const wasTrapChannel = cfg.trapChannel === channel.id;
  const configFields = ['logChannel', 'welcomeChannel', 'verifyChannel', 'trapChannel'];
  const changed = [];
  for (const field of configFields) {
    if (cfg[field] === channel.id) { cfg[field] = restored.id; changed.push(field); }
  }
  if (Array.isArray(cfg.lockdown) && cfg.lockdown.includes(channel.id)) {
    cfg.lockdown = cfg.lockdown.map((id) => id === channel.id ? restored.id : id);
    changed.push('lockdown');
  }
  if (changed.length) save();
  if (wasVerifyChannel && restored.isTextBased() && !restored.isThread() && cfg.verifyRole) {
    await postVerifyMessage(restored, cfg).catch((err) => log(guild, `⚠️ 인증 패널 재생성 실패 | ${err.message}`));
  } else if (wasVerifyChannel) {
    cfg.verifyMessage = null;
    save();
  }
  if (wasTrapChannel && restored.isTextBased() && !restored.isThread()) {
    const notice = await restored.send('🚫 **여기에 메세지 절대로 보내지 마세요.**\n보내면 **1일 타임아웃**돼요. (소유자와 인증된 유저 제외)').catch(() => null);
    if (notice) await notice.pin().catch(() => {});
  }

  const guildPatch = {};
  if (guild.afkChannelId === channel.id) guildPatch.afkChannel = restored.id;
  if (guild.systemChannelId === channel.id) guildPatch.systemChannel = restored.id;
  if (guild.rulesChannelId === channel.id) guildPatch.rulesChannel = restored.id;
  if (guild.publicUpdatesChannelId === channel.id) guildPatch.publicUpdatesChannel = restored.id;
  let guildSettingsRestored = false;
  if (Object.keys(guildPatch).length) {
    guildSettingsRestored = await guild.edit({ ...guildPatch, reason: '[AntiNuke] 삭제된 채널 연결 설정 복구' }).then(() => true).catch(() => false);
  }
  await log(guild,
    `♻️ **안티누크 채널 복구** | #${channel.name} → #${restored.name} | 새 ID ${restored.id} | 권한 덮어쓰기 ${restored.permissionOverwrites?.cache.size ?? 0}개 | 봇 설정 ${changed.length}개 갱신${guildSettingsRestored ? ' · 서버 기본 채널 설정 복구' : ''} | 실행자 ${actorLabel}`
  );
}

async function restoreRole(guild, role, actorLabel, memberIds, actorId) {
  const me = guild.members.me;
  if (!me?.permissions.has(P.ManageRoles)) throw new Error('봇에게 역할 관리 권한이 없어요');
  if (role.id === guild.id) throw new Error('@everyone 역할은 복제할 수 없어요');
  if (role.managed) throw new Error('Discord 연동/봇이 관리하는 역할은 수동 복제할 수 없어요');
  const restored = await retryRecovery(async () => {
    const created = await guild.roles.create({
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      permissions: role.permissions.bitfield,
      mentionable: role.mentionable,
      unicodeEmoji: role.unicodeEmoji || undefined,
      reason: `[AntiNuke] ${actorLabel}의 역할 삭제 복구`,
    });
    await created.setPosition(role.position).catch(() => {});
    return created;
  }, '역할 복구 실패');

  let assigned = 0;
  let failed = 0;
  // 원래 역할 멤버가 캐시에 남아 있는 경우 새 역할 ID로 재지급합니다.
  for (const id of memberIds.slice(0, 1000)) {
    if (actorId && id === actorId) { failed++; continue; }
    if (assigned + failed >= 250) break;
    const member = await guild.members.fetch(id).catch(() => null);
    if (!member || !restored.editable) { failed++; continue; }
    const ok = await member.roles.add(restored, '[AntiNuke] 삭제된 역할 멤버십 복구').then(() => true).catch(() => false);
    if (ok) assigned++; else failed++;
    await sleep(150);
  }
  const cfg = gs(guild.id);
  const changed = [];
  if (cfg.autoRole === role.id) { cfg.autoRole = restored.id; changed.push('autoRole'); }
  if (cfg.verifyRole === role.id) { cfg.verifyRole = restored.id; changed.push('verifyRole'); }
  if (changed.length) save();
  await log(guild,
    `♻️ **안티누크 역할 복구** | ${role.name} → ${restored.name} | 새 ID ${restored.id} | 멤버 재지급 ${assigned}명${failed ? ` · 실패 ${failed}명` : ''}${memberIds.length > 250 ? ` · 나머지 ${memberIds.length - 250}명은 수동 복구 필요` : ''}${changed.length ? ` · 봇 설정 ${changed.length}개 갱신` : ''} | 실행자 ${actorLabel}`
  );
}

async function handleDeletion(guild, action, deletedObject) {
  if (!deletedObject) return;
  const roleSnapshotKey = `${guild.id}:${deletedObject.id}`;
  if (action === AuditLogEvent.RoleDelete) deletedRoleMarkers.set(roleSnapshotKey, Date.now());
  const g = gs(guild.id);
  if (!g.antiNuke) {
    if (action === AuditLogEvent.RoleDelete) trackedRoleMembers.delete(roleSnapshotKey);
    return;
  }
  const canReadAudit = Boolean(guild.members.me?.permissions.has(P.ViewAuditLog));
  if (!canReadAudit) {
    // 실행자 확인/처벌은 할 수 없지만 삭제 당시 객체가 남아 있으므로 복구는 계속 시도합니다.
    await log(guild, `⚠️ **안티누크 감사 로그 권한 누락** | ${deletedObject.name || deletedObject.id} | 실행자 식별 및 처벌은 불가능하지만 복구는 시도합니다. 봇에 감사 로그 보기 권한을 부여하세요.`);
  }
  const deletionKey = `${guild.id}:${deletedObject.id}`;
  const cachedEntry = pendingDeletionEntries.get(deletionKey) || null;
  pendingDeletionEntries.delete(deletionKey);
  const entry = cachedEntry || (canReadAudit ? await findDeletionEntry(guild, action, deletedObject.id) : null);
  const actorId = entry?.executorId || null;
  const actorLabel = entry?.executor?.tag ? `${entry.executor.tag} (${actorId})` : '실행자 미확인';
  const alreadyScored = Boolean(entry && seenEntries.has(entry.id));

  if (actorId && isTrusted(guild, actorId)) return;

  if (entry && !alreadyScored) {
    seenEntries.set(entry.id, Date.now());
    const signal = classify(entry, guild) || { points: action === AuditLogEvent.RoleDelete ? 5 : 4, reason: LABELS.get(action) || '삭제 이벤트' };
    await scoreSignal(guild, entry, signal);
  } else if (!entry && canReadAudit) {
    await log(guild, `⚠️ **안티누크 실행자 미확인** | ${deletedObject.name || deletedObject.id} | 감사 로그를 찾지 못해 복구만 시도합니다.`);
  }

  // 동일 실행자가 방금 만든 채널/역할을 삭제한 경우 파괴 피해 복구가 아니므로 복제하지 않습니다.
  const actorCase = actorId ? cases.get(`${guild.id}:${actorId}`) : null;
  const createAction = action === AuditLogEvent.ChannelDelete ? AuditLogEvent.ChannelCreate : AuditLogEvent.RoleCreate;
  const createdBySameActor = Boolean(actorCase?.events?.some((item) =>
    item.action === createAction && item.targetId === deletedObject.id && Date.now() - item.at <= WINDOW_MS
  ));
  if (createdBySameActor) {
    await log(guild, `ℹ️ **안티누크 복구 생략** | ${deletedObject.name || deletedObject.id} | 같은 실행자가 최근 생성한 객체를 삭제한 것으로 확인되어 복제를 생략했습니다.`);
    return;
  }

  if (g.antiNukeRecover) {
    const roleMemberSnapshotKey = `${guild.id}:${deletedObject.id}`;
    const snapshotMembers = action === AuditLogEvent.RoleDelete
      ? [...(trackedRoleMembers.get(roleMemberSnapshotKey) || [])] : [];
    const liveMembers = action === AuditLogEvent.RoleDelete && deletedObject.members
      ? [...deletedObject.members.keys()] : [];
    const members = [...new Set([...snapshotMembers, ...liveMembers])].slice(0, 1000);
    if (action === AuditLogEvent.RoleDelete) trackedRoleMembers.delete(roleMemberSnapshotKey);
    const label = action === AuditLogEvent.RoleDelete ? '역할' : '채널';
    enqueueRecovery(guild, `${label}:${deletedObject.id}`, async () => {
      try {
        if (action === AuditLogEvent.ChannelDelete) await restoreChannel(guild, deletedObject, actorLabel, actorId);
        else if (action === AuditLogEvent.RoleDelete) await restoreRole(guild, deletedObject, actorLabel, members, actorId);
      } catch (err) {
        await log(guild, `❌ **안티누크 ${label} 복구 실패** | ${deletedObject.name || deletedObject.id} | ${err.message}`);
      }
    }).catch((err) => console.error('[안티누크 복구]', err.message));
  }
}

async function handleAuditEntry(entry, guild) {
  if (!guild || !entry?.id) return;
  const action = entry.action;
  if (seenEntries.has(entry.id)) return;
  const g = gs(guild.id);
  const deletionAction = action === AuditLogEvent.ChannelDelete || action === AuditLogEvent.RoleDelete;
  const punishAction = action === AuditLogEvent.MemberBanAdd || action === AuditLogEvent.MemberKick || action === AuditLogEvent.MemberPrune;
  if (punishAction) {
    if (g.antiMassPunish === false) return;
  } else if (!g.antiNuke) {
    return;
  }

  if (deletionAction && g.antiNuke) {
    pendingDeletionEntries.set(`${guild.id}:${entry.targetId}`, entry);
    // 오래된 복구 대상은 보존하고 가장 먼저 들어온 항목부터 제한적으로 정리합니다.
    while (pendingDeletionEntries.size > 1200) {
      const oldestKey = pendingDeletionEntries.keys().next().value;
      if (oldestKey === undefined) break;
      pendingDeletionEntries.delete(oldestKey);
    }
  }
  const signal = classify(entry, guild);
  if (!signal || !entry.executorId || isTrusted(guild, entry.executorId)) {
    if (deletionAction) seenEntries.set(entry.id, Date.now());
    return;
  }
  seenEntries.set(entry.id, Date.now());
  await rollbackRiskyMutation(guild, entry, signal).catch(async (err) => {
    await log(guild, `❌ **안티누크 권한 원복 실패** | ${signal.reason} | ${err.message}`);
  });
  await scoreSignal(guild, entry, signal);
}

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cases) {
    if (!value.events?.length || now - value.events[value.events.length - 1].at > WINDOW_MS) cases.delete(key);
  }
  for (const [id, at] of seenEntries) {
    if (now - at > 10 * 60_000) seenEntries.delete(id);
  }
  while (seenEntries.size > 10_000) {
    const oldestId = seenEntries.keys().next().value;
    if (oldestId === undefined) break;
    seenEntries.delete(oldestId);
  }
  for (const [key, entry] of pendingDeletionEntries) {
    if (now - entry.createdTimestamp > AUDIT_MAX_AGE_MS * 2) pendingDeletionEntries.delete(key);
  }
  for (const [key, at] of deletedRoleMarkers) {
    if (now - at > 60 * 60_000) deletedRoleMarkers.delete(key);
  }
}, 60_000).unref?.();

function listQuarantines(guild) {
  const records = gs(guild.id).quarantines || {};
  return Object.entries(records).map(([userId, record]) => ({
    userId,
    channelId: record.channelId || null,
    at: record.at || 0,
    score: Number(record.score) || 0,
    reason: String(record.reason || '').slice(0, 120),
  }));
}

module.exports = { handleDeletion, handleAuditEntry, trackMember, untrackMember, primeGuild, releaseQuarantine, applyQuarantineToChannel, listQuarantines };
