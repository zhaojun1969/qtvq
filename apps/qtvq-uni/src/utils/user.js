const USER_KEY = 'qtvq_user';

function defaultUser() {
  return {
    qCoins: 0,
    wisdom: 0,
    lineValue: 0,
    questionHistory: [],
  };
}

export function getUser() {
  try {
    const raw = uni.getStorageSync(USER_KEY);
    return { ...defaultUser(), ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return defaultUser();
  }
}

export function saveUser(user) {
  uni.setStorageSync(USER_KEY, JSON.stringify(user));
}

export function applyQuotaToUser(quota) {
  if (!quota) return getUser();
  const user = getUser();
  saveUser(user);
  return user;
}

export function formatQuotaText(quota) {
  if (!quota) return '加载中…';
  if (quota.unlimited) return '会员不限次提问';
  return `24 小时内还可提问 ${quota.remaining}/${quota.limit} 次`;
}

export function addStats(qCoins = 0, wisdom = 0, lineValue = 0) {
  const user = getUser();
  user.qCoins += qCoins;
  user.wisdom += wisdom;
  user.lineValue += lineValue;
  saveUser(user);
  return user;
}
