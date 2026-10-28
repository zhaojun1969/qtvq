import { getClientId, formatQuotaStatusText } from './quota.js';
import { getUser, showToast, refreshStatUI } from './app.js';
import { PAY_CHANNELS } from './pay-qr.js';
import { qrCodeImageUrl } from './qr-render.js';
import { apiFetch } from './api-fetch.js';
import { imgUrl } from './config.js';
import {
  registerAccount,
  loginAccount,
  fetchAccountMe,
  logoutAccount,
  getAuthUser,
  isLoggedIn,
  refreshAuthNav,
  changePassword,
  deleteAccount,
  clearAuthSession,
  startWechatOpenLogin,
  closeWechatLoginModal,
  handleWechatOpenCallback,
  sendSmsCode,
  resetPasswordBySms,
  fetchSmsStatus,
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

/* ── 缘值钱包：余额 + 最近明细 ────────────────────────────────────────────
 * 2026-10-11：网页端**以前完全没有这块显示** —— 用户充了钱，页面上只有"充值"按钮与
 * "会员开通记录"（那是会员数据，与缘值无关），于是反复投诉"看不到余额 +1"。
 * 数据源：Node `GET /v1/wallet`（余额）与 `GET /v1/wallet/ledger?limit=N`（流水，含 balanceAfter）。
 * 小程序早就在用这两个接口，是网页端一直没接。
 */
const LEDGER_REASON_ZH = {
  topup: '缘值充值',
  admin_credit: '人工入账',
  welcome: '欢迎缘值',
  wheel_spin: '转盘',
  member_daily_spin: '转盘（会员每日免费）',
  report_charge: '配对报告',
  member_daily_free: '报告（会员每日免费）',
  free_tier: '报告（体验档免费）',
  refund: '退款回冲',
  billing_disabled: '计费未开启',
};

function ledgerReasonText(reason, ref) {
  // 与小程序同一套兜底：历史数据里在线充值曾被写成 admin_credit，但 ref 是订单号（ord_ 开头）
  if (reason === 'admin_credit' && typeof ref === 'string' && ref.startsWith('ord_')) return '缘值充值（在线支付）';
  return LEDGER_REASON_ZH[reason] || reason || '—';
}

/** 取钱包流水（供"是否真的入账"判定与渲染共用） */
async function fetchWalletLedger(limit = 5) {
  /* 返回数组=成功（空数组表示确实没有记录）；返回 null=没取到（必须显式告诉用户）。
   * 2026-10-11 两个真实坑：
   *  ① `r.ok` 对 304 Not Modified 是 false（ok 仅 200-299）→ 原来据此返回 []，
   *     把"有数据但没取到"伪装成"确实没有记录"（线上日志里大量 /v1/wallet/ledger 304）。
   *  ② 页面刚加载时 token 未就绪 → 服务端 401（日志 21:22:27 / 21:23:11 均为 401，
   *     1-3 秒后重试才 200）→ 需要一次重试。
   * 统一加 cache:'no-store' + _t 时间戳，不给浏览器/中间层用 304 糊弄我们的机会。
   */
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const r = await apiFetch(`/v1/wallet/ledger?limit=${limit}&_t=${Date.now()}`, { cache: 'no-store' });
      if (r.status === 401 && attempt === 0) { await new Promise((res) => setTimeout(res, 1200)); continue; }
      if (r.status === 401) return null;
      const j = await r.json().catch(() => null);
      const items = j?.data?.items || j?.items;
      if (Array.isArray(items)) return items;
      if (attempt === 0) { await new Promise((res) => setTimeout(res, 1200)); continue; }
      return null;
    } catch {
      if (attempt === 0) { await new Promise((res) => setTimeout(res, 1200)); continue; }
      return null;
    }
  }
  return null;
}

