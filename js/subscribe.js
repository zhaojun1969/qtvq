import { PLANS, COMPANY, getClientId } from './quota.js';
import { submitPaymentRequest, showToast, syncQuotaFromServer, applyServerSubscription } from './app.js';
import { getAuthUser } from './auth.js';
import { PAY_CHANNELS, detectPayEnv } from './pay-qr.js';
import { createWechatPayOrder, pollWechatPayOrder } from './payment-wechat.js';
import { qrCodeImageUrl } from './qr-render.js';

let selectedPlan = 'month';
let stopOrderPoll = null;

function getSelectedPrice() {
  return PLANS[selectedPlan]?.price ?? 29;
}

/** datetime-local 需要「本地时间、不带秒/Z」 */
function localDateTimeNow(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 预填付款核实表单：金额=所选套餐、时间=现在、付款人=已登录昵称。
 *
 * 为什么必须预填：静态收款码（微信/聚合码）没有任何支付回调，服务器收不到「有人付了钱」
 * 的通知，唯一能知道这笔付款的时点就是**客户提交核实**。以前要手填 4 项，
 * 客户付完常常直接关页面 —— 2026-09-16 业务方实测就是这个结果：付了钱既没通知也没开通。
 * 现在预填 3 项，客户只需确认付款人姓名后点一次按钮。
 */
function prefillPaymentForm() {
  const form = document.getElementById('payment-form');
  if (!form) return;
  const plan = PLANS[selectedPlan];
  const amount = form.querySelector('input[name="amount"]');
  if (amount && plan && !amount.value) amount.value = String(plan.price);
  const paidAt = form.querySelector('input[name="paidAt"]');
  if (paidAt && !paidAt.value) paidAt.value = localDateTimeNow();
  const name = form.querySelector('input[name="payerName"]');
  if (name && !name.value.trim()) {
    const u = typeof getAuthUser === 'function' ? getAuthUser() : null;
    const guess = (u && (u.nickname || u.phone)) || '';
    if (guess) name.value = guess;
  }
}

/**
 * 查看器里的「我已付款 · 提交核实」：预填后直接触发表单提交，客户只需一次点击。
 * 付款人姓名决定我们核对到账时能不能对上，所以它空着时不做静默提交，
 * 而是把客户带回表单并聚焦该输入框。
 */
function submitFromViewer() {
  const form = document.getElementById('payment-form');
  if (!form) return;
  prefillPaymentForm();
  const name = form.querySelector('input[name="payerName"]');
  const paidAt = form.querySelector('input[name="paidAt"]');
  if (!name?.value.trim() || !paidAt?.value) {
    document.getElementById('pay-qr-viewer')?.classList.remove('open');
    scrollToPaymentForm();
    name?.focus();
    return;
  }
  if (typeof form.requestSubmit === 'function') form.requestSubmit();
  else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

function setViewerMeta({ title, price, clientId, tip, orderText, statusText, statusPaid }) {
  document.getElementById('pay-qr-viewer-title').textContent = title;
  document.getElementById('pay-qr-viewer-price').textContent = `¥${price}`;
  document.getElementById('pay-qr-viewer-client').textContent = clientId;
  document.getElementById('pay-qr-viewer-tip').textContent = tip || '';

  const orderEl = document.getElementById('pay-qr-viewer-order');
  if (orderEl) {
    if (orderText) {
      orderEl.textContent = orderText;
      orderEl.hidden = false;
    } else {
      orderEl.textContent = '';
      orderEl.hidden = true;
    }
  }

  const statusEl = document.getElementById('pay-qr-viewer-status');
  if (statusEl) {
    if (statusText) {
      statusEl.textContent = statusText;
      statusEl.hidden = false;
      statusEl.classList.toggle('is-paid', !!statusPaid);
    } else {
      statusEl.textContent = '';
      statusEl.hidden = true;
      statusEl.classList.remove('is-paid');
    }
  }
}

function openPayQrViewer(channelId) {
  stopOnlinePoll();
  const ch = PAY_CHANNELS[channelId];
  if (!ch) return;

  const viewer = document.getElementById('pay-qr-viewer');
  const price = getSelectedPrice();
  const clientId = getClientId();

  setViewerMeta({
    title: `${ch.label} · 扫码付款`,
    price,
    clientId,
    tip: ch.tip,
  });

  const img = document.getElementById('pay-qr-viewer-img');
  img.src = ch.image;
  img.alt = `${ch.label}收款码`;
  img.hidden = false;

  viewer?.classList.add('open');
  viewer?.setAttribute('aria-hidden', 'false');

  const env = detectPayEnv();
  if (ch.openApp && env.alipay && channelId.startsWith('alipay')) {
    setTimeout(() => {
      try {
        window.location.href = ch.openApp;
      } catch {
        /* 留在当前页展示二维码 */
      }
    }, 400);
  }
}

function stopOnlinePoll() {
  if (stopOrderPoll) {
    stopOrderPoll();
    stopOrderPoll = null;
  }
}

function openDynamicPayViewer({ codeUrl, orderId, jsapi, stub, message }) {
  stopOnlinePoll();
  const viewer = document.getElementById('pay-qr-viewer');
  const price = getSelectedPrice();
  const clientId = getClientId();
  const img = document.getElementById('pay-qr-viewer-img');

  if (stub || !codeUrl) {
    setViewerMeta({
      title: '微信在线支付 · 暂未开通',
      price,
      clientId,
      tip: message || '商户 API 未配置，请使用下方静态收款码或银行汇款。',
      orderText: orderId ? `订单号：${orderId}（stub）` : '',
    });
    img.hidden = true;
    img.src = '';
    viewer?.classList.add('open');
    viewer?.setAttribute('aria-hidden', 'false');
    return;
  }

  setViewerMeta({
    title: '微信在线支付 · 扫码付款',
    price,
    clientId,
    tip: '请用微信扫一扫下方二维码；支付成功后本页将自动刷新会员状态。',
    orderText: `订单号：${orderId}`,
    statusText: '等待支付中…',
  });

  img.src = qrCodeImageUrl(codeUrl, 280);
  img.alt = '微信支付订单二维码';
  img.hidden = false;

  viewer?.classList.add('open');
  viewer?.setAttribute('aria-hidden', 'false');

  if (jsapi && detectPayEnv().wechat) {
    invokeWechatJsapi(jsapi).then(() => {
      setViewerMeta({
        title: '微信在线支付',
        price,
        clientId,
        tip: '请在微信内完成支付。',
        orderText: `订单号：${orderId}`,
        statusText: '支付处理中…',
      });
    }).catch(() => {
      /* 用户取消或失败，继续展示二维码 */
    });
  }

  stopOrderPoll = pollWechatPayOrder(orderId, {
    onPaid: (data) => {
      if (data.quota?.subscription) {
        applyServerSubscription(data.quota.subscription, data.quota.paymentPending);
      }
      setViewerMeta({
        title: '支付成功',
        price,
        clientId,
        tip: '会员已开通，可关闭窗口继续提问。',
        orderText: `订单号：${orderId}`,
        statusText: '✓ 支付成功，会员已开通',
        statusPaid: true,
      });
      showToast('会员已开通');
      syncQuotaFromServer();
    },
    onError: () => {
      /* 轮询偶发失败忽略 */
    },
  });
}

function invokeWechatJsapi(jsapi) {
  return new Promise((resolve, reject) => {
    const params = {
      appId: jsapi.appId,
      timeStamp: jsapi.timeStamp,
      nonceStr: jsapi.nonceStr,
      package: jsapi.package,
      signType: jsapi.signType || 'RSA',
      paySign: jsapi.paySign,
    };
    const onBridgeReady = () => {
      window.WeixinJSBridge.invoke('getBrandWCPayRequest', params, (res) => {
        if (res.err_msg === 'get_brand_wcpay_request:ok') resolve(res);
        else reject(new Error(res.err_msg || '支付未完成'));
      });
    };
    if (typeof window.WeixinJSBridge === 'undefined') {
      document.addEventListener('WeixinJSBridgeReady', onBridgeReady, { once: true });
    } else {
      onBridgeReady();
    }
  });
}

async function startWechatOnlinePay() {
  const btn = document.getElementById('btn-wechat-online-pay');
  if (btn) btn.disabled = true;
  try {
    const channel = detectPayEnv().wechat ? 'jsapi' : 'native';
    const data = await createWechatPayOrder(selectedPlan, channel);
    if (data.stub && !data.codeUrl && !data.jsapi) {
      showToast(data.message || '在线支付尚未配置，请用静态收款码');
      openDynamicPayViewer(data);
      return;
    }
    openDynamicPayViewer(data);
  } catch (e) {
    showToast(e.message || '创建订单失败');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function closePayQrViewer() {
  stopOnlinePoll();
  const viewer = document.getElementById('pay-qr-viewer');
  viewer?.classList.remove('open');
  viewer?.setAttribute('aria-hidden', 'true');
}

function scrollToPaymentForm() {
  closePayQrViewer();
  const details = document.querySelector('.pay-bank-details');
  if (details && !details.open) details.open = true;
  document.getElementById('payment-form')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  showToast('请填写汇款信息并提交，便于核实开通会员');
}

function initPayQrGrid() {
  document.getElementById('pay-qr-grid')?.addEventListener('click', (e) => {
    const card = e.target.closest('[data-pay-channel]');
    if (!card) return;
    openPayQrViewer(card.dataset.payChannel);
  });

  document.getElementById('btn-wechat-online-pay')?.addEventListener('click', startWechatOnlinePay);

  document.querySelectorAll('[data-close-pay-qr]').forEach((el) => {
    el.addEventListener('click', closePayQrViewer);
  });

  document.getElementById('btn-copy-pay-client')?.addEventListener('click', () => {
    const id = document.getElementById('pay-qr-viewer-client')?.textContent;
    if (id) navigator.clipboard?.writeText(id).then(() => showToast('已复制设备编号'));
  });

  document.getElementById('btn-copy-pay-amount')?.addEventListener('click', () => {
    const price = String(getSelectedPrice());
    navigator.clipboard?.writeText(price).then(() => showToast(`已复制金额 ¥${price}`));
  });

  // 「我已付款 · 提交核实」：预填后一键提交（以前只是滚动到表单，客户还要手填 4 项）
  document.getElementById('btn-pay-done')?.addEventListener('click', () => submitFromViewer());
}

function renderBankInfo() {
  const el = document.getElementById('bank-info');
  if (!el) return;
  el.innerHTML = `
    <dl class="bank-dl">
      <dt>公司名称</dt><dd>${COMPANY.name}</dd>
      <dt>公司账号</dt><dd><code>${COMPANY.account}</code> <button type="button" class="btn-copy" data-copy="${COMPANY.account}">复制</button></dd>
      <dt>公司卡号</dt><dd><code>${COMPANY.cardNo}</code> <button type="button" class="btn-copy" data-copy="${COMPANY.cardNo}">复制</button></dd>
      <dt>开户行</dt><dd>${COMPANY.bank}</dd>
    </dl>
    <p class="modal-hint">请使用对公转账，汇款备注请填写您的 Q问 设备编号（见下方），便于核对到账。</p>
    <p class="client-id-hint">设备编号：<code id="pay-client-id"></code> <button type="button" class="btn-copy" id="btn-copy-client">复制</button></p>
  `;
}

function renderPlanCards() {
  const grid = document.getElementById('plan-grid');
  if (!grid) return;
  grid.innerHTML = Object.values(PLANS)
    .map(
      (p) =>
        `<button type="button" class="plan-card${p.id === selectedPlan ? ' plan-selected' : ''}" data-plan="${p.id}">${p.label}<br><strong>¥${p.price}</strong></button>`,
    )
    .join('');
  grid.querySelectorAll('[data-plan]').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedPlan = btn.dataset.plan;
      updatePlanUI();
      const amountInput = document.querySelector('#payment-form input[name="amount"]');
      if (amountInput) amountInput.value = String(PLANS[selectedPlan].price);
    });
  });
}

