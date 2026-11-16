// fun.js - 편의 기능: 투표(버튼 패널) / 알림(리마인더) / 추첨 / 티켓(문의 채널)
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits: P, MessageFlags,
} = require('discord.js');
const { gs, save, log, extraStore, parseDuration, fmtDuration, isBotAdmin } = require('./server');

const EPH = MessageFlags.Ephemeral;

/* ───────────────────────── 투표 (버튼 패널) ─────────────────────────
 * .투표 제목 | 선택1 | 선택2 ...      (선택지 생략 → 찬성/반대)
 * .투표 1h 제목 | 선택1 | 선택2        (앞에 시간을 쓰면 그때 자동 종료)
 * 선택지마다 버튼이 생기고, 한 사람이 1표 (다른 버튼을 누르면 변경, 같은 버튼을 다시 누르면 취소). 투표는 익명이에요.
 */
const BAR = 10;
function pollTally(p) {
  const counts = p.options.map(() => 0);
  for (const idx of Object.values(p.votes)) if (counts[idx] !== undefined) counts[idx]++;
  return { counts, total: Object.keys(p.votes).length };
}

function pollEmbed(p) {
  const { counts, total } = pollTally(p);
  const top = Math.max(...counts);
  const lines = p.options.map((o, i) => {
    const pct = total ? Math.round((counts[i] / total) * 100) : 0;
    const filled = total ? Math.round((counts[i] / total) * BAR) : 0;
    const win = p.ended && top > 0 && counts[i] === top ? ' 🏆' : '';
    return `**${i + 1}. ${o}**${win}\n${'▰'.repeat(filled)}${'▱'.repeat(BAR - filled)}  ${counts[i]}표 (${pct}%)`;
  });
  const e = new EmbedBuilder().setColor(p.ended ? 0x747f8d : 0x5865f2).setTitle(`📊 ${p.title}`).setDescription(lines.join('\n\n').slice(0, 4000));
  const when = p.ended ? '종료됨' : p.endsAt ? `종료 ${new Date(p.endsAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '직접 종료 전까지';
  return e.setFooter({ text: `참여 ${total}명 · ${when} · 익명 투표` });
}

function pollRows(p) {
  const rows = [];
  for (let r = 0; r < p.options.length; r += 5) {
    rows.push(new ActionRowBuilder().addComponents(p.options.slice(r, r + 5).map((o, k) =>
      new ButtonBuilder().setCustomId(`poll:vote:${r + k}`).setLabel(`${r + k + 1}. ${o}`.slice(0, 80)).setStyle(ButtonStyle.Primary).setDisabled(p.ended))));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('poll:end').setLabel('투표 종료').setEmoji('🛑').setStyle(ButtonStyle.Danger).setDisabled(p.ended)));
  return rows;
}

async function poll(m, args) {
  let endsAt = null;
  let rest = args;
  const ms = args.length > 1 ? parseDuration(args[0], false) : null;   // 숫자만은 시간으로 보지 않아요 (제목이 숫자일 수 있어서)
  if (ms) { endsAt = Date.now() + ms; rest = args.slice(1); }
  const parts = rest.join(' ').split('|').map((s) => s.trim()).filter(Boolean);
  const usage = '사용법: `.투표 제목 | 선택1 | 선택2 ...` (선택지를 안 쓰면 찬성/반대, 최대 10개)\n자동 종료: `.투표 1h 제목 | 선택1 | 선택2`';
  if (!parts.length) return usage;
  const [title, ...opts] = parts;
  if (opts.length === 1) return '선택지는 2개 이상 적어주세요. (제목만 쓰면 찬성/반대 투표)\n' + usage;
  if (opts.length > 10) return '선택지는 최대 10개예요.';
  if (ms && (ms < 10000 || ms > 30 * 864e5)) return '자동 종료 시간은 10초 이상, 30일 이하로 정해주세요.';
  const p = {
    guild: m.guild.id, channel: m.channel.id, host: m.author.id, title: title.slice(0, 200),
    options: (opts.length ? opts : ['👍 찬성', '👎 반대']).map((o) => o.slice(0, 70)), votes: {}, endsAt, ended: false,
  };
  const sent = await m.channel.send({ embeds: [pollEmbed(p)], components: pollRows(p), allowedMentions: { parse: [] } });
  extraStore().polls[sent.id] = p;
  save();
  m.delete().catch(() => {});
  return null;
}

async function endPoll(client, id) {
  const p = extraStore().polls[id];
  if (!p || p.ended) return false;
  p.ended = true;
  p.endedAt = Date.now();
  save();
  const ch = await client.channels.fetch(p.channel).catch(() => null);
  const msg = ch ? await ch.messages.fetch(id).catch(() => null) : null;
  await msg?.edit({ embeds: [pollEmbed(p)], components: pollRows(p) }).catch(() => {});
  return true;
}

async function tickPolls(client) {
  const polls = extraStore().polls;
  const now = Date.now();
  for (const [id, p] of Object.entries(polls)) {
    if (!p.ended && p.endsAt && p.endsAt <= now) await endPoll(client, id);
    else if (p.ended && now - (p.endedAt || 0) > 3 * 864e5) { delete polls[id]; save(); }
  }
}

async function pollVote(i) {
  const p = extraStore().polls[i.message.id];
  if (!p || p.ended) return i.reply({ content: '이미 끝난 투표예요.', flags: EPH });
  const idx = Number(i.customId.split(':')[2]);
  const cur = p.votes[i.user.id];
  let msg;
  if (cur === idx) { delete p.votes[i.user.id]; msg = `**${idx + 1}번** 투표를 취소했어요.`; }
  else { p.votes[i.user.id] = idx; msg = cur === undefined ? `✅ **${idx + 1}. ${p.options[idx]}** 에 투표했어요!` : `🔄 **${idx + 1}. ${p.options[idx]}** 로 바꿨어요.`; }
  save();
  await i.update({ embeds: [pollEmbed(p)], components: pollRows(p) });
  await i.followUp({ content: msg, flags: EPH }).catch(() => {});
}

async function pollEnd(i) {
  const p = extraStore().polls[i.message.id];
  if (!p || p.ended) return i.reply({ content: '이미 끝난 투표예요.', flags: EPH });
  if (i.user.id !== p.host && !i.member.permissions.has(P.ManageMessages) && !isBotAdmin(i.user.id)) {
    return i.reply({ content: '투표를 만든 사람이나 관리자만 종료할 수 있어요.', flags: EPH });
  }
  p.ended = true;
  p.endedAt = Date.now();
  save();
  await i.update({ embeds: [pollEmbed(p)], components: pollRows(p) });
}

/* ───────────────────────── 알림(리마인더) ───────────────────────── */
async function remind(m, args) {
  const x = extraStore();
  const mine = x.reminders.filter((r) => r.user === m.author.id).sort((a, b) => a.at - b.at);
  const sub = (args[0] || '').toLowerCase();

  if (['목록', 'list'].includes(sub)) {
    if (!mine.length) return '예약된 알림이 없어요. `.알림 10m 라면 꺼내기`';
    return '⏰ **내 알림**\n' + mine.map((r, i) => `${i + 1}. <t:${Math.floor(r.at / 1000)}:R> — ${r.text}`).join('\n');
  }
  if (['취소', 'cancel', '삭제'].includes(sub)) {
    const r = mine[Number(args[1]) - 1];
    if (!r) return '사용법: `.알림 취소 <번호>` (번호는 `.알림 목록`에서 확인)';
    x.reminders = x.reminders.filter((y) => y !== r);
    save();
    return `🗑️ 알림을 취소했어요: ${r.text}`;
  }

  const ms = parseDuration(args[0], false, 6e4);   // 숫자만 쓰면 분
  if (!ms) return '사용법: `.알림 <시간> <내용>` — 시간은 `10m` `1h30m` `2일` `30분` 처럼 (숫자만 쓰면 분)\n`.알림 목록` · `.알림 취소 <번호>`';
  if (mine.length >= 10) return '알림은 최대 10개까지 예약할 수 있어요.';
  const text = args.slice(1).join(' ').trim().slice(0, 300) || '알림';
  const at = Date.now() + ms;
  x.reminders.push({ user: m.author.id, channel: m.channel.id, at, text });
  save();
  return `⏰ ${fmtDuration(ms)} 뒤(<t:${Math.floor(at / 1000)}:R>)에 알려드릴게요: ${text}`;
}

async function tickReminders(client) {
  const x = extraStore();
  const now = Date.now();
  const due = x.reminders.filter((r) => r.at <= now);
  if (!due.length) return;
  x.reminders = x.reminders.filter((r) => r.at > now);
  save();
  for (const r of due) {
    const msg = `<@${r.user}> ⏰ **알림**: ${r.text}`;
    const ch = await client.channels.fetch(r.channel).catch(() => null);
    const ok = ch?.isTextBased() ? await ch.send({ content: msg, allowedMentions: { users: [r.user] } }).then(() => true).catch(() => false) : false;
    if (!ok) { const u = await client.users.fetch(r.user).catch(() => null); await u?.send(msg).catch(() => {}); }
  }
}

/* ───────────────────────── 추첨 ───────────────────────── */
function giveawayEmbed(gw, ended = false, winnerIds = []) {
  const e = new EmbedBuilder().setColor(ended ? 0x747f8d : 0xeb459e).setTitle(`🎉 ${gw.prize}`);
  if (!ended) {
    e.setDescription(`아래 **참가** 버튼을 눌러요! (다시 누르면 취소)\n\n⏳ 종료: <t:${Math.floor(gw.endsAt / 1000)}:R>\n🏆 당첨자: ${gw.winners}명\n👤 주최: <@${gw.host}>`);
  } else {
    e.setDescription(`**종료됐어요**\n\n🏆 당첨: ${winnerIds.length ? winnerIds.map((id) => `<@${id}>`).join(' ') : '참가자가 없었어요'}\n👥 참가자: ${gw.entries.length}명\n👤 주최: <@${gw.host}>`);
  }
  return e;
}
const giveawayRow = (gw, disabled = false) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('gw:join').setLabel(`참가 (${gw.entries.length})`).setEmoji('🎉').setStyle(ButtonStyle.Primary).setDisabled(disabled),
);

async function giveaway(m, args) {
  const ms = parseDuration(args[0], false, 6e4);
  const winners = Number(args[1]);
  const prize = args.slice(2).join(' ').trim().slice(0, 200);
  if (!ms || !Number.isInteger(winners) || winners < 1 || winners > 20 || !prize) {
    return '사용법: `.추첨 <시간> <당첨자수> <상품>` — 예: `.추첨 1h 2 디스코드 니트로`\n시간은 `10m` `1h` `1d` 처럼, 숫자만 쓰면 분이에요.';
  }
  if (ms < 10000 || ms > 30 * 864e5) return '시간은 10초 이상, 30일 이하로 정해주세요.';
  const gw = { guild: m.guild.id, channel: m.channel.id, host: m.author.id, prize, winners, endsAt: Date.now() + ms, entries: [], ended: false };
  const sent = await m.channel.send({ embeds: [giveawayEmbed(gw)], components: [giveawayRow(gw)], allowedMentions: { parse: [] } });
  extraStore().giveaways[sent.id] = gw;
  save();
  m.delete().catch(() => {});
  return null;
}

async function endGiveaway(client, id) {
  const gw = extraStore().giveaways[id];
  if (!gw || gw.ended) return false;
  gw.ended = true;
  gw.endedAt = Date.now();
  const pool = [...gw.entries];
  const picked = [];
  while (pool.length && picked.length < gw.winners) picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  gw.winnerIds = picked;
  save();
  const ch = await client.channels.fetch(gw.channel).catch(() => null);
  const msg = ch ? await ch.messages.fetch(id).catch(() => null) : null;
  await msg?.edit({ embeds: [giveawayEmbed(gw, true, picked)], components: [giveawayRow(gw, true)] }).catch(() => {});
  if (ch?.isTextBased()) {
    await ch.send({
      content: picked.length ? `🎉 축하해요 ${picked.map((u) => `<@${u}>`).join(' ')}! **${gw.prize}** 당첨!` : `😢 **${gw.prize}** 추첨은 참가자가 없어서 끝났어요.`,
      allowedMentions: { users: picked }, reply: msg ? { messageReference: msg.id, failIfNotFound: false } : undefined,
    }).catch(() => {});
  }
  return true;
}

async function giveawayEnd(m, args) {
  const id = (args[0] || '').replace(/\D/g, '');
  const gw = extraStore().giveaways[id];
  if (!gw || gw.guild !== m.guild.id) return '사용법: `.추첨종료 <추첨 메시지 ID>` (메시지 우클릭/길게 눌러 ID 복사)';
  if (gw.ended) return '이미 끝난 추첨이에요.';
  await endGiveaway(m.client, id);
  return '🎉 추첨을 지금 종료했어요.';
}

async function tickGiveaways(client) {
  const gws = extraStore().giveaways;
  const now = Date.now();
  for (const [id, gw] of Object.entries(gws)) {
    if (!gw.ended && gw.endsAt <= now) await endGiveaway(client, id);
    else if (gw.ended && now - (gw.endedAt || 0) > 3 * 864e5) { delete gws[id]; save(); }   // 3일 지난 기록 정리
  }
}

async function giveawayJoin(i) {
  const gw = extraStore().giveaways[i.message.id];
  if (!gw || gw.ended) return i.reply({ content: '이미 끝난 추첨이에요.', flags: EPH });
  const at = gw.entries.indexOf(i.user.id);
  if (at >= 0) gw.entries.splice(at, 1); else gw.entries.push(i.user.id);
  save();
  await i.reply({ content: at >= 0 ? '참가를 취소했어요.' : '🎉 참가했어요! 행운을 빌어요.', flags: EPH });
  await i.message.edit({ components: [giveawayRow(gw)] }).catch(() => {});
}

/* ───────────────────────── 티켓 (문의 채널) ───────────────────────── */
async function ticketSetup(m) {
  const ch = m.mentions.channels.first();
  const role = m.mentions.roles.first();
  if (!ch || !ch.isTextBased() || ch.isThread() || !role) return '사용법: `.티켓설정 #패널채널 @담당역할`\n버튼을 누르면 그 사람과 담당 역할만 볼 수 있는 비공개 문의 채널이 생겨요.';
  const g = gs(m.guild.id);
  const me = m.guild.members.me;
  let cat = g.ticket?.category ? m.guild.channels.cache.get(g.ticket.category) : null;
  if (!cat) {
    cat = await m.guild.channels.create({
      name: '🎫・티켓', type: ChannelType.GuildCategory, reason: '[티켓설정]',
      permissionOverwrites: [
        { id: m.guild.id, type: 0, deny: [P.ViewChannel] },
        { id: role.id, type: 0, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] },
        { id: me.id, type: 1, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageChannels] },
      ],
    }).catch((e) => { throw new Error('티켓 카테고리를 만들 수 없어요. 봇의 채널 관리 권한을 확인해주세요. (' + e.message + ')'); });
  }
  const embed = new EmbedBuilder().setColor(0x57f287).setTitle('🎫 문의하기')
    .setDescription('도움이 필요하거나 문의할 게 있으면 아래 버튼을 눌러주세요.\n나와 운영진만 볼 수 있는 **비공개 채널**이 만들어져요.');
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket:open').setLabel('문의하기').setEmoji('🎫').setStyle(ButtonStyle.Success));
  const msg = await ch.send({ embeds: [embed], components: [row] }).catch(() => { throw new Error('그 채널에 메시지를 보낼 수 없어요. 봇 권한을 확인해주세요.'); });
  g.ticket = { category: cat.id, staffRole: role.id, panelChannel: ch.id, panelMessage: msg.id };
  save();
  await log(m.guild, `🎫 티켓 패널 설정 | ${ch.name} | 담당 ${role.name} | by ${m.author.tag}`);
  return `🎫 ${ch} 에 문의 버튼을 올렸어요. 담당 역할: ${role}`;
}