/** 渲染余额与明细；返回余额（拿不到返回 null） */
async function refreshWallet() {
  const balEl = document.getElementById('wallet-balance');
  const listEl = document.getElementById('wallet-ledger');
  const emptyEl = document.getElementById('wallet-ledger-empty');
  if (!balEl && !listEl) return null;

  let balance = null;
  let failReason = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const r = await apiFetch(`/v1/wallet?_t=${Date.now()}`, { cache: 'no-store' });
      if (r.status === 401 && attempt === 0) { await new Promise((res) => setTimeout(res, 1200)); continue; }
      if (r.status === 401) { failReason = '登录状态已失效，请重新登录'; break; }
      const j = await r.json().catch(() => null);
      const b = j?.data?.wallet?.balance ?? j?.wallet?.balance;
      if (typeof b === 'number') { balance = b; break; }
      failReason = '服务端未返回余额';
      if (attempt === 0) { await new Promise((res) => setTimeout(res, 1200)); continue; }
    } catch {
      failReason = '网络错误';
      if (attempt === 0) { await new Promise((res) => setTimeout(res, 1200)); continue; }
    }
  }
  if (balEl) {
    /* 读不到就**如实显示原因**，不再让 "¥—" 沉默地骗人
       （今天已因"静默兜底掩盖失败"吃过两次亏，这次轮到我自己的代码） */
    balEl.textContent = balance !== null ? `¥${balance.toFixed(2)}` : `读取失败（${failReason || '未知原因'}）`;
  }

  const items = await fetchWalletLedger(5);
  if (items === null) {
    if (listEl) listEl.innerHTML = '<li>明细加载失败，请刷新重试（上面的余额可能仍然是准的）</li>';
    if (emptyEl) emptyEl.hidden = true;
    return balance;
  }
  if (listEl) {
    listEl.innerHTML = items
      .map((x) => `<li>${x.direction === 'out' ? '−' : '+'}¥${Number(x.amount).toFixed(2)} · ${escapeText(ledgerReasonText(x.reason, x.ref))} · ${fmtTime(x.createdAt)}</li>`)
      .join('');
  }
  if (emptyEl) emptyEl.hidden = items.length > 0;
  return balance;
}

