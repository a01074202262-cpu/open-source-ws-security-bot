// cmd.js - 명령어 목록(이름/별칭/사용법/설명/권한) + 도움말 + 실행기
const {
  PermissionFlagsBits: P, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');
const { F, isAuthed, isOwner, canBackup } = require('./server');
const B = require('./backup');
const X = require('./extras');
const G = require('./guard');
const Fn = require('./fun');
const V = require('./verify');
const X2 = require('./plus');
const Mod = require('./moderation');
const AntiNuke = require('./antinuke');

const PREFIX = '.';
const publicCool = new Map();   // 누구나 쓰는 명령어의 쿨다운

/* cat: 도움말 분류 / perm: 필요한 서버 권한(없으면 누구나) / temp: 응답 자동 삭제(초) */
const commands = [
  // ── 감사/아카이브 ──
  { cat: '📋 감사 · 아카이브', name: '모더레이션로그', aliases: ['modlogs', '처벌로그', '감사기록'], usage: '.모더레이션로그 [검색어|유저ID]', desc: '밴·언밴·킥·타임아웃·메시지 삭제·채널/역할 변경 등의 실행자, 대상, 사유를 조회해요.', perm: P.ViewAuditLog, run: Mod.moderationLogCommand },
  { cat: '📋 감사 · 아카이브', name: '메시지기록', aliases: ['메시지아카이브', 'archive', 'deletedmessages'], usage: '.메시지기록 [검색어|유저ID]\n.메시지기록 복원 <원본 메시지 ID>\n.메시지기록 켜기|끄기|초기화', desc: '삭제·수정 메시지 최근 500건 검색과 삭제 메시지 재게시를 지원해요. 원본 ID/시각 복구는 아니며 메시지 관리 권한이 필요해요.', perm: P.ManageMessages, run: Mod.archiveCommand },
  { cat: '🛡️ 자동 보안 설정', name: '격리목록', aliases: ['quarantines', '격리유저'], usage: '.격리목록', desc: '현재 서버에서 안티누크 격리된 사용자와 전용 채팅방을 조회해요.', perm: P.ManageGuild, run: async (m) => {
    if (m.author.id !== m.guild.ownerId && !m.member.permissions.has(P.Administrator) && !m.member.permissions.has(P.ManageGuild)) return '서버 방장 또는 관리자 권한이 있는 사람만 조회할 수 있어요.';
    const rows = AntiNuke.listQuarantines(m.guild);
    if (!rows.length) return '현재 격리된 사용자가 없어요.';
    return rows.slice(0, 25).map((row, i) => `${i + 1}. <@${row.userId}> (${row.userId}) · ${row.score}점 · ${row.channelId ? `<#${row.channelId}>` : '채널 없음'} · <t:${Math.floor(row.at / 1000)}:R>`).join('\n');
  } },
  { cat: '🛡️ 자동 보안 설정', name: '격리해제', aliases: ['unquarantine', '격리풀기'], usage: '.격리해제 @유저|유저ID', desc: '안티누크 격리를 해제하고 격리 전 역할을 가능한 범위에서 복구해요. 격리 채팅방은 관리자 기록 보존용으로 남겨요.', perm: P.ManageGuild, run: async (m, args) => {
    if (m.author.id !== m.guild.ownerId && !m.member.permissions.has(P.Administrator) && !m.member.permissions.has(P.ManageGuild)) return '서버 방장 또는 관리자 권한이 있는 사람만 격리를 해제할 수 있어요.';
    const target = m.mentions.members.first() || await m.guild.members.fetch((args[0] || '').replace(/\D/g, '')).catch(() => null);
    if (!target) return '사용법: `.격리해제 @유저|유저ID`';
    const result = await AntiNuke.releaseQuarantine(m.guild, target.id, m.author.id);
    return result.message;
  } },
  // ── 처벌 ──
  { cat: '🔨 처벌', name: '밴', aliases: ['ban'], usage: '.밴 @유저 [사유]', desc: '유저를 서버에서 영구 차단해요.', perm: P.BanMembers, run: F.ban },
  { cat: '🔨 처벌', name: '임시밴', aliases: ['tempban'], usage: '.임시밴 @유저 <1h|1d|7d> [사유]', desc: '정해진 시간 동안만 차단하고 시간이 지나면 자동으로 풀어요. (최대 365일)', perm: P.BanMembers, run: F.tempban },
  { cat: '🔨 처벌', name: '소프트밴', aliases: ['softban'], usage: '.소프트밴 @유저 [사유]', desc: '밴으로 최근 24시간 메시지를 지우고 바로 밴을 풀어요. (내보내기 + 메시지 청소)', perm: P.BanMembers, run: F.softban },
  { cat: '🔨 처벌', name: '일괄밴', aliases: ['massban'], usage: '.일괄밴 <ID> <ID> ...', desc: '여러 유저를 ID로 한 번에 밴해요. (최대 20명, 서버에 없는 유저도 가능)', perm: P.BanMembers, run: F.massban },
  { cat: '🔨 처벌', name: '언밴', aliases: ['unban'], usage: '.언밴 <유저ID>', desc: '차단된 유저의 밴을 해제해요.', perm: P.BanMembers, run: F.unban },
  { cat: '🔨 처벌', name: '밴목록', aliases: ['banlist'], usage: '.밴목록', desc: '최근 밴된 유저 20명과 사유를 봐요.', perm: P.BanMembers, run: F.banlist },
  { cat: '🔨 처벌', name: '킥', aliases: ['kick'], usage: '.킥 @유저 [사유]', desc: '유저를 서버에서 내보내요. (다시 입장 가능)', perm: P.KickMembers, run: F.kick },
  { cat: '🔨 처벌', name: '타임아웃', aliases: ['뮤트', 'mute', 'timeout'], usage: '.타임아웃 <@유저|유저ID> [시간] [사유]', desc: '일정 시간 채팅/음성을 막아요. 유저는 멘션이나 ID 둘 다 가능해요. 시간은 `10m` `1h` `1d` `30분` `2시간` `1h30m` 처럼 쓰고, 숫자만 쓰면 분이에요. 생략 시 10분, 최대 28일.', perm: P.ModerateMembers, run: F.mute },
  { cat: '🔨 처벌', name: '타임아웃해제', aliases: ['언뮤트', 'unmute'], usage: '.타임아웃해제 @유저', desc: '유저의 타임아웃을 해제해요.', perm: P.ModerateMembers, run: F.unmute },

  // ── 경고 ──
  { cat: '⚠️ 경고', name: '경고', aliases: ['warn'], usage: '.경고 @유저 [사유]', desc: '경고 1회를 줘요. 3회 누적 시 1시간 타임아웃, 5회 누적 시 킥돼요.', perm: P.ModerateMembers, run: F.warn },
  { cat: '⚠️ 경고', name: '경고목록', aliases: ['경고확인', 'warnings'], usage: '.경고목록 [@유저]', desc: '유저의 경고 기록(최근 10개)을 봐요. 생략 시 내 경고.', run: F.warnings },
  { cat: '⚠️ 경고', name: '경고삭제', aliases: ['delwarn', 'unwarn'], usage: '.경고삭제 @유저 <번호>', desc: '경고 전체가 아니라 번호로 하나만 지워요. 번호는 `.경고목록`에서 확인해요.', perm: P.ModerateMembers, run: F.delwarn },
  { cat: '⚠️ 경고', name: '메모', aliases: ['memo', 'note'], usage: '.메모 추가 @유저 <내용>\n.메모 목록 @유저\n.메모 삭제 @유저 <번호>', desc: '유저에 대해 관리자끼리 공유하는 메모를 남겨요. (유저당 최대 50개)', perm: P.ModerateMembers, run: F.memo },
  { cat: '⚠️ 경고', name: '경고초기화', aliases: ['clearwarns'], usage: '.경고초기화 @유저', desc: '유저의 경고를 전부 지워요.', perm: P.ModerateMembers, run: F.clearwarns },

  // ── 채널 관리 ──
  { cat: '🧰 채널 관리', name: '청소', aliases: ['clear', '삭제', 'purge'], usage: '.청소 <1~100>', desc: '현재 채널의 최근 메시지를 한 번에 삭제해요. (14일 이내)', perm: P.ManageMessages, temp: 4, run: F.clear },
  { cat: '🧰 채널 관리', name: '청소유저', aliases: ['cleanuser'], usage: '.청소유저 @유저 [개수]', desc: '최근 메시지 중 특정 유저의 메시지만 지워요. (기본 50개, 최대 100개)', perm: P.ManageMessages, temp: 4, run: F.cleanuser },
  { cat: '🧰 채널 관리', name: '청소봇', aliases: ['cleanbots'], usage: '.청소봇', desc: '최근 100개 메시지 중 봇이 보낸 메시지를 지워요.', perm: P.ManageMessages, temp: 4, run: F.cleanbots },
  { cat: '🧰 채널 관리', name: '잠금', aliases: ['lock'], usage: '.잠금', desc: '현재 채널에서 @everyone의 채팅을 막아요.', perm: P.ManageChannels, run: F.lock },
  { cat: '🧰 채널 관리', name: '잠금해제', aliases: ['unlock'], usage: '.잠금해제', desc: '현재 채널의 잠금을 풀어요.', perm: P.ManageChannels, run: F.unlock },
  { cat: '🧰 채널 관리', name: '서버잠금', aliases: ['lockdown'], usage: '.서버잠금', desc: '모든 텍스트 채널의 채팅을 한 번에 막아요. (비상용, 이미 잠긴 채널은 그대로 둬요)', perm: P.ManageGuild, run: F.lockdown },
  { cat: '🧰 채널 관리', name: '서버잠금해제', aliases: ['unlockdown'], usage: '.서버잠금해제', desc: '서버잠금으로 잠근 채널만 다시 풀어요.', perm: P.ManageGuild, run: F.unlockdown },
  { cat: '🧰 채널 관리', name: '슬로우모드', aliases: ['slowmode', '슬로우'], usage: '.슬로우모드 <초>', desc: '채팅 간격을 설정해요. 0이면 해제, 최대 6시간.', perm: P.ManageChannels, run: F.slowmode },
  { cat: '🧰 채널 관리', name: '공지', aliases: ['announce'], usage: '.공지 [#채널] <내용>', desc: '공지 임베드를 보내요. 채널을 생략하면 현재 채널.', perm: P.ManageMessages, run: F.announce },

  // ── 유저 관리 ──
  { cat: '👥 유저 관리', name: '역할지급', aliases: ['addrole'], usage: '.역할지급 @유저 @역할', desc: '유저에게 역할을 줘요. (내 최고 역할보다 낮은 역할만, 관리자 역할은 서버 주인만)', perm: P.ManageRoles, run: F.addrole },
  { cat: '👥 유저 관리', name: '역할회수', aliases: ['removerole'], usage: '.역할회수 @유저 @역할', desc: '유저에게서 역할을 빼요.', perm: P.ManageRoles, run: F.removerole },
  { cat: '👥 유저 관리', name: '닉네임', aliases: ['nick'], usage: '.닉네임 @유저 [새 이름]', desc: '유저의 서버 닉네임을 바꿔요. 이름을 생략하면 초기화해요.', perm: P.ManageNicknames, run: F.nick },

  { cat: '👥 유저 관리', name: '유저검색', aliases: ['finduser', '멤버검색'], usage: '.유저검색 <이름 일부>', desc: '이름이나 닉네임 일부로 멤버를 찾아 ID를 알려줘요.', perm: P.ModerateMembers, run: F.finduser },
  { cat: '👥 유저 관리', name: '최근가입', aliases: ['recentjoins', '신규'], usage: '.최근가입 [개수]', desc: '최근에 들어온 멤버를 보여줘요. 만든 지 7일 미만 계정은 ⚠️ 로 표시돼요. (기본 10명, 최대 25명)', perm: P.ModerateMembers, run: F.recentjoins },

  // ── 소유자 전용 ──
  { cat: '👑 소유자 전용', name: '권한부여', aliases: ['grant'], usage: '.권한부여 @유저', desc: '그 유저가 소유자 전용을 뺀 모든 봇 명령어를 쓸 수 있게 하고 **✅봇 권한** 역할을 줘요(없으면 만들어요). 환경변수를 고칠 필요 없이 바로 적용돼요. (받은 유저는 자동 보안에서도 제외돼요)', ownerOnly: true, run: F.grant },
  { cat: '👑 소유자 전용', name: '권한해제', aliases: ['revoke'], usage: '.권한해제 @유저', desc: '`.권한부여`로 준 봇 사용 권한을 회수해요.', ownerOnly: true, run: F.revoke },
  { cat: '👑 소유자 전용', name: '권한목록', aliases: ['grantlist'], usage: '.권한목록', desc: '봇을 쓸 수 있는 유저 목록을 봐요.', ownerOnly: true, run: F.grantlist },

  { cat: '👑 소유자 전용', name: '자동킥채널', aliases: ['trapchannel', '함정채널'], usage: '.자동킥채널 #채널\n.자동킥채널 해제\n.자동킥채널 상태', desc: '채널에 "여기에 메세지 절대로 보내지 마세요" 안내를 올려요. 그 채널에 메시지를 보내면 메시지 삭제 + **1일 타임아웃**돼요. 소유자와 인증된(권한부여 받은) 유저는 제외예요.', ownerOnly: true, run: F.trapchannel },

  { cat: '👑 소유자 전용', name: '블랙리스트', aliases: ['blacklist', 'bl'], usage: '.블랙리스트 추가 <유저ID> [사유]\n.블랙리스트 제거 <유저ID>\n.블랙리스트 목록', desc: '봇 탈취/테러 시도자를 **유저 ID** 로 등록해요. 봇이 있는 모든 서버에서 영구 차단하고, 앞으로 어느 서버에 들어와도 바로 차단돼요. (IP/HWID 는 디스코드가 봇에게 알려주지 않아요)', ownerOnly: true, run: G.blacklistCmd },
  { cat: '👑 소유자 전용', name: '저장상태', aliases: ['storage', 'dbstatus'], usage: '.저장상태', desc: '데이터 저장 방식(MongoDB/파일), 마지막 저장 시각, 저장 횟수, 오류를 봐요.', ownerOnly: true, run: F.storage },
  { cat: '👑 소유자 전용', name: '백업', aliases: ['backup'], usage: '.백업', desc: '봇의 전체 데이터를 JSON 파일로 내 DM 에 보내줘요. (채널에는 올라가지 않아요)', ownerOnly: true, run: F.backup },

  // ── 서버 현황 / 꾸미기 ──
  { cat: '👥 서버 현황', name: '서버인원', aliases: ['members', 'memberlist', '인원'], usage: '.서버인원 [검색어]', desc: '서버의 모든 인원을 **서버에 들어온 순서대로** 페이지로 보여줘요. 입장 시각, 현재 역할, 유저 ID가 나오고 🔍 버튼으로 이름/닉네임/ID 검색, 메뉴로 ID 복사(코드 블록)가 돼요.', run: X.memberList },
  { cat: '👥 서버 현황', name: '서버봇', aliases: ['serverbots', '봇목록'], usage: '.서버봇 [검색어]', desc: '서버에 들어와 있는 봇을 페이지로 보여줘요. 입장 시각·역할·ID와 함께 관리자 등 **위험한 권한**을 가진 봇은 ⚠️ 로 표시해요.', run: X.botList },
  { cat: '🏗️ 서버 꾸미기', name: '기본서버', aliases: ['basesetup', '기본세팅'], usage: '.기본서버\n.기본서버 기존멤버인증\n.기본서버 다시', desc: '인증 채널을 포함한 기본 채널(안내·채팅·음성·관리)과 인증 역할을 꾸며서 만들어요. 기존 채널은 건드리지 않고 추가만 해요. 채팅/음성은 인증된 사람만 볼 수 있어요.', backup: true, run: X.baseServer },

  // ── 서버 백업 (서버 방장 + 봇 소유자 전용) ──
  { cat: '💾 서버 백업', name: '서버백업', aliases: ['serverbackup', 'guildbackup'], usage: '.서버백업', desc: '서버의 채널(이름·순서·카테고리·주제·권한)과 역할(이름·순서·색·권한), 채널별 권한 덮어쓰기, 멤버별 역할을 봇에 저장해요. 서버마다 따로 저장되고, 다시 백업하면 이전 백업은 한 단계 보관돼요.', backup: true, run: B.serverBackup },
  { cat: '💾 서버 백업', name: '서버복원', aliases: ['serverrestore', 'guildrestore'], usage: '.서버복원\n.서버복원 이전', desc: '저장된 백업대로 서버를 되돌려요. **지금 있는 채널/역할을 모두 지우고 백업대로 다시 만들어요.** (메시지는 복원 안 됨) 시작 전에 현재 상태를 자동 저장해서 `.서버복원 이전` 으로 되돌릴 수 있어요. 봇에게 관리자 권한이 필요해요.', backup: true, run: B.serverRestore },
  { cat: '💾 서버 백업', name: '서버백업정보', aliases: ['serverbackupinfo', '백업정보'], usage: '.서버백업정보\n.서버백업정보 이전', desc: '저장된 백업의 채널 수·이름, 역할 수·이름·순서·권한, 채널 권한을 정리해서 백업한 사람 DM 으로 보내줘요. (명령어를 쓴 사람이 다르면 그 사람에게도 보내요)', backup: true, run: B.serverBackupInfo },

  { cat: '🧩 편의 기능', name: '투표', aliases: ['poll', 'vote'], usage: '.투표 제목 | 선택1 | 선택2 ...\n.투표 제목\n.투표 1h 제목 | 선택1 | 선택2', desc: '제목과 **버튼 패널**이 있는 투표를 만들어요. 선택지마다 버튼이 생기고 누르면 투표돼요. (1인 1표, 다른 버튼으로 변경·같은 버튼으로 취소, 익명) 선택지를 안 쓰면 찬성/반대, 앞에 시간을 쓰면 자동 종료, 🛑 버튼으로 직접 종료해요. 최대 10개.', run: Fn.poll },
  { cat: '🧩 편의 기능', name: '알림', aliases: ['remind', '리마인더'], usage: '.알림 <시간> <내용>\n.알림 목록\n.알림 취소 <번호>', desc: '정한 시간이 지나면 이 채널에서 멘션으로 알려줘요. 시간은 `10m` `1h30m` `2일` `30분` (숫자만 쓰면 분). 봇이 재시작해도 유지돼요. (1인 최대 10개)', run: Fn.remind },
  { cat: '🧩 편의 기능', name: '추첨', aliases: ['giveaway', '이벤트추첨'], usage: '.추첨 <시간> <당첨자수> <상품>', desc: '🎉 참가 버튼이 있는 추첨을 열어요. 시간이 되면 자동으로 당첨자를 뽑아 발표해요. (참가 후 다시 누르면 취소)', run: Fn.giveaway },
  { cat: '🧩 편의 기능', name: '추첨종료', aliases: ['endgiveaway'], usage: '.추첨종료 <추첨 메시지 ID>', desc: '진행 중인 추첨을 지금 바로 끝내고 당첨자를 뽑아요.', run: Fn.giveawayEnd },
  { cat: '🧩 편의 기능', name: '티켓설정', aliases: ['ticket', '티켓'], usage: '.티켓설정 #패널채널 @담당역할', desc: '"🎫 문의하기" 버튼을 올려요. 누르면 그 사람과 담당 역할만 볼 수 있는 비공개 문의 채널이 생기고, 해결되면 🔒 버튼으로 닫아요.', backup: true, run: Fn.ticketSetup },
  { cat: '🧩 편의 기능', name: '환영', aliases: ['welcome'], usage: '.환영 #채널\n.환영 메시지 <내용>\n.환영 테스트\n.환영 해제', desc: '새 멤버가 들어오면 지정한 채널에 환영 메시지를 보내요. 문구에는 `{user}` `{name}` `{server}` `{count}` 를 쓸 수 있어요.', perm: P.ManageGuild, run: F.welcome },
  { cat: '🧩 편의 기능', name: '자동역할', aliases: ['autorole'], usage: '.자동역할 @역할\n.자동역할 해제', desc: '새 멤버가 들어오면 이 역할을 자동으로 줘요. (관리자 권한 역할은 서버 주인만 지정 가능)', perm: P.ManageRoles, run: F.autorole },

  { cat: '👑 소유자 전용', name: '인증채널', aliases: ['verifychannel'], usage: '.인증채널 #채널 @인증역할\n.인증채널 #채널\n.인증채널 해제', desc: '그 채널에 초록색 **인증** 버튼을 올려요. 버튼을 누르면 DM으로 보안코드(굵은 선으로 가려진 글자 그림)가 오고, DM으로 맞게 입력하면 인증 역할이 부여돼요. 인증 역할은 같이 지정하거나 `.인증역할`로 먼저 정해요.', ownerOnly: true, run: V.verifychannel },
  { cat: '👑 소유자 전용', name: '인증역할', aliases: ['verifyrole'], usage: '.인증역할 @역할', desc: '인증에 성공한 유저에게 줄 역할을 정해요. (봇 역할보다 낮아야 해요)', ownerOnly: true, run: V.verifyrole },

  // ── 자동 보안 설정 ──
  { cat: '🛡️ 자동 보안 설정', name: '보안', aliases: ['security', 'automod'], usage: '.보안 상태\n.보안 <스팸|초대|링크|링크검사|멘션|욕설|레이드|디도스|테러|복구|누크격리> <켜기|끄기>', desc: '자동 보안 기능의 상태를 보거나 하나씩 켜고 꺼요.', perm: P.ManageGuild, run: F.security },
  { cat: '🛡️ 자동 보안 설정', name: '경계', aliases: ['watch'], usage: '.경계 <추가|해제|목록|시간> [@유저|시간]', desc: '경계 대상을 관리해요. 경계 대상은 도배/초대/멘션도배/미검증 링크를 보내면 바로 밴돼요. 디도스 감지 후 남긴 1명은 자동으로 경계돼요.', perm: P.ManageGuild, run: F.watch },
  { cat: '🛡️ 자동 보안 설정', name: '신뢰링크', aliases: ['trust'], usage: '.신뢰링크 <추가|삭제|목록> [도메인]', desc: '검사 없이 허용할 도메인을 관리해요. 목록에 없는 링크는 미검증 링크로 취급돼요.', perm: P.ManageGuild, run: F.trust },
  { cat: '🛡️ 자동 보안 설정', name: '금칙어', aliases: ['badword'], usage: '.금칙어 <추가|삭제|목록> [단어]', desc: '금칙어를 관리해요. 포함된 메시지는 자동 삭제 + 경고돼요.', perm: P.ManageGuild, run: F.badword },
  { cat: '🛡️ 자동 보안 설정', name: '화이트리스트', aliases: ['whitelist', '예외'], usage: '.화이트리스트 <추가|삭제|목록> [@유저]', desc: '자동 보안에서 제외할 유저를 관리해요.', perm: P.ManageGuild, run: F.whitelist },
  { cat: '🛡️ 자동 보안 설정', name: '스팸설정', aliases: ['spamset'], usage: '.스팸설정 <개수> <초>', desc: '도배 기준을 바꿔요. (예: `.스팸설정 5 5` = 5초에 5개)', perm: P.ManageGuild, run: F.spamset },
  { cat: '🛡️ 자동 보안 설정', name: '멘션설정', aliases: ['mentionset'], usage: '.멘션설정 <개수>', desc: '한 메시지에 멘션이 몇 개 이상이면 도배로 볼지 정해요.', perm: P.ManageGuild, run: F.mentionset },
  { cat: '🛡️ 자동 보안 설정', name: '계정나이', aliases: ['accountage'], usage: '.계정나이 <일수>', desc: '가입한 지 N일 미만인 계정은 입장 시 자동 킥해요. 0이면 해제.', perm: P.ManageGuild, run: F.accountage },
  { cat: '🛡️ 자동 보안 설정', name: '레이드해제', aliases: ['resetraid'], usage: '.레이드해제', desc: '레이드 방어 모드와 디도스 감지 기록을 초기화해요.', perm: P.ManageGuild, run: F.resetraid },
  { cat: '🛡️ 자동 보안 설정', name: '로그채널', aliases: ['logchannel', '로그'], usage: '.로그채널 [#채널]', desc: '보안 로그를 보낼 채널을 정해요. 생략 시 현재 채널.', perm: P.ManageGuild, run: F.logchannel },

  // ── 정보/도구 ──
  { cat: '🛡️ 자동 보안 설정', name: '보안점검', aliases: ['audit', '점검'], usage: '.보안점검', desc: '봇 권한, 역할 순서, @everyone 권한, 서버 인증 수준, 꺼진 기능 등을 훑어서 점수와 개선점을 알려줘요.', perm: P.ManageGuild, run: F.audit },

  { cat: 'ℹ️ 정보 · 도구', name: '링크검사', aliases: ['scanlink', '링크확인'], usage: '.링크검사 <주소>', desc: '링크가 악성인지 직접 접속해서 검사해요. (누구나, 10초 쿨다운)', run: F.scanlink },
  { cat: 'ℹ️ 정보 · 도구', name: '유저정보', aliases: ['userinfo', '내정보'], usage: '.유저정보 [@유저]', desc: '계정 생성일, 서버 입장일, 경고 횟수, 경계 여부를 봐요.', run: F.userinfo },
  { cat: 'ℹ️ 정보 · 도구', name: '역할정보', aliases: ['roleinfo'], usage: '.역할정보 <@역할|이름|ID>', desc: '역할의 멤버 수, 위치, 위험한 권한(관리자/차단/전체 멘션 등)을 봐요.', run: F.roleinfo },
  { cat: 'ℹ️ 정보 · 도구', name: '아바타', aliases: ['avatar', '프사'], usage: '.아바타 [@유저]', desc: '유저의 프로필 사진을 크게 봐요.', run: F.avatar },
  { cat: 'ℹ️ 정보 · 도구', name: '서버정보', aliases: ['serverinfo'], usage: '.서버정보', desc: '서버 멤버/채널/역할 수 등을 봐요.', run: F.serverinfo },
  { cat: 'ℹ️ 정보 · 도구', name: '핑', aliases: ['ping'], usage: '.핑', desc: '봇 응답 속도를 확인해요.', run: F.ping },
  { cat: 'ℹ️ 정보 · 도구', name: '업타임', aliases: ['uptime'], usage: '.업타임', desc: '봇이 켜진 지 얼마나 됐는지 봐요.', run: F.uptime },
  { cat: 'ℹ️ 정보 · 도구', name: '봇정보', aliases: ['botinfo', '봇'], usage: '.봇정보', desc: '봇이 들어가 있는 서버 수, 핑, 업타임, 메모리, 버전을 봐요.', run: F.botinfo },

  // ── 편의 기능 (추가) ──
  { cat: '🧩 편의 기능', name: '주사위', aliases: ['dice', 'roll'], usage: '.주사위 [개수]d[면]\n.주사위 2d6', desc: '주사위를 굴려요. 생략하면 1d6, 최대 20개 · 1000면. (누구나)', public: true, run: X2.dice },
  { cat: '🧩 편의 기능', name: '동전', aliases: ['coin', '동전던지기'], usage: '.동전', desc: '동전을 던져 앞면/뒷면을 알려줘요. (누구나)', public: true, run: X2.coin },
  { cat: '🧩 편의 기능', name: '골라', aliases: ['pick', '선택', '골라줘'], usage: '.골라 피자 | 치킨 | 족발', desc: '선택지 중에서 하나를 골라줘요. `|` 또는 공백으로 구분해요. (누구나)', public: true, run: X2.pick },
  { cat: '🧩 편의 기능', name: '계산', aliases: ['calc', '계산기'], usage: '.계산 (12+3)*4/5', desc: '계산기예요. `+ - * / % ^ ( )` 를 쓸 수 있어요. (누구나)', public: true, run: X2.calc },
  { cat: '🧩 편의 기능', name: '잠수', aliases: ['afk', '자리비움'], usage: '.잠수 [사유]', desc: '자리를 비웠다고 표시해요. 누가 나를 멘션하면 봇이 대신 알려주고, 내가 다시 채팅을 치면 자동으로 풀려요. (누구나)', public: true, run: X2.afk },
  { cat: '🧩 편의 기능', name: '역할버튼', aliases: ['rolebutton', '역할패널'], usage: '.역할버튼 [#채널] @역할1 @역할2 ...', desc: '누르면 역할을 받고 다시 누르면 빼는 **역할 버튼 패널**을 올려요. 관리·차단·타임아웃 같은 위험한 권한이 있는 역할은 버튼으로 만들 수 없어요. (최대 10개)', perm: P.ManageRoles, run: X2.roleButtonCmd },
  { cat: '🧩 편의 기능', name: '채널정보', aliases: ['channelinfo', 'ci'], usage: '.채널정보 [#채널]', desc: '채널의 ID, 종류, 카테고리, 생성일, 슬로우모드, 잠금 여부를 봐요.', run: X2.channelInfo },

  // ── 방장 전용 (추가) ──
  { cat: '🏰 방장 전용', name: '비상', aliases: ['emergency', 'panic'], usage: '.비상 켜기 [시간]\n.비상 해제\n.비상 상태', desc: '서버가 공격받을 때 한 번에 막아요. **전체 채널 채팅 잠금 + 초대 링크 일시 중지 + 신규 입장자 자동 킥**. 시간을 안 쓰면 6시간(최대 24시간) 뒤 자동으로 모두 풀려요.', guildOwner: true, run: X2.emergency },
  { cat: '🏰 방장 전용', name: '초대정리', aliases: ['purgeinvites', '초대삭제'], usage: '.초대정리', desc: '서버에 만들어진 **모든 초대 링크를 삭제**해요. 레이드 뒤에 쓰면 좋아요. (서버 커스텀 URL은 그대로)', guildOwner: true, run: X2.purgeInvites },
  { cat: '🏰 방장 전용', name: '관리자목록', aliases: ['adminlist', '관리자점검'], usage: '.관리자목록', desc: '관리자 권한과 서버 관리·역할 관리·차단 같은 위험 권한을 가진 사람/봇을 모두 보여줘요.', guildOwner: true, run: X2.adminList },
  { cat: '🏰 방장 전용', name: '인증유저', aliases: ['authuser', '서버권한'], usage: '.인증유저 추가 @유저\n.인증유저 삭제 @유저\n.인증유저 목록', desc: '**이 서버에서만** 봇 명령어(방장·소유자 전용 제외)를 쓸 수 있는 사람을 관리해요. 등록된 사람은 자동 보안에서도 제외돼요.', guildOwner: true, run: X2.authUsers },
  { cat: '🏰 방장 전용', name: '서버비밀번호', aliases: ['serverpw', '서버비번'], usage: '.서버비밀번호 설정 <새 비밀번호>\n.서버비밀번호 변경 <현재> <새 비밀번호>\n.서버비밀번호 상태', desc: '서버폭파를 쓸 때 입력해야 하는 **서버 비밀번호**를 정해요. **관리자만 볼 수 있는 채널**에서만 등록되고, 입력한 메시지는 바로 지워요. 비밀번호는 암호화해서 저장해요. 바꿀 때는 현재 비밀번호가 필요하고, 5번 틀리면 30분 잠겨요.', guildOwner: true, run: X2.serverPassword },
  { cat: '🏰 방장 전용', name: '서버폭파', aliases: ['serverbomb', '서버이전'], usage: '.서버폭파 <서버 비밀번호>', desc: '⚠️ **서버 이전용.** 방장·이 봇·명령어를 쓴 사람을 뺀 **전체 멤버를 킥**하고 **모든 초대 링크를 삭제**해요. 관리자 전용 채널에서 **서버 비밀번호**를 입력하고, 한 번 더 `폭파확인` 을 입력해야 실행돼요. (방장 계정이 해킹돼도 비밀번호 없이는 못 써요)', guildOwner: true, run: X2.serverBomb },
  { cat: '🏰 방장 전용', name: '보안초기화', aliases: ['securityreset', '보안리셋'], usage: '.보안초기화', desc: '자동 보안 기능과 기준값(도배·멘션·계정나이 등)을 기본값으로 되돌려요. 금칙어·화이트리스트·경고 기록·로그 채널은 그대로예요.', guildOwner: true, run: X2.securityReset },

  // ── 소유자 전용 (추가) ──
  { cat: '👑 소유자 전용', name: '서버목록', aliases: ['guilds', 'serverlist'], usage: '.서버목록', desc: '봇이 들어가 있는 서버를 멤버 많은 순으로 보여줘요. (이름·인원·서버 ID·방장 ID)', ownerOnly: true, run: X2.guildList },
  { cat: '👑 소유자 전용', name: '서버나가기', aliases: ['leaveserver', '서버탈퇴'], usage: '.서버나가기 <서버ID>\n.서버나가기 <서버ID> 확인', desc: '봇을 그 서버에서 내보내요. 실수 방지를 위해 끝에 `확인` 을 붙여야 실제로 나가요.', ownerOnly: true, run: X2.leaveGuild },
  { cat: '👑 소유자 전용', name: '서버차단', aliases: ['guildban', '서버블랙리스트'], usage: '.서버차단 추가 <서버ID> [사유]\n.서버차단 제거 <서버ID>\n.서버차단 목록', desc: '특정 서버에는 봇이 못 들어오게 해요. 이미 들어가 있으면 나오고, 앞으로 초대돼도 자동으로 나가요.', ownerOnly: true, run: X2.guildBan },
  { cat: '👑 소유자 전용', name: '전체공지', aliases: ['broadcast', '방송'], usage: '.전체공지 <내용>', desc: '봇이 있는 모든 서버의 **로그 채널**로 공지를 보내요. 멘션은 울리지 않아요.', ownerOnly: true, run: X2.broadcast },
  { cat: '👑 소유자 전용', name: '상태설정', aliases: ['setstatus', '상태메시지'], usage: '.상태설정 <문구>\n.상태설정 초기화', desc: '봇 프로필에 표시되는 상태 문구를 바꿔요. 재시작해도 유지돼요.', ownerOnly: true, run: X2.setStatus },
  { cat: '👑 소유자 전용', name: '재시작', aliases: ['restart', 'reboot'], usage: '.재시작', desc: '데이터를 저장한 뒤 봇을 종료해요. Render 처럼 꺼진 프로세스를 자동으로 다시 켜주는 호스팅에서는 곧바로 다시 켜져요.', ownerOnly: true, run: X2.restart },
];

const HELP_NAMES = ['help', '도움말', '도움', '명령어', 'h'];

const AUTO_INFO = [
  '**스팸 방지** — 도배하면 메시지 삭제 + 10분 타임아웃',
  '**초대링크 차단** — discord.gg 등 초대 링크 삭제 + 경고',
  '**악성 링크 검사** — 신뢰 목록에 없는 링크는 봇이 직접 접속/분석해서 악성이면 메시지 삭제 + **1분 타임아웃**',
  '**멘션 도배 방지** — 멘션 5개 이상이면 삭제 + 10분 타임아웃',
  '**금칙어 필터** — 등록한 단어가 있으면 삭제 + 경고',
  '**디도스 방어** — 5분 안에 비슷한 이름(black 1, black 2 …) 5명이 들어오면 1명만 남기고 전부 밴. 남은 1명은 **경계 대상**',
  '**경계 대상** — 도배/초대/멘션도배/미검증 링크를 보내면 즉시 밴',
  '**레이드 방어** — 10초 안에 7명 이상 입장하면 2분간 신규 입장자 킥',
  '**테러 방어** — 채널·역할·웹훅·초대·대량 밴/킥을 30초 점수화. 4점부터 권한 회수·15분 타임아웃, 9점부터 복합 공격 자동 밴',
  '**경고 누적** — 3회 1시간 타임아웃, 5회 킥',
  '**반복 도배 방지** — 20초 안에 같은 말을 4번 보내면 삭제 + 10분 타임아웃',
  '**봇 추가 차단** — 방장·인증 유저·화이트리스트가 아닌 사람이 봇을 넣으면 그 봇을 바로 내보내요',
  '**위험 권한 감시** — 허가 없이 관리자/서버 관리/역할 관리 역할을 주면 자동으로 되돌려요',
  '**대량 처벌 감시** — 밴·킥·멤버 일괄 정리를 실행자별 30초 위험 점수에 합산해 즉시 격리/복합 공격 자동 밴을 시도해요',
  '**웹훅 차단** (기본 꺼짐) — `.보안 웹훅 켜기` 하면 허가 없이 만든 웹훅을 삭제해요',
];

function findCommand(name) {
  const n = name.toLowerCase();
  return commands.find((c) => c.name === n || c.aliases.includes(n));
}

const PERM_KO = {
  BanMembers: '멤버 차단하기', KickMembers: '멤버 추방하기', ModerateMembers: '멤버 타임아웃',
  ManageMessages: '메시지 관리', ManageChannels: '채널 관리', ManageGuild: '서버 관리',
  ManageRoles: '역할 관리', ManageNicknames: '닉네임 관리',
};

function permName(flag) {
  const entry = Object.entries(P).find(([, v]) => v === flag);
  return entry ? (PERM_KO[entry[0]] || entry[0]) : '특정 권한';
}

// 상세 도움말 (.도움말 <명령어>)
function detailPayload(arg) {
  const c = findCommand(arg.replace(/^\./, ''));
  if (!c) return { content: `❓ \`${arg}\` 명령어를 찾을 수 없어요. \`.도움말\`로 전체 목록을 확인해보세요.` };
  return {
    embeds: [new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`📖 .${c.name}`)
      .setDescription(c.desc)
      .addFields(
        { name: '사용법', value: '```\n' + c.usage + '\n```' },
        { name: '다른 이름', value: c.aliases.map((a) => `\`.${a}\``).join(' ') || '없음', inline: true },
        { name: '필요 권한', value: c.ownerOnly ? '봇 소유자 전용' : (c.backup || c.guildOwner) ? '서버 방장 · 봇 소유자' : c.perm ? permName(c.perm) : '누구나', inline: true },
      )],
  };
}

/* ───────────── 페이지 도움말 ─────────────
 * .도움 / .도움말 / .help  → 버튼(◀ ▶ ⏮ ⏭), 선택 메뉴, 홈/닫기 버튼으로 넘겨보는 도움말
 * .도움 <명령어>           → 그 명령어 자세히
 * .도움 검색 <단어>        → 이름/설명에서 검색
 * .도움 <분류>             → 해당 분류 페이지로 바로 열기 (예: .도움 처벌)
 */
const PER_PAGE = 4;          // 한 페이지에 보여줄 명령어 수
const HELP_IDLE_MS = 2 * 60 * 1000;   // 조작이 없으면 2분 뒤 버튼 비활성화
const HELP_MAX_MS = 10 * 60 * 1000;   // 최대 10분

function buildPages() {
  const cats = [...new Set(commands.map((c) => c.cat))];
  const pages = [{ type: 'home' }, { type: 'auto' }];
  for (const cat of cats) {
    const list = commands.filter((c) => c.cat === cat);
    const total = Math.ceil(list.length / PER_PAGE);
    for (let i = 0; i < total; i++) {
      pages.push({ type: 'cat', cat, list: list.slice(i * PER_PAGE, (i + 1) * PER_PAGE), part: i + 1, parts: total });
    }
  }
  return { pages, cats };
}

function renderPage(pages, cats, idx) {
  const pg = pages[idx];
  const N = pages.length;
  const footer = { text: `페이지 ${idx + 1} / ${N}  ·  .도움 <명령어> 자세히  ·  .도움 검색 <단어>` };

  if (pg.type === 'home') {
    const toc = [`**🤖 자동 보안** — ${2}페이지`];
    for (const cat of cats) {
      const idxs = pages.map((p, i) => (p.cat === cat ? i + 1 : null)).filter(Boolean);
      const count = commands.filter((c) => c.cat === cat).length;
      toc.push(`**${cat}** — ${count}개 · ${idxs.length > 1 ? `${idxs[0]}~${idxs[idxs.length - 1]}` : idxs[0]}페이지`);
    }
    return new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🛡️ 보안 봇 도움말')
      .setDescription(
        `접두사는 \`${PREFIX}\` 이고 명령어는 총 **${commands.length}개**예요.\n` +
        '아래 **◀ ▶ 버튼**으로 넘기거나 **메뉴**에서 분류를 골라 바로 이동해요.\n\n' +
        '**📚 목차**\n' + toc.join('\n') +
        '\n\n**💡 팁**\n' +
        '• `.도움 타임아웃` — 명령어 자세히\n' +
        '• `.도움 검색 밴` — 이름/설명 검색\n' +
        '• `.도움 처벌` — 분류로 바로 이동'
      )
      .setFooter(footer);
  }

  if (pg.type === 'auto') {
    return new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('🤖 항상 작동하는 자동 보안')
      .setDescription(AUTO_INFO.map((x) => `• ${x}`).join('\n'))
      .addFields({ name: '설정은 어디서?', value: '`.보안 상태`로 현재 상태를 보고, `.보안 <기능> <켜기|끄기>` 로 조절해요. `.보안점검`으로 허술한 곳을 찾을 수도 있어요.' })
      .setFooter(footer);
  }

  const fields = pg.list.map((c) => ({
    name: `.${c.name}${c.aliases.length ? `  (${c.aliases.slice(0, 3).map((a) => '.' + a).join(' ')})` : ''}`.slice(0, 256),
    value: (`${c.desc}\n\`\`\`\n${c.usage}\n\`\`\`🔑 ${c.ownerOnly ? '봇 소유자 전용' : (c.backup || c.guildOwner) ? '서버 방장 · 봇 소유자' : c.perm ? permName(c.perm) : '누구나'}`).slice(0, 1024),
  }));
  return new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle(`${pg.cat}${pg.parts > 1 ? `  (${pg.part}/${pg.parts})` : ''}`)
    .addFields(fields)
    .setFooter(footer);
}

function renderComponents(pages, cats, idx, disabled = false) {
  const N = pages.length;
  const cur = pages[idx];
  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('help:first').setEmoji('⏮️').setStyle(ButtonStyle.Secondary).setDisabled(disabled || idx === 0),
    new ButtonBuilder().setCustomId('help:prev').setEmoji('◀️').setStyle(ButtonStyle.Primary).setDisabled(disabled || idx === 0),
    new ButtonBuilder().setCustomId('help:page').setLabel(`${idx + 1} / ${N}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId('help:next').setEmoji('▶️').setStyle(ButtonStyle.Primary).setDisabled(disabled || idx === N - 1),
    new ButtonBuilder().setCustomId('help:last').setEmoji('⏭️').setStyle(ButtonStyle.Secondary).setDisabled(disabled || idx === N - 1),
  );

  const curKey = cur.type === 'cat' ? 'cat:' + cur.cat : cur.type;
  const options = [
    { label: '홈 (목차)', value: 'home', emoji: '🏠' },
    { label: '자동 보안 안내', value: 'auto', emoji: '🤖' },
    ...cats.map((c) => {
      const m = c.match(/^(\S+)\s+(.*)$/);
      return { label: m ? m[2] : c, value: 'cat:' + c, emoji: m ? m[1] : undefined, description: `${commands.filter((x) => x.cat === c).length}개 명령어` };
    }),
  ].map((o) => ({ ...o, default: o.value === curKey }));
  const menu = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('help:select').setPlaceholder('분류를 골라 바로 이동').addOptions(options).setDisabled(disabled),
  );

  const tools = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('help:home').setLabel('홈').setEmoji('🏠').setStyle(ButtonStyle.Secondary).setDisabled(disabled || idx === 0),
    new ButtonBuilder().setCustomId('help:close').setLabel('닫기').setEmoji('✖️').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
  return [nav, menu, tools];
}

async function openPager(message, startIdx = 0) {
  const { pages, cats } = buildPages();
  let idx = Math.min(Math.max(startIdx, 0), pages.length - 1);
  const noPing = { repliedUser: false };
  const sent = await message.reply({
    embeds: [renderPage(pages, cats, idx)],
    components: renderComponents(pages, cats, idx),
    allowedMentions: noPing,
  });

  const collector = sent.createMessageComponentCollector({ idle: HELP_IDLE_MS, time: HELP_MAX_MS });
  collector.on('collect', async (i) => {
    if (i.user.id !== message.author.id) {
      return i.reply({ content: '🚫 명령어를 입력한 사람만 넘길 수 있어요. 직접 `.도움`을 입력해보세요!', flags: 64 }).catch(() => {});
    }
    const id = i.customId;
    if (id === 'help:close') { collector.stop('closed'); return i.message.delete().catch(() => {}); }
    if (id === 'help:first' || id === 'help:home') idx = 0;
    else if (id === 'help:prev') idx = Math.max(0, idx - 1);
    else if (id === 'help:next') idx = Math.min(pages.length - 1, idx + 1);
    else if (id === 'help:last') idx = pages.length - 1;
    else if (id === 'help:select') {
      const v = i.values[0];
      const target = v === 'home' ? 0 : v === 'auto' ? 1 : pages.findIndex((p) => p.type === 'cat' && 'cat:' + p.cat === v);
      if (target >= 0) idx = target;
    }
    await i.update({ embeds: [renderPage(pages, cats, idx)], components: renderComponents(pages, cats, idx) }).catch(() => {});
  });
  collector.on('end', (_c, reason) => {
    if (reason === 'closed') return;
    sent.edit({ components: renderComponents(pages, cats, idx, true) }).catch(() => {});
  });
}

// 키워드 검색 (.도움 검색 <단어>)
function searchPayload(q) {
  const k = q.toLowerCase();
  const hits = commands.filter((c) =>
    [c.name, ...c.aliases, c.desc, c.usage, c.cat].join(' ').toLowerCase().includes(k));
  if (!hits.length) return { content: `🔍 \`${q}\` 와(과) 관련된 명령어를 찾지 못했어요. \`.도움\`으로 전체를 넘겨보세요.` };
  const lines = hits.slice(0, 12).map((c) => `**.${c.name}** — ${c.desc.length > 70 ? c.desc.slice(0, 70) + '…' : c.desc}`);
  return {
    embeds: [new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`🔍 "${q.slice(0, 40)}" 검색 결과 ${hits.length}개`)
      .setDescription(lines.join('\n') + (hits.length > 12 ? `\n…외 ${hits.length - 12}개` : ''))
      .setFooter({ text: '자세히 보려면 .도움 <명령어>' })],
  };
}

