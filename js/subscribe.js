import { PLANS, COMPANY, getClientId } from './quota.js';
import { submitPaymentRequest, showToast, syncQuotaFromServer } from './app.js';
import { PAY_CHANNELS, detectPayEnv } from './pay-qr.js';

let selectedPlan = 'month';

function getSelectedPrice() {
  return PLANS[selectedPlan]?.price ?? 288;
}

function openPayQrViewer(channelId) {
  const ch = PAY_CHANNELS[channelId];
  if (!ch) return;

  const viewer = document.getElementById('pay-qr-viewer');
  const price = getSelectedPrice();
  const clientId = getClientId();

  document.getElementById('pay-qr-viewer-title').textContent = `${ch.label} · 扫码付款`;
  document.getElementById('pay-qr-viewer-price').textContent = `¥${price}`;
  document.getElementById('pay-qr-viewer-client').textContent = clientId;
  const img = document.getElementById('pay-qr-viewer-img');
  img.src = ch.image;
  img.alt = `${ch.label}收款码`;
  document.getElementById('pay-qr-viewer-tip').textContent = ch.tip;

  viewer?.classList.add('open');
  viewer?.setAttribute('aria-hidden', 'false');

  const env = detectPayEnv();
  if (ch.openApp && (env.alipay && channelId.startsWith('alipay'))) {
    setTimeout(() => {
      try {
        window.location.href = ch.openApp;
      } catch {
        /* 留在当前页展示二维码 */
      }
    }, 400);
  }
}

function closePayQrViewer() {
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

  document.getElementById('btn-pay-done')?.addEventListener('click', scrollToPaymentForm);
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
  const idEl = document.getElementById('pay-client-id');
  if (idEl) idEl.textContent = getClientId();
  const amountInput = document.querySelector('#payment-form input[name="amount"]');
  const plan = PLANS[selectedPlan];
  if (amountInput && plan) amountInput.value = String(plan.price);
  const remarkInput = document.querySelector('#payment-form input[name="remark"]');
  if (remarkInput && !remarkInput.value) remarkInput.placeholder = getClientId();
  updatePlanUI();
  modal.classList.add('open');
}

export function closeSubscribeModal() {
  document.getElementById('subscribe-modal')?.classList.remove('open');
}

export function initSubscribeModal() {
  const modal = document.getElementById('subscribe-modal');
  if (!modal) return;

  document.querySelectorAll('[data-close-subscribe]').forEach((el) => {
    el.addEventListener('click', closeSubscribeModal);
  });

  document.querySelectorAll('[data-plan]').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedPlan = btn.dataset.plan;
      updatePlanUI();
      const amountInput = document.querySelector('#payment-form input[name="amount"]');
      if (amountInput) amountInput.value = String(PLANS[selectedPlan].price);
    });
  });

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