function updatePlanUI() {
  document.querySelectorAll('[data-plan]').forEach((btn) => {
    btn.classList.toggle('plan-selected', btn.dataset.plan === selectedPlan);
  });
  const plan = PLANS[selectedPlan];
  const priceEl = document.getElementById('selected-plan-price');
  if (priceEl && plan) priceEl.textContent = `¥${plan.price}`;
  const viewerPrice = document.getElementById('pay-qr-viewer-price');
  if (viewerPrice && plan) viewerPrice.textContent = `¥${plan.price}`;
}

export function openSubscribeModal() {
  const modal = document.getElementById('subscribe-modal');
  if (!modal) return;
  renderBankInfo();
  renderPlanCards();
  const idEl = document.getElementById('pay-client-id');
  if (idEl) idEl.textContent = getClientId();
  // 金额/时间/付款人一次性预填好；remark 仍留设备编号作为占位提示
  prefillPaymentForm();
  const remarkInput = document.querySelector('#payment-form input[name="remark"]');
  if (remarkInput && !remarkInput.value) remarkInput.placeholder = getClientId();
  updatePlanUI();
  modal.classList.add('open');
}

export function closeSubscribeModal() {
  stopOnlinePoll();
  document.getElementById('subscribe-modal')?.classList.remove('open');
}