async function sendHelp(message, args) {
  const noPing = { repliedUser: false };
  const arg = (args[0] || '').replace(/^\./, '');
  if (!arg) return openPager(message, 0);

  if (['검색', 'search', 's'].includes(arg.toLowerCase())) {
    const q = args.slice(1).join(' ').trim();
    if (!q) return message.reply({ content: '사용법: `.도움 검색 <단어>` (예: `.도움 검색 밴`)', allowedMentions: noPing });
    return message.reply({ ...searchPayload(q), allowedMentions: noPing });
  }

  // 분류 이름으로 바로 열기 (.도움 처벌)
  const { pages } = buildPages();
  const catHit = pages.findIndex((p) => p.type === 'cat' && p.cat.replace(/^\S+\s+/, '').replace(/\s/g, '').includes(arg.replace(/\s/g, '')) && arg.length >= 2 && !findCommand(arg));
  if (catHit >= 0) return openPager(message, catHit);

  // 명령어 자세히 → 없으면 검색 결과로
  if (findCommand(arg)) return message.reply({ ...detailPayload(arg), allowedMentions: noPing });
  return message.reply({ ...searchPayload(args.join(' ')), allowedMentions: noPing });
}

/* 메시지가 명령어면 실행하고 true 반환 */
async function handleCommand(message) {
  if (!message.content.startsWith(PREFIX)) return false;
  const [raw, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  if (!raw) return false;
  const name = raw.toLowerCase();

  try {
    const isHelp = HELP_NAMES.includes(name);
    const cmd = isHelp ? null : findCommand(name);
    if (!isHelp && !cmd) return false;

    // public 명령어(주사위/동전 등)는 누구나 쓸 수 있어요. 대신 1인당 3초 쿨다운
    if (cmd?.public) {
      const last = publicCool.get(message.author.id) || 0;
      if (Date.now() - last < 3000) return true;
      publicCool.set(message.author.id, Date.now());
      if (publicCool.size > 2000) for (const [k, t] of publicCool) if (Date.now() - t > 60000) publicCool.delete(k);
    }

    // 격리 관리 명령은 이 서버의 관리자도 사용할 수 있어요.
    const isQuarantineAdminCommand = ['격리목록', '격리해제'].includes(cmd?.name) &&
      (message.author.id === message.guild?.ownerId || message.member?.permissions?.has(P.Administrator) || message.member?.permissions?.has(P.ManageGuild));
    // 인증된 유저만 명령어를 쓸 수 있어요: 봇 관리자 + 이 서버의 방장(자동) + 이 서버의 인증 유저(봇을 추가한 사람 등)
    if (!cmd?.public && !isQuarantineAdminCommand && !isAuthed(message.author.id, message.guild)) {
      await message.reply({ content: '🚫 이 봇은 인증된 유저만 사용할 수 있어요.', allowedMentions: { repliedUser: false } });
      return true;
    }

    // 서버백업/서버복원/서버백업정보: 서버 방장과 봇 소유자만
    if ((cmd?.backup || cmd?.guildOwner) && !canBackup(message.author.id, message.guild)) {
      await message.reply({ content: '🚫 이 명령어는 이 서버의 방장과 봇 소유자만 쓸 수 있어요.', allowedMentions: { repliedUser: false } });
      return true;
    }

    if (cmd?.ownerOnly && !isOwner(message.author.id)) {
      await message.reply({ content: '🚫 이 명령어는 봇 소유자만 쓸 수 있어요.', allowedMentions: { repliedUser: false } });
      return true;
    }

    if (isHelp) {
      await sendHelp(message, args);
      return true;
    }

    const result = await cmd.run(message, args);
    if (!result) return true;   // 결과를 직접 DM 등으로 보낸 명령어 (예: 서버복원은 채널이 사라져요)
    const payload = typeof result === 'string' ? { content: result } : result;
    const sent = await message.channel.send({ ...payload, allowedMentions: { parse: [] } });
    if (cmd.temp) setTimeout(() => sent.delete().catch(() => {}), cmd.temp * 1000);
  } catch (err) {
    console.error(`[명령어 오류] ${name}:`, err);
    const msg = err.code === 50013 ? '봇에게 필요한 권한이 없어요. 봇 역할 권한/순서를 확인해주세요.' : err.message || '알 수 없는 오류';
    await message.channel.send(`❌ 오류: ${msg}`).catch(() => {});
  }
  return true;
}

module.exports = { handleCommand, commands, PREFIX };
