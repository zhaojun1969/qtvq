/** 提问额度：24 小时内最多 5 次；会员汇款核实后不限次 */

export const DAILY_ASK_LIMIT = 5;
export const WINDOW_MS = 24 * 60 * 60 * 1000;

export const COMPANY = {
  name: '我心永恒（北京）网络科技有限公司',
  account: '0200251109200028909',
  cardNo: '9558830200002033769',
  bank: '中国工商银行北京海淀西区马连洼支行',
};

export const PLANS = {
  month: { id: 'month', label: '月卡', price: 29, days: 30 },
  quarter: { id: 'quarter', label: '季卡', price: 79, days: 90 },
  year: { id: 'year', label: '年卡', price: 299, days: 365 },
};

const CLIENT_KEY = 'qtvq_client_id';

export function getClientId() {
  let id = localStorage.getItem(CLIENT_KEY);
  if (!id) {
    id = `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(CLIENT_KEY, id);
  }
  return id;
}

function pruneTimestamps(timestamps, now = Date.now()) {
  const cutoff = now - WINDOW_MS;
  return (timestamps || []).filter((t) => t > cutoff);
}

export function hasUnlimitedSubscription(user) {
  const sub = user?.subscription;
  return sub?.activeUntil && sub.activeUntil > Date.now();
}

export function getQuotaStatus(user) {
  const now = Date.now();
  const timestamps = pruneTimestamps(user.questionTimestamps, now);
  const unlimited = hasUnlimitedSubscription(user);
  const used = timestamps.length;
  const remaining = unlimited ? null : Math.max(0, DAILY_ASK_LIMIT - used);
  const oldest = timestamps.length ? Math.min(...timestamps) : null;
  const resetAt = oldest ? oldest + WINDOW_MS : null;

  return {
    unlimited,
    used,
    remaining,
    limit: DAILY_ASK_LIMIT,
    resetAt,
    subscription: user.subscription || null,
    paymentPending: user.paymentPending || null,
  };
}

export function canAskNewQuestion(user) {
  if (hasUnlimitedSubscription(user)) return { ok: true };
  const { remaining } = getQuotaStatus(user);
  if (remaining > 0) return { ok: true };
  return {
    ok: false,
    reason: 'quota',
    resetAt: getQuotaStatus(user).resetAt,
  };
}

export function recordNewQuestionAsk(user) {
  const timestamps = pruneTimestamps(user.questionTimestamps);
  timestamps.push(Date.now());
  user.questionTimestamps = timestamps;
  return user;
}

export function activateSubscription(user, planId) {
  const plan = PLANS[planId];
  if (!plan) return user;
  const base = Math.max(Date.now(), user.subscription?.activeUntil || 0);
  user.subscription = {
    plan: planId,
    label: plan.label,
    activeUntil: base + plan.days * 24 * 60 * 60 * 1000,
    activatedAt: Date.now(),
  };
  user.paymentPending = null;
  return user;
}

export function setPaymentPending(user, payload) {
  user.paymentPending = {
    ...payload,
    status: 'pending',
    submittedAt: Date.now(),
  };
  return user;
}

/** 距离下一档免费额度恢复的文案 */
export function formatResetCountdown(resetAt, now = Date.now()) {
  if (!resetAt || resetAt <= now) return '';
  const diff = resetAt - now;
  const h = Math.floor(diff / 3600000);
  const m = Math.ceil((diff % 3600000) / 60000);
  if (h > 0) return `约 ${h} 小时 ${m} 分钟后恢复免费额度`;
  return `约 ${m} 分钟后恢复免费额度`;
}

/** 额度状态一行文案（供 UI 绑定） */
export function formatQuotaStatusText(user) {
  const q = getQuotaStatus(user);
  if (q.unlimited) {
    const until = user.subscription?.activeUntil
      ? new Date(user.subscription.activeUntil).toLocaleDateString('zh-CN')
      : '';
    return `会员不限次提问${until ? `（至 ${until}）` : ''}`;
  }
  if (user.paymentPending?.status === 'pending') {
    return '汇款核实中，核实通过后将不限次数提问';
  }
  let text = `24 小时内还可提问 ${q.remaining}/${q.limit} 次`;
  if (q.remaining === 0 && q.resetAt) {
    const cd = formatResetCountdown(q.resetAt);
    if (cd) text += ` · ${cd}`;
  }
  return text;
}