/** 极简转义：流水里的 reason/ref 也可能来自服务端，不直接拼进 innerHTML */
function escapeText(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

/**
 * 顶部登录状态条。它回答三个以前只能靠"猜"的问题：
 * 现在登没登？用什么方式登的？会员开了没有？
 * 起因（2026-09-16 业务方反馈）：状态只靠面板显隐暗示，用户扫码后看不出成没成，
 * 也找不到"退出登录"在哪（退出按钮在已登录面板里）。
 */
function setAccountStatus(kind, text) {
  const el = document.getElementById('acc-status');
  if (!el) return;
  el.className = 'account-status' + (kind ? ' is-' + kind : '');
  el.textContent = text;
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

  const who = user.phone ? `手机号 ${user.phone}` : user.wechatBound ? '微信账号' : '账号';
  const member = quota?.unlimited
    ? `会员已开通${quota.subscription?.label ? `（${quota.subscription.label}）` : ''}`
    : quota?.paymentPending
      ? '会员未开通（有付款待核实，客服核对后开通）'
      : '会员未开通（可点下方「办理 / 续费会员」）';
  setAccountStatus(quota?.unlimited ? 'member' : '', `已登录：${who} · ${member} · 退出登录见下方按钮`);

  renderPayStatus(quota);
  renderPayHistory(quota);
  initTopup(quota);
  renderDeleteZone(user);
  refreshAuthNav();
  refreshStatUI();
}

/**
 * 注销区：有密码的账号要输密码，纯微信账号要打出「注销账号」四个字。
 * 服务端还会再拦一道（未到期会员 / 待核实付款），这里只是把确认方式显示正确。
 */
function renderDeleteZone(user) {
  const pwdLabel = document.getElementById('delete-pwd-label');
  const textLabel = document.getElementById('delete-text-label');
  if (!pwdLabel || !textLabel) return;
  const hasPwd = Boolean(user?.hasPassword);
  pwdLabel.hidden = !hasPwd;
  textLabel.hidden = hasPwd;
}

async function loadDashboard() {
  if (!isLoggedIn()) {
    setAccountStatus('guest', '当前未登录 · 请用下方任一方式登录或注册（未注册可直接点「微信扫码登录」，自动创建账号）');
    if (guestPanel) guestPanel.hidden = false;
    if (userPanel) userPanel.hidden = true;
    refreshAuthNav();
    return;
  }
  setAccountStatus('', '正在加载账户信息…');
  try {
    const data = await fetchAccountMe();
    renderDashboard(data);
  } catch (e) {
    // 登录态失效要**明确说出来**：以前只弹一个短暂 toast，页面随后显示访客面板，
    // 用户会以为自己已经登录却"看不到任何信息"（2026-09-16 业务方反馈）。
    showToast(e.message || '加载失败');
    setAccountStatus('warn', `登录状态已失效（${e.message || '获取账户失败'}）· 请重新登录`);
    if (guestPanel) guestPanel.hidden = false;
    if (userPanel) userPanel.hidden = true;
    refreshAuthNav();
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

/* ── 短信找回密码 ── */
let smsTimer = null;

// 短信服务没配置时不要展示短信入口：点了只得到"未配置"是最差的体验
fetchSmsStatus().then((ok) => {
  if (ok) return;
  document.getElementById('forgot-form')?.setAttribute('hidden', '');
  const hint = document.getElementById('sms-hint');
  if (hint) hint.textContent = '短信找回暂未开通，请使用下方微信扫码验证，或邮件联系客服。';
});

function setSendBtnText(text, disabled) {
  const btn = document.getElementById('btn-send-sms');
  if (!btn) return;
  btn.textContent = text;
  btn.disabled = !!disabled;
}

document.getElementById('btn-send-sms')?.addEventListener('click', async () => {
  const form = document.getElementById('forgot-form');
  const phone = (new FormData(form).get('phone') || '').toString().trim();
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    showToast('请先填写正确的 11 位手机号');
    return;
  }
  setSendBtnText('发送中…', true);
  try {
    await sendSmsCode(phone);
    showToast('验证码已发送（若该手机号已注册）');
    // 60 秒倒计时与后端节流一致
    let left = 60;
    setSendBtnText(`${left} 秒后可重发`, true);
    clearInterval(smsTimer);
    smsTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(smsTimer);
        setSendBtnText('重新获取', false);
      } else {
        setSendBtnText(`${left} 秒后可重发`, true);
      }
    }, 1000);
  } catch (e) {
    setSendBtnText('获取验证码', false);
    showToast(e.message || '验证码发送失败');
  }
});

document.getElementById('forgot-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const phone = (fd.get('phone') || '').toString().trim();
  const code = (fd.get('code') || '').toString().trim();
  const newPassword = (fd.get('newPassword') || '').toString();
  if (newPassword !== fd.get('newPassword2')) {
    showToast('两次新密码不一致');
    return;
  }
  try {
    await resetPasswordBySms({ phone, code, newPassword });
    clearInterval(smsTimer);
    showToast('密码已重置，请用新密码登录');
    document.getElementById('forgot-panel').hidden = true;
    document.getElementById('login-panel').hidden = false;
    document.getElementById('login-form')?.querySelector('input[name="phone"]')?.focus?.();
  } catch (err) {
    showToast(err.message || '重置失败');
  }
});

/* ── 缘值充值·在线支付（方案 A：金额由订单决定，付完自动到账） ── */
let topupPollTimer = null;

function stopTopupPoll() {
  if (topupPollTimer) {
    clearTimeout(topupPollTimer);
    topupPollTimer = null;
  }
}