async function ticketOpen(i) {
  const t = gs(i.guild.id).ticket;
  if (!t) return i.reply({ content: '티켓이 설정돼 있지 않아요.', flags: EPH });
  const exist = i.guild.channels.cache.find((c) => c.parentId === t.category && c.topic === `ticket:${i.user.id}`);
  if (exist) return i.reply({ content: `이미 열려 있는 문의 채널이 있어요: ${exist}`, flags: EPH });
  await i.deferReply({ flags: EPH });
  const clean = i.user.username.toLowerCase().replace(/[^a-z0-9가-힣-]/g, '').slice(0, 30);
  const me = i.guild.members.me;
  try {
    const ch = await i.guild.channels.create({
      name: `ticket-${clean || i.user.id.slice(-4)}`, type: ChannelType.GuildText, parent: t.category, topic: `ticket:${i.user.id}`, reason: `[티켓] ${i.user.tag}`,
      permissionOverwrites: [
        { id: i.guild.id, type: 0, deny: [P.ViewChannel] },
        { id: i.user.id, type: 1, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks] },
        { id: t.staffRole, type: 0, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks] },
        { id: me.id, type: 1, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageChannels] },
      ],
    });
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket:close').setLabel('티켓 닫기').setEmoji('🔒').setStyle(ButtonStyle.Danger));
    await ch.send({
      content: `<@${i.user.id}> <@&${t.staffRole}>`,
      embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('🎫 문의 채널').setDescription('문의 내용을 자세히 적어주세요. 담당자가 곧 도와드릴 거예요.\n해결되면 아래 **티켓 닫기**를 눌러주세요.')],
      components: [row], allowedMentions: { users: [i.user.id], roles: [t.staffRole] },
    });
    await log(i.guild, `🎫 티켓 열림 | ${i.user.tag} | #${ch.name}`);
    await i.editReply({ content: `🎫 문의 채널을 만들었어요: ${ch}` });
  } catch (err) {
    await i.editReply({ content: `❌ 채널을 만들 수 없어요. 봇 권한을 확인해주세요. (${err.message})` });
  }
}

