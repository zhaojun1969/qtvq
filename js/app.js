/** 我心永恒-Q问 主逻辑 */

import { apiUrl } from './config.js';

import {
  getClientId,
  canAskNewQuestion,
  recordNewQuestionAsk,
  getQuotaStatus,
  activateSubscription,
  setPaymentPending,
  formatQuotaStatusText,
  WINDOW_MS,
} from './quota.js';

export { getClientId, getQuotaStatus, activateSubscription, formatQuotaStatusText } from './quota.js';

const STORAGE_KEY = 'qtvq_user';

function defaultUser() {
  return {
    qCoins: 0,
    wisdom: 0,
    lineValue: 0,
    pioneerAsksLeft: 10,
    isPioneer: true,
    questionHistory: [],
    questionTimestamps: [],
    subscription: null,
    paymentPending: null,
    browseCategories: {},
    fateAuth: false,
    adoptedCount: 0,
    invited: false,
    pioneerRegistered: false,
  };
}

export function getUser() {
  try {
    const u = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return { ...defaultUser(), ...u };
  } catch {
    return defaultUser();
  }
}

export function saveUser(user) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
}

export function updateStats(qCoins = 0, wisdom = 0, lineValue = 0) {
  const user = getUser();
  user.qCoins += qCoins;
  user.wisdom += wisdom;
  user.lineValue += lineValue;
  saveUser(user);
  refreshStatUI(user);
  return user;
}

export function recordQuestion(text) {
  const user = getUser();
  const t = text.slice(0, 80);
  user.questionHistory = [t, ...user.questionHistory.filter((q) => q !== t)].slice(0, 20);
  const keywords = ['暧昧', '网恋', '冷暴力', '出轨', '彩礼', '相亲', '异地'];
  keywords.forEach((k) => {
    if (t.includes(k)) user.browseCategories[k] = (user.browseCategories[k] || 0) + 2;
  });
  saveUser(user);
}

export function recordBrowse(category) {
  const user = getUser();
  user.browseCategories[category] = (user.browseCategories[category] || 0) + 1;
  saveUser(user);
}

export function usePioneerAsk() {
  const user = getUser();
  if (user.pioneerAsksLeft > 0) {
    user.pioneerAsksLeft -= 1;
    saveUser(user);
  }
  return user.pioneerAsksLeft;
}

export function adoptSuggestion() {
  const user = getUser();
  user.adoptedCount = (user.adoptedCount || 0) + 1;
  saveUser(user);
  updateStats(0, 3, 5);
  return user.adoptedCount;
}

export function refreshStatUI(user = getUser()) {
  document.querySelectorAll('[data-q-coins]').forEach((el) => {
    el.textContent = user.qCoins;
  });
  document.querySelectorAll('[data-wisdom]').forEach((el) => {
    el.textContent = user.wisdom;
  });
  document.querySelectorAll('[data-line-value]').forEach((el) => {
    el.textContent = user.lineValue;
  });
  document.querySelectorAll('[data-pioneer-left]').forEach((el) => {
    el.textContent = user.pioneerAsksLeft;
  });
  refreshQuotaUI(user);
  const progress = document.getElementById('unlock-progress');
  if (progress) {
    const pct = Math.min(100, ((user.qCoins + user.wisdom) / 200) * 100);
    progress.style.width = `${pct}%`;
  }
}

export function refreshQuotaUI(user = getUser()) {
  const q = getQuotaStatus(user);
  const statusText = formatQuotaStatusText(user);
  document.querySelectorAll('[data-quota-remaining]').forEach((el) => {
    el.textContent = q.unlimited ? '不限' : String(q.remaining ?? 0);
  });
  document.querySelectorAll('[data-quota-status]').forEach((el) => {
    el.textContent = statusText;
  });
  const btnAsk = document.getElementById('btn-ask');
  if (btnAsk && !q.unlimited && q.remaining === 0) {
    btnAsk.title = user.paymentPending?.status === 'pending'
      ? '汇款核实中，请耐心等待'
      : '今日免费额度已用完，可办理会员';
  } else if (btnAsk) {
    btnAsk.title = '';
  }
}

export function checkNewAskAllowed() {
  const gate = canAskNewQuestion(getUser());
  return gate.ok ? { allowed: true } : { allowed: false, gate };
}

export function commitNewQuestionAsk() {
  const user = getUser();
  recordNewQuestionAsk(user);
  saveUser(user);
  syncQuotaToServer('record').catch(() => {});
}

export async function syncQuotaFromServer() {
  const clientId = getClientId();
  try {
    const res = await fetch(apiUrl(`/api/quota?clientId=${encodeURIComponent(clientId)}`));
    if (!res.ok) return;
    const data = await res.json();
    applyServerQuota(data);
  } catch {
    /* 本地模式 */
  }
}