/**
 * 充值登录闸门：**未登录时把静态收款码整块收起来**。
 *
 * 为什么要做成"看不见"而不是"提示一下"（2026-10-11 两位用户实测踩坑）：
 *   · 在线支付必须登录（要往 `uid` 的钱包入账，没账号无处可记）→ `js/account.js` 里只弹一句"请先登录"；
 *   · 而折叠在 `<details>` 里的静态码**不需要登录**，展开就能扫；
 *   · 于是"点在线支付 → 被登录提示挡住 → 顺手展开下面那块去扫静态码"成了最自然的路径，
 *     而那笔钱**永远无法自动入账**（静态图没有订单号、没有回调），只能人工核实补账。
 * 所以这里把「未登录」与「静态码」两件事从结构上互斥：没登录就看不到静态码。
 * 靠文案提醒是不够的 —— 已经发生两次了。
 */
function applyTopupLoginGate() {
  const logged = Boolean(getAuthUser()?.id);
  const manual = document.getElementById('topup-manual');
  const gate = document.getElementById('topup-login-gate');
  const onlineBox = document.getElementById('topup-online-box');
  if (manual) manual.hidden = !logged;
  if (gate) gate.hidden = logged;
  // 未登录时把已生成的订单二维码也收起来（避免"上一个会话的码"被误扫）
  if (!logged && onlineBox) onlineBox.hidden = true;
}

applyTopupLoginGate();

document.getElementById('btn-topup-online')?.addEventListener('click', async () => {
  stopTopupPoll();
  const amount = currentTopupAmount();
  if (amount < 1 || amount > 2000) return showToast('充值金额需在 ¥1 – ¥2000 之间');

  const user = getAuthUser();
  if (!user?.id) {
    // 关键：被登录挡住时，顺手把静态码也收起来 —— 否则用户会退到那条无法自动入账的路上
    applyTopupLoginGate();
    return showToast('请先登录后再充值（需要账号才能入账）');
  }

  const btn = document.getElementById('btn-topup-online');
  btn.disabled = true;
  btn.textContent = '正在创建订单…';
  try {
    const res = await apiFetch('/api/payment/wechat/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: getClientId(),
        plan: 'topup',
        amount,
        uid: user.id, // Node 侧钱包的 _id 就是这个值，无需映射
        channel: 'native',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.codeUrl) {
      throw new Error(data.error || `下单失败（HTTP ${res.status}）`);
    }

    const box = document.getElementById('topup-online-box');
    const img = document.getElementById('topup-online-img');
    const statusEl = document.getElementById('topup-online-status');
    if (box) box.hidden = false;
    if (img) img.src = qrCodeImageUrl(data.codeUrl, 260);
    if (statusEl) statusEl.textContent = `订单 ${data.orderId} · 应付 ¥${amount} · 等待支付中…`;

    const { pollWechatPayOrder } = await import('./payment-wechat.js');
    const stop = pollWechatPayOrder(data.orderId, {
      /*
       * ⚠️ 付款成功 ≠ 已入账 —— 这里以前直接写「✓ 支付成功，¥X 已自动加到你的缘值」，
       * 而它唯一的依据是**订单状态变成 paid**；而订单是被 `payment-activate.js` 的
       * `markOrderPaid()` **先**标成 paid 的，与"钱有没有进钱包"无关。
       * 2026-10-11 事故里入账失败、界面却宣布成功，用户以为钱到了（连续几笔都这样）。
       * 现在只陈述"支付成功"，入账结果以**余额/明细**为准，并给出订单号便于核对。
       */
      onPaid: async () => {
        /*
         * 付款成功 ≠ 已入账。以前这里只看订单状态就宣布"已加到你的缘值"，
         * 而订单是被 markOrderPaid() **先**标的 paid（与钱是否进钱包无关）→ 假提示。
         * 现在以**流水里出现本订单号**为准确认（ref = orderId：自动入账与人工补账都用这个键）。
         */
        if (statusEl) statusEl.textContent = `支付成功，正在确认入账…（订单号 ${data.orderId}）`;
        let credited = false;
        for (let i = 0; i < 5 && !credited; i += 1) {
          const items = await fetchWalletLedger(10);
          credited = items.some((x) => x.ref === data.orderId);
          if (!credited) await new Promise((r) => setTimeout(r, 2000));
        }
        await refreshWallet();
        if (statusEl) {
          statusEl.textContent = credited
            ? `✓ 已到账：缘值 +¥${amount}（订单号 ${data.orderId}）`
            : `支付成功，但入账尚未确认（订单号 ${data.orderId}）。请点「刷新」；若 1 分钟后仍未到账，请把这个订单号发给客服。`;
        }
        showToast(credited ? `充值到账：+¥${amount}` : '支付成功，入账待确认');
        fetchAccountMe().then((d) => d && renderDashboard(d)).catch(() => {});
      },
      onError: () => {},
    });
    topupPollTimer = setTimeout(stop, 10 * 60 * 1000); // 最多轮询 10 分钟
  } catch (err) {
    showToast(err.message || '创建充值订单失败');
  } finally {
    btn.disabled = false;
    btn.textContent = '微信在线支付 · 自动到账';
  }
});

