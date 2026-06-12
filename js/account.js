import { getClientId, formatQuotaStatusText } from './quota.js';
import { getUser, showToast, refreshStatUI } from './app.js';
import {
  registerAccount,
  loginAccount,
  fetchAccountMe,
  logoutAccount,
  getAuthUser,
  isLoggedIn,
  refreshAuthNav,
  changePassword,
  startWechatOpenLogin,
  handleWechatOpenCallback,
} from './auth.js';

const guestPanel = document.getElementById('guest-panel');
const userPanel = document.getElementById('user-panel');
const loginPanel = document.getElementById('login-panel');
const registerPanel = document.getElementById('register-panel');
const forgotPanel = document.getElementById('forgot-panel');
const changePwdPanel = document.getElementById('change-pwd-panel');
const payStatusArea = document.getElementById('pay-status-area');
const payHistoryEl = document.getElementById('pay-history');
const payHistoryEmpty = document.getElementById('pay-history-empty');

function showTab(tab) {
  const isLogin = tab === 'login';
  const isRegister = tab === 'register';
  const isForgot = tab === 'forgot';
  document.getElementById('tab-login')?.classList.toggle('active', isLogin);
  document.getElementById('tab-register')?.classList.toggle('active', isRegister);
  document.getElementById('tab-forgot')?.classList.toggle('active', isForgot);
  if (loginPanel) loginPanel.hidden = !isLogin;
  if (registerPanel) registerPanel.hidden = !isRegister;
  if (forgotPanel) forgotPanel.hidden = !isForgot;
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN');
}

function renderPayStatus(quota) {
  if (!payStatusArea) return;
  payStatusArea.innerHTML = '';

  if (quota?.unlimited && quota.subscription) {
    const sub = quota.subscription;
    const card = document.createElement('div');
    card.className = 'pay-status-card is-active';
    card.innerHTML = `
      <strong>✓ 会员已开通</strong><br>
      套餐：${sub.label || sub.plan || '会员'} · 金额 ¥${quota.plans?.[sub.plan]?.price ?? '—'}<br>
      有效期至：${fmtTime(sub.activeUntil)}
    `;
    payStatusArea.appendChild(card);
    return;
  }

  if (quota?.paymentPending?.status === 'pending') {
    const p = quota.paymentPending;
    const card = document.createElement('div');
    card.className = 'pay-status-card is-pending';
    card.innerHTML = `
      <strong>⏳ 打款核实中</strong><br>
      套餐：${p.planLabel || p.plan} · 金额 ¥${p.amount}<br>
      汇款人：${p.payerName || '—'} · 汇款时间：${p.paidAt || '—'}<br>
      备注：${p.remark || '—'}<br>
      提交时间：${fmtTime(p.submittedAt)}<br>
      <span class="modal-hint">工作人员核对到账后将自动解禁，请稍后再刷新本页。</span>
    `;
    payStatusArea.appendChild(card);
    return;
  }

  const card = document.createElement('div');
  card.className = 'pay-status-card';
  card.innerHTML = `
    <strong>暂无待核实打款</strong><br>
    <span class="modal-hint">付款后请在首页会员弹窗提交「我已汇款」；或开通微信在线支付后自动到账。</span>
  `;
  payStatusArea.appendChild(card);
}

function renderPayHistory(quota) {
  const list = quota?.paymentHistory || [];
  if (!payHistoryEl || !payHistoryEmpty) return;
  payHistoryEl.innerHTML = '';
  payHistoryEmpty.hidden = list.length > 0;
  list.forEach((item) => {
    const li = document.createElement('li');
    li.textContent = `${item.planLabel || item.plan} · ¥${item.amount} · ${item.status === 'active' ? '已开通' : item.status} · ${fmtTime(item.activatedAt || item.submittedAt)}`;
    payHistoryEl.appendChild(li);
  });
}

function renderDashboard(data) {
  const user = data?.user || getAuthUser();
  const quota = data?.quota;
  if (!user) return;

  if (guestPanel) guestPanel.hidden = true;
  if (userPanel) userPanel.hidden = false;

  document.getElementById('acc-phone').textContent = user.phone || (user.wechatBound ? '微信用户（可设置密码）' : '—');
  document.getElementById('acc-client-id').textContent = user.clientId || getClientId();
  document.getElementById('acc-quota').textContent = quota
    ? formatQuotaStatusText({ subscription: quota.subscription, paymentPending: quota.paymentPending, questionTimestamps: [] })
    : formatQuotaStatusText(getUser());

  renderPayStatus(quota);
  renderPayHistory(quota);
  refreshAuthNav();
  refreshStatUI();
}