export function initSubscribeModal() {
  const modal = document.getElementById('subscribe-modal');
  if (!modal) return;

  document.querySelectorAll('[data-close-subscribe]').forEach((el) => {
    el.addEventListener('click', closeSubscribeModal);
  });

  renderPlanCards();

  modal.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      navigator.clipboard?.writeText(copyBtn.dataset.copy || '').then(() => showToast('已复制'));
      return;
    }
    if (e.target.id === 'btn-copy-client') {
      const id = document.getElementById('pay-client-id')?.textContent;
      if (id) navigator.clipboard?.writeText(id).then(() => showToast('已复制设备编号'));
    }
  });

  document.getElementById('payment-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const plan = selectedPlan;
    const planInfo = PLANS[plan];
    const amount = Number(fd.get('amount'));
    if (amount !== planInfo.price) {
      showToast(`请按 ${planInfo.label} 金额 ¥${planInfo.price} 汇款`);
      return;
    }
    const payload = {
      plan,
      payerName: fd.get('payerName')?.toString().trim(),
      paidAt: fd.get('paidAt')?.toString().trim(),
      amount,
      remark: fd.get('remark')?.toString().trim(),
    };
    if (!payload.payerName || !payload.paidAt) {
      showToast('请填写汇款人姓名与汇款时间');
      return;
    }
    const data = await submitPaymentRequest(payload);
    showToast(data.message || '已提交，等待核实');
    closeSubscribeModal();
    e.target.reset();
    syncQuotaFromServer();
  });

  updatePlanUI();
  initPayQrGrid();
}