/* ── 缘值充值（静态收款码 + 提交核实；后端 /api/payment 的 plan=topup 分支） ── */
let topupChannel = 'wechat';

function currentTopupAmount() {
  const el = document.getElementById('topup-amount');
  const v = Number(el?.value || 0);
  return Number.isFinite(v) ? v : 0;
}

/** 三行提示：把"必须自己填金额 + 必须提交核实"讲明白（静态码不会自动到账） */
function refreshTopupTip() {
  const amount = currentTopupAmount();
  const ch = PAY_CHANNELS[topupChannel];
  const tipEl = document.getElementById('topup-tip');
  const imgEl = document.getElementById('topup-qr-img');
  if (ch && imgEl) {
    imgEl.src = imgUrl(ch.image);
    imgEl.alt = `${ch.label}收款码`;
  }
  if (tipEl) {
    tipEl.textContent = amount > 0
      ? `① 用${ch?.label || '微信'}扫上面这张码，付款金额请填 ¥${amount}（可点「复制金额」）\n② 备注填设备编号或账单后四位\n③ 付完点下方「我已付款 · 提交核实」（静态码不会自动到账）`
      : '请先填写充值金额';
  }
  document.querySelectorAll('#topup-channels [data-channel]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.channel === topupChannel);
  });
}

function renderTopupChannels() {
  const wrap = document.getElementById('topup-channels');
  if (!wrap || wrap.dataset.ready === '1') return;
  wrap.innerHTML = Object.values(PAY_CHANNELS)
    .map((ch) => `<button type="button" class="btn btn-secondary" data-channel="${ch.id}">${ch.label}</button>`)
    .join('');
  wrap.dataset.ready = '1';
  wrap.querySelectorAll('[data-channel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      topupChannel = btn.dataset.channel;
      refreshTopupTip();
    });
  });
}

document.querySelectorAll('[data-topup]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const el = document.getElementById('topup-amount');
    if (el) el.value = btn.dataset.topup;
    refreshTopupTip();
  });
});

document.getElementById('topup-amount')?.addEventListener('input', refreshTopupTip);

document.getElementById('btn-topup-copy')?.addEventListener('click', async () => {
  const amount = currentTopupAmount();
  if (amount <= 0) return showToast('请先填写充值金额');
  try {
    await navigator.clipboard.writeText(String(amount));
    showToast(`已复制金额 ¥${amount}`);
  } catch {
    showToast(`请手动输入金额：¥${amount}`);
  }
});