async function loadDashboard() {
  if (!isLoggedIn()) {
    if (guestPanel) guestPanel.hidden = false;
    if (userPanel) userPanel.hidden = true;
    refreshAuthNav();
    return;
  }
  try {
    const data = await fetchAccountMe();
    renderDashboard(data);
  } catch (e) {
    showToast(e.message || '加载失败');
    if (guestPanel) guestPanel.hidden = false;
    if (userPanel) userPanel.hidden = true;
  }
}

document.getElementById('tab-login')?.addEventListener('click', () => showTab('login'));
document.getElementById('tab-register')?.addEventListener('click', () => showTab('register'));
document.getElementById('tab-forgot')?.addEventListener('click', () => showTab('forgot'));
document.getElementById('go-forgot')?.addEventListener('click', () => showTab('forgot'));

document.getElementById('btn-change-pwd')?.addEventListener('click', () => {
  const user = getAuthUser();
  const oldWrap = document.getElementById('old-pwd-wrap');
  if (oldWrap) oldWrap.hidden = user && user.hasPassword === false;
  changePwdPanel?.removeAttribute('hidden');
});
document.getElementById('btn-cancel-pwd')?.addEventListener('click', () => {
  changePwdPanel?.setAttribute('hidden', '');
});
document.getElementById('change-pwd-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const np = fd.get('newPassword')?.toString();
  const np2 = fd.get('newPassword2')?.toString();
  if (np !== np2) {
    showToast('两次新密码不一致');
    return;
  }
  try {
    await changePassword(fd.get('oldPassword')?.toString() || '', np);
    showToast('密码已更新');
    changePwdPanel?.setAttribute('hidden', '');
    e.target.reset();
  } catch (err) {
    showToast(err.message || '修改失败');
  }
});

document.getElementById('btn-wechat-open-login')?.addEventListener('click', async () => {
  try {
    await startWechatOpenLogin();
  } catch (e) {
    showToast(e.message || '微信登录未配置');
  }
});

document.getElementById('btn-wechat-open-reset')?.addEventListener('click', async () => {
  const form = document.getElementById('forgot-form');
  const fd = new FormData(form);
  if (fd.get('newPassword') !== fd.get('newPassword2')) {
    showToast('两次新密码不一致');
    return;
  }
  try {
    await startWechatOpenLogin({ forReset: true });
  } catch (e) {
    showToast(e.message || '微信验证未配置');
  }
});

document.getElementById('login-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const data = await loginAccount(fd.get('phone')?.toString().trim(), fd.get('password')?.toString());
    showToast('登录成功');
    renderDashboard(data);
  } catch (err) {
    showToast(err.message || '登录失败');
  }
});

document.getElementById('register-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const pw = fd.get('password')?.toString();
  const pw2 = fd.get('password2')?.toString();
  if (pw !== pw2) {
    showToast('两次密码不一致');
    return;
  }
  try {
    const data = await registerAccount(fd.get('phone')?.toString().trim(), pw);
    showToast('注册成功');
    renderDashboard(data);
  } catch (err) {
    showToast(err.message || '注册失败');
  }
});

document.getElementById('btn-logout')?.addEventListener('click', async () => {
  await logoutAccount();
  showToast('已退出');
  if (guestPanel) guestPanel.hidden = false;
  if (userPanel) userPanel.hidden = true;
  refreshAuthNav();
});

document.getElementById('btn-subscribe')?.addEventListener('click', () => {
  location.href = 'index.html?subscribe=1';
});

loadDashboard();
handleWechatOpenCallback()
  .then((data) => {
    if (data) {
      showToast(data.user?.phone ? '登录成功' : '微信登录成功');
      renderDashboard(data);
    }
  })
  .catch((e) => showToast(e.message || '微信回调失败'));

setInterval(() => {
  if (isLoggedIn()) fetchAccountMe().then(renderDashboard).catch(() => {});
}, 30000);
