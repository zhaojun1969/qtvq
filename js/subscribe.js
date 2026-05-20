import { PLANS, COMPANY, getClientId } from './quota.js';
import { submitPaymentRequest, showToast, syncQuotaFromServer } from './app.js';

let selectedPlan = 'month';

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
}