document.getElementById('topup-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const amount = currentTopupAmount();
  if (amount < 1 || amount > 2000) return showToast('充值金额需在 ¥1 – ¥2000 之间');
  const fd = new FormData(e.target);
  try {
    const res = await apiFetch('/api/payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: getClientId(),
        plan: 'topup',
        amount,
        payerName: (fd.get('payerName') || '').toString().trim(),
        paidAt: (fd.get('paidAt') || '').toString().trim(),
        remark: (fd.get('remark') || '').toString().trim(),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 这里以前是 `data.error || '提交失败'` —— 当响应体不是 JSON（例如 403/404/405 的 HTML 页）
      // 时，就会退化成笼统的「提交失败」，用户和排查的人都看不到真实原因。
      // 现在把状态码与服务端返回内容一并抛出，并在控制台留全量信息。
      const empty = !data || Object.keys(data).length === 0;
      console.error('[topup] 提交失败', res.status, data);
      throw new Error(
        `提交失败（HTTP ${res.status}）：${data?.error || data?.message || (empty ? '服务端未返回 JSON 原因' : '未知原因')}`,
      );
    }
    showToast(data.message || '已登记，核对到账后为你加缘值');
    const pendingEl = document.getElementById('topup-pending');
    if (pendingEl) {
      pendingEl.hidden = false;
      pendingEl.textContent = `已提交待核实：¥${amount}（${fd.get('payerName') || ''} · ${fd.get('paidAt') || ''}）。客服核对到账后加缘值。`;
    }
  } catch (err) {
    showToast(err.message || '提交失败');
  }
});

function initTopup(quota) {
  renderTopupChannels();
  // 付款时间预填为现在，减少一处必填负担
  const paidAt = document.querySelector('#topup-form input[name="paidAt"]');
  if (paidAt && !paidAt.value) {
    const p = (n) => String(n).padStart(2, '0');
    const d = new Date();
    paidAt.value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const pendingEl = document.getElementById('topup-pending');
  if (pendingEl && quota?.topupPending?.status === 'pending') {
    pendingEl.hidden = false;
    pendingEl.textContent = `已提交待核实：¥${quota.topupPending.amount}（${quota.topupPending.payerName} · ${quota.topupPending.paidAt}）`;
  }
  refreshTopupTip();
}

document.getElementById('btn-wechat-open-login')?.addEventListener('click', async () => {
  try {
    await startWechatOpenLogin();
  } catch (e) {
    showToast(e.message || '微信登录未配置');
  }
});

// 关闭微信扫码弹窗（点遮罩或「关闭」按钮）
document.querySelectorAll('[data-close-wx-login]').forEach((el) => {
  el.addEventListener('click', () => closeWechatLoginModal());
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeWechatLoginModal();
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

// 注销账号：先本地确认，服务端再按策略拦（未到期会员 / 待核实付款）
document.getElementById('btn-delete-account')?.addEventListener('click', async () => {
  const me = getAuthUser() || {};
  const pwdInput = document.getElementById('delete-password');
  const textInput = document.getElementById('delete-confirm-text');
  const payload = me.hasPassword
    ? { password: pwdInput?.value || '' }
    : { confirmText: (textInput?.value || '').trim() };

  if (me.hasPassword && !payload.password) {
    showToast('请输入登录密码以确认');
    pwdInput?.focus();
    return;
  }
  if (!me.hasPassword && payload.confirmText !== '注销账号') {
    showToast('请输入「注销账号」四个字以确认');
    textInput?.focus();
    return;
  }
  if (!window.confirm('确认注销？个人资料与登录凭证将立即删除且不可恢复（订单流水脱敏保留）。')) return;

  const btn = document.getElementById('btn-delete-account');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '注销中…';
  }
  try {
    const data = await deleteAccount(payload);
    clearAuthSession();
    showToast(data.message || '账号已注销');
    setTimeout(() => {
      location.href = 'index.html';
    }, 1200);
  } catch (err) {
    // 会员未到期 / 有待核实付款：服务端会说清原因，原样展示给用户
    showToast(err.message || '注销失败');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '确认注销我的账号';
    }
  }
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
  // 缘值余额与明细：登录后立即渲染（网页端以前完全没有这块显示）
  if (isLoggedIn()) refreshWallet().catch(() => {});
}, 30000);
