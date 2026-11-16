// linkscan.js - 링크 안전 검사기
// 1) 신뢰 도메인은 통과  2) 주소 모양 분석  3) 실제로 접속해서 리디렉션/다운로드/피싱 페이지 분석
// 4) (선택) 환경변수 GSB_API_KEY 가 있으면 Google Safe Browsing 조회
// ※ 100% 판별은 불가능해요. "악성 징후 점수"가 50점 이상이면 악성으로 판단합니다.
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

const THRESHOLD = 50;
const MAX_BODY = 128 * 1024;
const SAFE_PORTS = ['80', '443', '8080', '8443'];
const REQUEST_TIMEOUT_MS = 3800;
const RESOLVE_TIMEOUT_MS = 12000;
const MAX_REDIRECTS = 12;
const RESOLVE_CACHE_TTL_MS = 12 * 1000;
const MAX_RESOLVE_CACHE = 400;

/* ───────────── 신뢰 도메인 (서버별로 .신뢰링크 로 추가 가능) ───────────── */
const TRUSTED_DEFAULT = [
  'discord.com', 'discordapp.com', 'discordapp.net', 'discord.media',
  'youtube.com', 'youtu.be', 'github.com', 'githubusercontent.com', 'google.com',
  'naver.com', 'daum.net', 'kakao.com', 'wikipedia.org', 'wikimedia.org', 'namu.wiki',
  'twitter.com', 'x.com', 'twitch.tv', 'reddit.com', 'imgur.com', 'tenor.com', 'giphy.com',
  'spotify.com', 'steamcommunity.com', 'steampowered.com', 'roblox.com', 'microsoft.com',
  'apple.com', 'anthropic.com', 'claude.ai', 'notion.so', 'instagram.com', 'facebook.com',
  'tiktok.com', 'stackoverflow.com', 'op.gg',
];

// 브랜드 사칭 검사용 (이 단어가 들어갔는데 공식 도메인이 아니면 의심)
const OFFICIAL = {
  discord: ['discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media'],
  steam: ['steamcommunity.com', 'steampowered.com', 'steamstatic.com'],
  roblox: ['roblox.com', 'rbxcdn.com'],
  paypal: ['paypal.com'],
  google: ['google.com', 'googleapis.com', 'gstatic.com'],
  microsoft: ['microsoft.com', 'live.com'],
  kakao: ['kakao.com', 'kakaocorp.com'],
  naver: ['naver.com', 'naver.net'],
  nexon: ['nexon.com'],
  instagram: ['instagram.com'],
};

