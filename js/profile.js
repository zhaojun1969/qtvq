import { getUser, saveUser, refreshStatUI, showToast, syncQuotaFromServer } from './app.js';
import { getQuotaStatus, PLANS, formatQuotaStatusText } from './quota.js';
import { recommendFateType, buildFateCardText } from './fate.js';
import { UNLOCK_ITEMS } from './data.js';

function renderFateMatch() {
  const el = document.getElementById('fate-match');
  if (!el) return;
  const type = recommendFateType();
  el.innerHTML = `
    <p class="fate-type-name">${type.name}</p>
    <p class="fate-type-desc">${type.desc}</p>
    <p class="fate-pits-title">这类人常见的 3 个坑：</p>
    <ul>${type.pits.map((p) => `<li>${p}</li>`).join('')}</ul>
    <a href="pitfalls.html" class="btn btn-secondary" style="margin-top:0.75rem">去看对应避坑</a>
  `;
}

function renderUnlocks() {
  const el = document.getElementById('unlock-list');
  const reportBtn = document.getElementById('btn-report');
  if (!el) return;
  const user = getUser();
  const total = user.qCoins + user.wisdom;
  el.innerHTML = UNLOCK_ITEMS.map((item) => {
    const ok = total >= item.need;
    return `<div class="unlock-item ${ok ? 'unlocked' : ''}">
      <span class="unlock-need">${item.need} 分</span>
      <strong>${item.title}</strong>
      <p>${item.desc}</p>
      ${ok ? '<span class="unlock-badge">已解锁</span>' : ''}
    </div>`;
  }).join('');
  const coachBtn = document.getElementById('btn-coach');
  if (reportBtn) reportBtn.disabled = total < 200;
  if (coachBtn) coachBtn.disabled = total < 100;
}

function generateReport() {
  const user = getUser();
  const read = JSON.parse(localStorage.getItem('qtvq_read') || '[]');
  const type = recommendFateType();
  const report = `【我心永恒-Q问 · 定制避坑报告】

缘类型：${type.name}
Q币：${user.qCoins} · 智慧：${user.wisdom} · 直线值：${user.lineValue}
已学避坑：${read.length} 条

近期关注：
${(user.questionHistory || []).slice(0, 5).map((q) => '· ' + q).join('\n') || '· 暂无'}

建议优先巩固：${type.pits.join('、')}

—— 演示报告 · qtvq.cn`;
  const blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'Q问-避坑报告.txt';
  a.click();
  showToast('报告已下载');
}

function updateFateCard() {
  const text = document.getElementById('fate-card-text');
  const btn = document.getElementById('btn-share-card');
  const user = getUser();
  const readCount = JSON.parse(localStorage.getItem('qtvq_read') || '[]').length;
  const canUnlock = user.qCoins >= 10 || readCount >= 3 || user.questionHistory?.length >= 1;

  if (canUnlock) {
    text.textContent = buildFateCardText().replace(/\n/g, ' · ');
    btn.disabled = false;
  }
}

document.getElementById('btn-share-card')?.addEventListener('click', () => {
  const card = buildFateCardText();
  if (navigator.share) {
    navigator.share({ title: '缘分直线卡', text: card, url: location.origin });
  } else {
    navigator.clipboard?.writeText(card);
    showToast('直线卡已复制');
  }
});

document.getElementById('btn-invite')?.addEventListener('click', () => {
  const link = `${location.origin}${location.pathname.replace('profile.html', 'index.html')}?ref=pioneer`;
  navigator.clipboard?.writeText(link).then(() => showToast('邀请链接已复制，好友注册后 +5 次高级问答（演示）'));
});

document.getElementById('fate-auth')?.addEventListener('change', (e) => {
  const user = getUser();
  user.fateAuth = e.target.checked;
  saveUser(user);
  document.getElementById('q-yuan-panel').hidden = !e.target.checked;
  showToast(e.target.checked ? '已开启 Q缘连线（演示）' : '已关闭 Q缘连线');
});

document.getElementById('btn-coask')?.addEventListener('click', () => {
  const topic = document.getElementById('coask-topic')?.value.trim();
  if (!topic) {
    showToast('请输入共建提问主题');
    return;
  }
  showToast('已匹配同专题用户（演示），将跳转 Q问');
  setTimeout(() => {
    location.href = `index.html?q=${encodeURIComponent(topic)}`;
  }, 800);
});

const user = getUser();
if (document.getElementById('fate-auth')) {
  document.getElementById('fate-auth').checked = !!user.fateAuth;
  document.getElementById('q-yuan-panel').hidden = !user.fateAuth;
}

document.getElementById('btn-report')?.addEventListener('click', generateReport);

document.getElementById('btn-coach')?.addEventListener('click', () => {
  document.getElementById('coach-modal')?.classList.add('open');
});

document.querySelectorAll('[data-close-coach]').forEach((el) => {
  el.addEventListener('click', () => document.getElementById('coach-modal')?.classList.remove('open'));
});

document.getElementById('coach-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const list = JSON.parse(localStorage.getItem('qtvq_coach_bookings') || '[]');
  list.push({ at: Date.now(), email: new FormData(e.target).get('email'), topic: new FormData(e.target).get('topic') });
  localStorage.setItem('qtvq_coach_bookings', JSON.stringify(list));
  document.getElementById('coach-modal')?.classList.remove('open');
  e.target.reset();
  showToast('预约已提交（演示），客服将邮件联系');
});

function renderSubscription() {
  const el = document.getElementById('subscription-detail');
  if (!el) return;
  const user = getUser();
  const q = getQuotaStatus(user);
  if (q.unlimited && user.subscription) {
    const until = new Date(user.subscription.activeUntil).toLocaleString('zh-CN');
    el.textContent = `已开通 ${user.subscription.label || PLANS[user.subscription.plan]?.label}，不限次数提问，有效期至 ${until}`;
  } else if (user.paymentPending?.status === 'pending') {
    const p = user.paymentPending;
    el.textContent = `已提交 ${p.planLabel || PLANS[p.plan]?.label || ''} 汇款核实（¥${p.amount}）。核对工行到账后将解禁，设备编号：${p.clientId || '见会员弹窗'}`;
  } else {
    el.textContent = `${formatQuotaStatusText(user)}。超出后可办理月卡 ¥28 / 季卡 ¥78 / 年卡 ¥288。`;
  }
}

document.getElementById('btn-profile-subscribe')?.addEventListener('click', () => {
  location.href = 'index.html?subscribe=1';
});

renderFateMatch();
renderUnlocks();
updateFateCard();
renderSubscription();
syncQuotaFromServer().then(() => {
  renderSubscription();
  refreshStatUI();
});
refreshStatUI();