async function ticketClose(i) {
  const ch = i.channel;
  const owner = (ch.topic || '').startsWith('ticket:') ? ch.topic.slice(7) : null;
  if (!owner) return i.reply({ content: '티켓 채널이 아니에요.', flags: EPH });
  const t = gs(i.guild.id).ticket;
  const isStaff = (t && i.member.roles.cache.has(t.staffRole)) || i.member.permissions.has(P.ManageChannels);
  if (i.user.id !== owner && !isStaff) return i.reply({ content: '티켓을 만든 사람이나 담당자만 닫을 수 있어요.', flags: EPH });
  await i.reply({ content: '🔒 5초 뒤에 이 채널을 삭제해요.' });
  await log(i.guild, `🔒 티켓 닫힘 | #${ch.name} | by ${i.user.tag}`);
  setTimeout(() => ch.delete(`[티켓] 닫음 by ${i.user.tag}`).catch(() => {}), 5000);
}

/* ───────────────────────── 버튼 라우터 / 시작 ───────────────────────── */
async function handleInteraction(i) {
  if (!i.isButton() || !i.guild) return false;
  if (i.customId.startsWith('poll:vote:')) { await pollVote(i); return true; }
  if (i.customId === 'poll:end') { await pollEnd(i); return true; }
  if (i.customId === 'gw:join') { await giveawayJoin(i); return true; }
  if (i.customId === 'ticket:open') { await ticketOpen(i); return true; }
  if (i.customId === 'ticket:close') { await ticketClose(i); return true; }
  return false;
}

function start(client) {
  setInterval(() => {
    tickReminders(client).catch((e) => console.error('[알림 오류]', e.message));
    tickPolls(client).catch((e) => console.error('[투표 오류]', e.message));
    tickGiveaways(client).catch((e) => console.error('[추첨 오류]', e.message));
  }, 10 * 1000);
}

module.exports = { poll, remind, giveaway, giveawayEnd, ticketSetup, handleInteraction, start };