const BAD_TLD = new Set(['zip', 'mov', 'tk', 'ml', 'ga', 'cf', 'gq', 'top', 'click', 'rest', 'country', 'loan', 'icu', 'cyou', 'cfd', 'sbs']);
const EXEC_EXT = /\.(exe|scr|bat|cmd|msi|jar|apk|vbs|vbe|ps1|jse|wsf|lnk|dll|hta|reg|pif)(\?|#|$|")/i;
const ARCHIVE_EXT = /\.(zip|rar|7z|iso|img)(\?|#|$|")/i;
const SLD = new Set(['co.kr', 'or.kr', 'go.kr', 'ne.kr', 'co.uk', 'org.uk', 'com.au', 'co.jp', 'com.br', 'com.cn', 'co.in']);

function regDomain(host) {
  const p = host.split('.');
  if (p.length <= 2) return host;
  const last2 = p.slice(-2).join('.');
  return SLD.has(last2) ? p.slice(-3).join('.') : last2;
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

/* ───────────── URL 추출 ───────────── */
const URL_RE = /https?:\/\/[^\s<>()"'`]+|www\.[^\s<>()"'`]+|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b(?:\/[^\s<>()"'`]*)?/gi;

function extractUrls(text) {
  const out = new Set();
  for (const m of String(text || '').match(URL_RE) || []) {
    let s = m.replace(/[.,;:!?]+$/, '');
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    try {
      out.add(new URL(s).href);
    } catch { /* 무시 */ }
    if (out.size >= 5) break;
  }
  return [...out];
}

function isTrusted(urlStr, extra = []) {
  let u;
  try { u = new URL(urlStr); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  if (EXEC_EXT.test(u.pathname)) return false; // 신뢰 도메인이어도 실행파일 링크는 검사
  const host = u.hostname.toLowerCase();
  return [...TRUSTED_DEFAULT, ...extra].some((d) => hostMatches(host, d));
}

function defang(url) {
  return String(url).replace(/^http/i, 'hxxp').replace(/\./g, '[.]');
}

/* ───────────── 주소 모양 분석 (접속 없이) ───────────── */
function staticScore(urlStr) {
  const reasons = [];
  let score = 0;
  const add = (n, r) => { score += n; reasons.push(r); };
  let u;
  try { u = new URL(urlStr); } catch { return { score: 0, reasons: ['잘못된 주소'] }; }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const pathAll = (u.pathname + u.search).toLowerCase();

  if (net.isIP(host)) add(35, 'IP 주소로 직접 접속하는 링크');
  if (host.includes('xn--')) add(30, '비슷한 글자로 위장한 도메인(퓨니코드)');
  if (u.username || u.password) add(30, '주소에 @ 를 넣어 다른 사이트처럼 속이는 형태');
  const tld = host.split('.').pop();
  if (BAD_TLD.has(tld)) add(20, `악용이 잦은 도메인 확장자 (.${tld})`);
  if (host.split('.').length >= 5) add(10, '비정상적으로 긴 서브도메인');
  if (u.port && !SAFE_PORTS.includes(u.port)) add(15, `비표준 포트(${u.port})`);

  // 브랜드 사칭 (disc0rd, d1scord, dlscord, discord-nitro.xyz ...)
  const reg = regDomain(host);
  const variants = new Set([
    host,
    host.replace(/0/g, 'o').replace(/[1!]/g, 'i'),
    host.replace(/1/g, 'l'),
    host.replace(/l/g, 'i'),
    host.replace(/rn/g, 'm'),
  ]);
  for (const [brand, officials] of Object.entries(OFFICIAL)) {
    const hit = [...variants].some((v) => v.includes(brand));
    if (hit && !officials.some((d) => reg === d || hostMatches(host, d))) {
      add(45, `'${brand}' 공식 사이트를 사칭한 도메인으로 보여요`);
      break;
    }
  }

  if (/(free|gift|claim|airdrop|giveaway|nitro|verify|login|signin|wallet|reward|bonus)/.test(host + pathAll)) {
    add(20, '피싱에 자주 쓰이는 단어(free/gift/claim/verify 등) 포함');
  }
  if (EXEC_EXT.test(u.pathname)) add(60, '실행 파일(.exe 등) 다운로드 링크');
  else if (ARCHIVE_EXT.test(u.pathname)) add(25, '압축/이미지 파일 다운로드 링크');
  return { score, reasons };
}

/* ───────────── 안전한 접속 (SSRF 방어 + 엄격한 요청 제한) ───────────── */
function ipv4ToNumber(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function inV4Range(ip, base, prefix) {
  const value = ipv4ToNumber(ip);
  const network = ipv4ToNumber(base);
  if (value === null || network === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (network & mask);
}

function isPrivateIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) {
    // 비공개, 루프백, 링크로컬, 공유 주소, 문서용, 벤치마크, 멀티캐스트 및 예약 대역.
    const blocked = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ];
    return blocked.some(([base, prefix]) => inV4Range(ip, base, prefix));
  }
  if (version === 6) {
    const value = ip.toLowerCase().split('%')[0];
    if (value === '::' || value === '::1') return true;
    // IPv4-mapped IPv6 (점 표기 및 16진수 표기 모두 처리).
    if (value.startsWith('::ffff:')) {
      const tail = value.slice(7);
      if (net.isIPv4(tail)) return isPrivateIp(tail);
      const words = tail.split(':');
      if (words.length === 2 && words.every((x) => /^[0-9a-f]{1,4}$/.test(x))) {
        const a = parseInt(words[0], 16), b = parseInt(words[1], 16);
        return isPrivateIp([a >> 8, a & 255, b >> 8, b & 255].join('.'));
      }
      return true;
    }
    // 전역 유니캐스트(2000::/3) 외의 IPv6는 외부 URL 검사 요청에서 차단.
    if (!/^[23][0-9a-f]{3}:/.test(value)) return true;
    if (value.startsWith('2001:db8:') || value.startsWith('2002:') || /^2001:(?:0:|0000:)/.test(value)) return true;
    return false;
  }
  return true;
}

function isBlockedHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return !host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
    host.endsWith('.internal') || host.endsWith('.home.arpa') || host.endsWith('.test') ||
    host === 'metadata.google.internal' || host === 'metadata';
}

function validateHttpUrl(value) {
  let u;
  try { u = value instanceof URL ? value : new URL(value); } catch { return { ok: false, reason: '잘못된 URL' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: 'HTTP/HTTPS 주소만 처리할 수 있어요' };
  if (u.username || u.password) return { ok: false, reason: '사용자 정보가 포함된 URL은 안전상 처리하지 않아요' };
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isBlockedHostname(host)) return { ok: false, reason: '로컬/내부 전용 호스트는 접속하지 않아요' };
  if (net.isIP(host) && isPrivateIp(host)) return { ok: false, reason: '내부망/예약 IP 주소는 접속하지 않아요' };
  if (u.port && !SAFE_PORTS.includes(u.port)) return { ok: false, reason: `허용되지 않은 포트(${u.port})예요` };
  return { ok: true, url: u };
}

// DNS 응답에 사설 IP가 하나라도 섞이면 전체 연결을 거부해 DNS rebinding을 방어합니다.
function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { all: true, verbatim: true, family: options?.family || 0 }, (err, addresses) => {
    if (err) return cb(err);
    if (!Array.isArray(addresses) || addresses.length === 0) return cb(new Error('DNS_EMPTY'));
    if (addresses.some((entry) => isPrivateIp(entry.address))) return cb(new Error('PRIVATE_IP'));
    if (options?.all) return cb(null, addresses);
    const first = addresses.find((entry) => !options?.family || entry.family === options.family) || addresses[0];
    cb(null, first.address, first.family);
  });
}

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 24, maxFreeSockets: 8, timeout: 5000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 24, maxFreeSockets: 8, timeout: 5000 });

function request(u, requestOptions = {}) {
  const checked = validateHttpUrl(u);
  if (!checked.ok) return Promise.reject(new Error(checked.reason));
  const target = checked.url;
  return new Promise((resolve, reject) => {
    const lib = target.protocol === 'https:' ? https : http;
    let settled = false;
    let received = 0;
    const chunks = [];
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(result);
    };
    const req = lib.request(target, {
      method: 'GET',
      lookup: safeLookup,
      agent: target.protocol === 'https:' ? httpsAgent : httpAgent,
      timeout: REQUEST_TIMEOUT_MS,
      maxHeaderSize: 16 * 1024,
      maxHeaderCount: 50,
      signal: requestOptions.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SecuarityLinkScanner/2.6.2)',
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.7',
        'Accept-Encoding': 'identity',
        Connection: 'keep-alive',
      },
    }, (res) => {
      const onDone = (truncated = false) => finish(null, {
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        bodyTruncated: truncated,
      });
      res.on('data', (chunk) => {
        if (settled) return;
        const remaining = MAX_BODY - received;
        if (remaining > 0) {
          const part = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
          chunks.push(part);
          received += part.length;
        }
        if (received >= MAX_BODY) {
          onDone(true);
          res.destroy();
        }
      });
      res.on('end', () => onDone(false));
      res.on('error', (err) => finish(err));
      res.on('aborted', () => finish(new Error('RESPONSE_ABORTED')));
    });
    req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
    req.on('error', (err) => finish(err));
    req.end();
  });
}

function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* ignore */ }
      reject(new Error('TOTAL_TIMEOUT'));
    }, ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

/* ───────────── 바이패스: 일반 URL의 안전한 리디렉션 추적 ───────────── */

async function safeBrowsing(url) {
  const key = process.env.GSB_API_KEY;
  if (!key) return false;
  try {
    const res = await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(4000),
      body: JSON.stringify({
        client: { clientId: 'security-bot', clientVersion: '2.0' },
        threatInfo: {
          threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
          platformTypes: ['ANY_PLATFORM'],
          threatEntryTypes: ['URL'],
          threatEntries: [{ url }],
        },
      }),
    });
    const data = await res.json();
    return Boolean(data.matches?.length);
  } catch {
    return false;
  }
}

/* ───────────── 메인: 링크 검사 ───────────── */
const cache = new Map(); // url -> {at, result}

async function scanUrl(rawUrl, extraTrusted = []) {
  const checked = validateHttpUrl(rawUrl);
  if (!checked.ok) return { url: rawUrl, finalUrl: rawUrl, score: 60, malicious: true, trusted: false, visited: false, reasons: [checked.reason] };
  rawUrl = checked.url.href;
  const hit = cache.get(rawUrl);
  if (hit && Date.now() - hit.at < 2 * 60 * 1000) return hit.result;

  let u;
  try { u = new URL(rawUrl); } catch {
    return { url: rawUrl, finalUrl: rawUrl, score: 0, malicious: false, trusted: false, visited: false, reasons: ['잘못된 주소'] };
  }

  if (isTrusted(rawUrl, extraTrusted)) {
    return { url: rawUrl, finalUrl: rawUrl, score: 0, malicious: false, trusted: true, visited: false, reasons: ['신뢰 도메인'] };
  }

  const st = staticScore(rawUrl);
  let score = st.score;
  const reasons = [...st.reasons];
  const add = (n, r) => { score += n; reasons.push(r); };
  let visited = false;
  let finalUrl = rawUrl;

  // Safe Browsing 조회와 페이지 분석을 병렬로 실행해 전체 대기 시간을 줄입니다.
  const gsbPromise = safeBrowsing(rawUrl);

  // 이미 확실히 악성이면 페이지에 접속하지 않아요.
  if (score < THRESHOLD) {
    const scanController = new AbortController();
    try {
      await withTimeout((async () => {
        let current = u;
        for (let hop = 0; hop <= 7; hop++) {
          const currentCheck = validateHttpUrl(current);
          if (!currentCheck.ok) { add(60, `안전하지 않은 이동 대상: ${currentCheck.reason}`); return; }

          let res;
          try {
            res = await request(current, { signal: scanController.signal });
          } catch (e) {
            if (e.message === 'PRIVATE_IP') add(60, '도메인이 내부망 주소를 가리켜요');
            else reasons.push('사이트에 접속하지 못했어요');
            return;
          }
          visited = true;

          if (res.status >= 300 && res.status < 400 && res.headers.location) {
            let next;
            try { next = new URL(res.headers.location, current); } catch { return; }
            const nextCheck = validateHttpUrl(next);
            if (!nextCheck.ok) { add(60, `안전하지 않은 리디렉션: ${nextCheck.reason}`); return; }
            if (regDomain(next.hostname) !== regDomain(current.hostname)) {
              reasons.push(`다른 도메인으로 이동: ${defang(next.hostname)}`);
              // 이동한 곳의 주소도 검사
              const s2 = staticScore(next.href);
              if (s2.score) { score += s2.score; reasons.push(...s2.reasons); }
            }
            current = next;
            finalUrl = next.href;
            if (isTrusted(finalUrl, extraTrusted)) { reasons.push('신뢰 도메인으로 연결돼요'); return; }
            continue;
          }

          // 응답 분석
          const ct = String(res.headers['content-type'] || '').toLowerCase();
          const cd = String(res.headers['content-disposition'] || '').toLowerCase();
          if (/attachment/.test(cd) && (EXEC_EXT.test(cd) || ARCHIVE_EXT.test(cd))) add(60, '실행/압축 파일을 강제로 내려받게 해요');
          if (/application\/(x-msdownload|x-msdos-program|vnd\.microsoft\.portable-executable|x-dosexec|java-archive|vnd\.android\.package-archive|x-sh|x-bat)/.test(ct)) {
            add(60, '실행 파일을 내려받게 해요');
          } else if (/octet-stream|zip|rar/.test(ct)) {
            add(25, '접속하자마자 파일 다운로드를 시작해요');
          }

          if (ct.includes('html') || ct.includes('text')) {
            const html = res.body.toLowerCase();
            const hasPw = /<input[^>]+type\s*=\s*["']?password/.test(html);
            const brand = ['discord', 'steam', 'roblox', 'paypal', 'google', 'microsoft', 'kakao', 'naver', 'nitro', 'bank'].find((b) => html.includes(b));
            if (hasPw) {
              if (brand) add(50, `'${brand}' 로그인 화면처럼 꾸민 비밀번호 입력창`);
              else add(20, '알 수 없는 사이트의 비밀번호 입력창');
            }
            if (/(win(dows)?\s*\+\s*r|powershell\s+-|mshta|cmd\s*\/c)/.test(html) && /(verify|human|captcha|robot|인증)/.test(html)) {
              add(50, '명령어를 복사해 실행시키려는 악성 안내(ClickFix)');
            }
            if (/eval\s*\(\s*(atob|unescape)|atob\(["'][a-z0-9+\/=]{200,}|function\(p,a,c,k,e/.test(html)) add(25, '난독화된 의심 스크립트');
            if (/<meta[^>]+http-equiv\s*=\s*["']?refresh/.test(html)) add(10, '자동으로 다른 페이지로 넘겨요');
          }
          return;
        }
        add(10, '리디렉션이 너무 많아요');
      })(), 10000, () => scanController.abort());
    } catch {
      reasons.push('검사 시간이 초과됐어요');
    }
  }

  if (await gsbPromise) add(100, 'Google Safe Browsing 에 위험 사이트로 등록됨');

  const result = {
    url: rawUrl,
    finalUrl,
    score,
    malicious: score >= THRESHOLD,
    trusted: false,
    visited,
    reasons: [...new Set(reasons)],
  };
  cache.set(rawUrl, { at: Date.now(), result });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return result;
}

module.exports = { extractUrls, isTrusted, scanUrl, staticScore, defang, regDomain, isPrivateIp, TRUSTED_DEFAULT, THRESHOLD, validateHttpUrl };

