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
  if (quota.subscription?.activeUntil) {
    user.subscription = quota.subscription;
  } else if (!quota.unlimited) {
    user.subscription = user.subscription?.activeUntil > Date.now() ? user.subscription : null;
  }
  if (quota.paymentPending?.status === 'pending') {
    user.paymentPending = quota.paymentPending;
  } else if (quota.unlimited) {
    user.paymentPending = null;
  }
  saveUser(user);
  return user;
}

export function formatQuotaText(quota) {
  if (!quota) return '加载中…';
  if (quota.unlimited) {
    const until = quota.subscription?.activeUntil
      ? new Date(quota.subscription.activeUntil).toLocaleDateString('zh-CN')
      : '';
    return `会员不限次提问${until ? `（至 ${until}）` : ''}`;
  }
  if (quota.paymentPending?.status === 'pending') {
    return '汇款核实中，核实通过后将不限次数提问';
  }
  return `24 小时内还可提问 ${quota.remaining}/${quota.limit} 次`;
}

/** 与 PC profile.html #subscription-detail 一致 */
export function formatSubscriptionDetail(quota) {
  if (!quota) return '';
  if (quota.unlimited && quota.subscription) {
    const s = quota.subscription;
    const label = s.label || s.plan || '会员';
    const until = new Date(s.activeUntil).toLocaleString('zh-CN');
    return `已开通 ${label}，不限次数提问，有效期至 ${until}`;
  }
  if (quota.paymentPending?.status === 'pending') {
    const p = quota.paymentPending;
    return `已提交 ${p.planLabel || p.plan || ''} 汇款核实（¥${p.amount}）。核对到账后将开通 · 可在「我的账户」查看进度`;
  }
  return '超出后可办理月卡 ¥29 / 季卡 ¥79 / 年卡 ¥299';
}

export function isActiveMember(quota) {
  return !!(quota?.unlimited && quota?.subscription?.activeUntil > Date.now());
}

export function addStats(qCoins = 0, wisdom = 0, lineValue = 0) {
  const user = getUser();
  user.qCoins += qCoins;
  user.wisdom += wisdom;
  user.lineValue += lineValue;
  saveUser(user);
  return user;
}
