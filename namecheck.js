// namecheck.js - 비슷한 이름 판별 (예: black 1, black 2, black_3 ...)
// discord.js 에 의존하지 않는 순수 함수 모음

// 이름을 비교용 키로 변환: 소문자 + 특수문자/공백 제거 + 끝 숫자 제거
function toKey(name) {
  return String(name || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .replace(/\d+$/, '');
}

// 유저네임 / 표시이름 둘 다 키로 만들어서 반환
function nameKeys(username, globalName) {
  const keys = new Set();
  for (const n of [username, globalName]) {
    const k = toKey(n);
    if (k.length >= 3) keys.add(k);
  }
  return [...keys];
}

function lev(a, b) {
  if (a === b) return 0;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

// 두 키가 "사실상 같은 이름"인지: 완전히 같거나, 4글자 이상이면 1글자 차이까지 허용
function similar(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4) return false;
  return lev(a, b) <= 1;
}

function keysSimilar(keysA, keysB) {
  return keysA.some((a) => keysB.some((b) => similar(a, b)));
}

module.exports = { toKey, nameKeys, similar, keysSimilar, lev };