export function applyServerQuota(data) {
  if (!data) return;
  const user = getUser();
  if (data.subscription?.activeUntil) {
    user.subscription = data.subscription;
    user.paymentPending = null;
  } else if (!data.unlimited && !data.subscription?.activeUntil) {
    user.subscription = user.subscription?.activeUntil > Date.now() ? user.subscription : null;
  }
  if (data.paymentPending) user.paymentPending = data.paymentPending;
  else if (data.unlimited) user.paymentPending = null;
  if (typeof data.used === 'number' && !data.unlimited) {
    const now = Date.now();
    const resetAt = data.resetAt || now + WINDOW_MS;
    const span = WINDOW_MS;
    const oldest = resetAt - span;
    user.questionTimestamps = Array.from({ length: data.used }, (_, i) => {
      if (data.used <= 1) return now;
      return oldest + ((i + 1) / data.used) * (now - oldest);
    });
  }
  saveUser(user);
  refreshQuotaUI(user);
}

async function syncQuotaToServer(action) {
  const clientId = getClientId();
  await fetch(apiUrl(`/api/quota?clientId=${encodeURIComponent(clientId)}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, clientId }),
  });
}

export async function submitPaymentRequest(payload) {
  const clientId = getClientId();
  const user = getUser();
  setPaymentPending(user, { ...payload, clientId });
  saveUser(user);
  refreshQuotaUI(user);
  try {
    const res = await fetch(apiUrl('/api/payment'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, ...payload }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '提交失败');
    return data;
  } catch (e) {
    return {
      ok: true,
      message: '已本地登记（演示）。部署后由工作人员核对银行到账记录后解禁。',
      fallback: true,
    };
  }
}

export function applyServerSubscription(subscription, paymentPending) {
  const user = getUser();
  if (subscription) user.subscription = subscription;
  if (paymentPending !== undefined) user.paymentPending = paymentPending;
  saveUser(user);
  refreshQuotaUI(user);
}

export async function askAI(message, followUp = false) {
  const clientId = getClientId();
  try {
    const res = await fetch(apiUrl('/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, followUp, clientId }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 403 && data.code === 'QUOTA_EXCEEDED') {
      const err = new Error(data.error || '今日提问已达上限');
      err.code = 'QUOTA_EXCEEDED';
      err.quota = data.quota;
      throw err;
    }
    if (res.ok) {
      if (data.quota) applyServerQuota(data.quota);
      return data;
    }
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') throw e;
    /* 本地 mock */
  }
  if (!followUp) {
    const gate = canAskNewQuestion(getUser());
    if (!gate.ok) {
      const err = new Error('24 小时内提问已达 5 次上限');
      err.code = 'QUOTA_EXCEEDED';
      throw err;
    }
  }
  return mockAI(message, followUp);
}

function mockAI(message, followUp) {
  if (followUp) {
    return {
      reply:
        '【具体措辞】\n建议今晚8点发：\n「最近还好吗？突然想起你说喜欢的那家店。」\n\n【注意】简短、无压力、给对方回复空间。',
      qCoins: 8,
      wisdom: 2,
      fallback: true,
    };
  }
  const m = message;
  let reply;
  if (/借钱|转账|投资|杀猪/.test(m)) {
    reply =
      '【直线方案】\n1. 未见面绝不转账、不代付。\n2. 回复：「我们还不够熟，这类事我不方便。」\n3. 避坑：转账备注「借款」可能被追债。\n\n【相关】避坑大全 → 网恋防骗专题';
  } else if (/暧昧|备胎|确认关系/.test(m)) {
    reply =
      '【直线方案】\n1. 设定3个月期限。\n2. 直接问：「我们要不要正式在一起？」\n3. 回避或拖延=离开。\n\n【再问一步】可获取第一条消息具体措辞。';
  } else if (/冷暴力|已读不回|消失/.test(m)) {
    reply =
      '【直线方案】\n1. 发底线信息：「我需要沟通，X日前谈。」\n2. 到期无回应则止损。\n3. 停止反复道歉。\n\n【代价】情感内耗与时间';
  } else if (/彩礼|见家长|结婚/.test(m)) {
    reply =
      '【直线方案】\n1. 大额支付需书面约定。\n2. 见家长礼物适度，观察双向尊重。\n3. 急催结婚需放慢深入了解。\n\n【相关】婚恋家庭专题';
  } else if (/出轨|第三者|暧昧边界/.test(m)) {
    reply =
      '【直线方案】\n1. 明确边界底线。\n2. 原谅需伴随断联行动。\n3. 反复越界=重新选择。';
  } else {
    const generic = [
      '【直线方案】\n1. 今晚先不发长文，发一句具体关心，观察回应。\n2. 若24小时无回应，隔天用轻松话题试探。\n3. 避坑：连续发小作文会被视为压迫感。\n\n【再问一步】需要具体措辞可点击「再问一步」。',
      '【直线方案】\n1. 把问题拆成「事实+感受+请求」。\n2. 只谈一件事，不翻旧账。\n3. 对方回避则设沟通期限。',
    ];
    reply = generic[Math.floor(Math.random() * generic.length)];
  }
  return {
    reply,
    qCoins: 10,
    wisdom: Math.min(5, Math.floor(message.length / 50) + 1),
    fallback: true,
  };
}

export function showToast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}
