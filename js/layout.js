import { mountLogo } from './logo.js';
import { getClientId } from './quota.js';
import { getUser, saveUser, refreshStatUI, syncQuotaFromServer } from './app.js';
import { initContactModal } from './contact.js';
import { track } from './track.js';
import { flushOfflineQueue, probeDirectOrigin } from './api-fetch.js';
import { fetchAccountMe, isLoggedIn, refreshAuthNav } from './auth.js';

const PAGES = { index: 'index.html', pitfalls: 'pitfalls.html', profile: 'profile.html', account: 'account.html', help: 'help.html' };

/**
 * 全站统一导航 —— **唯一权威定义**，改这里就全站生效。
 *
 * 「进」（功能入口）与「出」（账户 / 登录态）刻意分成两块：
 *   功能导航永远只有下面这 5 项，顺序固定、每个页面完全一致；
 *   账户入口单独追加（.nav-account），不参与功能导航。
 *
 * 起因（2026-09-16 业务方反馈）：以前每个 HTML 各写一份 <nav class="nav-main">，
 * 于是 index/wheel 有 5 项、report 少了「转盘配对」、account 多了「我的账户」、
 * 其余页面只有 3 项；而账户入口的文案会随登录方式变成「微信用户」，
 * 与页面里硬编码的「我的账户」并列出现，看起来像凭空多出一栏。
 * 现在无论页面里写了什么，都在这里被重建成同一份清单。
 */
const NAV_ITEMS = [
  { href: 'index.html', label: 'Q问' },
  { href: 'wheel.html', label: '转盘配对' },
  { href: 'pitfalls.html', label: '避坑大全' },
  { href: 'report.html', label: '配对报告' },
  { href: 'profile.html', label: '我的缘值' },
];
/*
 * 六项等宽：**用内联样式写死**，不依赖样式表。
 * 理由：导航本身就是这里用 JS 重建的，而样式表可能被浏览器缓存旧版本 ——
 * 业务方多次反馈"六个栏目宽度仍不一致"，而线上 CSS 规则我逐条核过都是对的。
 * 内联样式优先级高于任何外部样式表（对方除非写 !important），且每次重建都重新施加，
 * 所以**无论浏览器手里是哪一份 CSS，宽度都一致**。这是能一次性了结此事的做法。
 */
function applyNavItemBox(el) {
  el.style.display = 'inline-flex';
  el.style.alignItems = 'center';
  el.style.justifyContent = 'center';
  el.style.boxSizing = 'border-box';
  el.style.flex = '0 0 6.2rem';
  el.style.width = '6.2rem';
  el.style.minWidth = '6.2rem';
  el.style.maxWidth = '6.2rem';
  el.style.padding = '0.45rem 0.4rem';
  el.style.textAlign = 'center';
  el.style.whiteSpace = 'nowrap';
}
function initNav() {
  const nav = document.querySelector('.nav-main');
  if (!nav) return;

  // 用统一清单重建功能导航（覆盖各页面自己写的旧列表）
  nav.textContent = '';
  for (const item of NAV_ITEMS) {
    const a = document.createElement('a');
    a.href = item.href;
    a.textContent = item.label;
    applyNavItemBox(a);   // ← 六项等宽（内联写死，不受缓存样式表影响）
    nav.appendChild(a);
  }

  // 账户入口：与功能导航视觉分离；文案只表示"登录状态"，不显示微信/手机号
  if (!nav.querySelector('[data-nav-account]')) {
    const acct = document.createElement('a');
    acct.href = 'account.html';
    acct.setAttribute('data-nav-account', '');
    acct.className = 'nav-account';
    acct.innerHTML = '<span data-auth-label>登录 / 注册</span>';
    applyNavItemBox(acct);   // ← 账户入口同样等宽
    nav.appendChild(acct);
  }
  refreshAuthNav();
}

function initPioneerSlot() {
  const user = getUser();
  if (user.pioneerRegistered) return;
  user.pioneerRegistered = true;
  user.pioneerAsksLeft = user.pioneerAsksLeft ?? 10;
  user.isPioneer = true;
  saveUser(user);
}

function initMobileNav() {
  const header = document.querySelector('.header-inner');
  if (!header || header.querySelector('.nav-toggle')) return;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'nav-toggle';
  toggle.setAttribute('aria-label', '打开菜单');
  toggle.textContent = '☰';

  const nav = header.querySelector('.nav-main');
  if (!nav) return;

  header.insertBefore(toggle, nav);
  toggle.addEventListener('click', () => {
    nav.classList.toggle('open');
    toggle.textContent = nav.classList.contains('open') ? '✕' : '☰';
  });

  nav.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', () => nav.classList.remove('open'));
  });
}

function setActiveNav() {
  const path = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-main a').forEach((a) => {
    const href = a.getAttribute('href');
    a.classList.toggle('active', href === path || (path === '' && href === 'index.html'));
  });
}

getClientId();
initNav();
initContactModal();
mountLogo();
initPioneerSlot();
initMobileNav();
setActiveNav();
syncQuotaFromServer();
if (isLoggedIn()) fetchAccountMe().catch(() => {});
refreshStatUI();
flushOfflineQueue().catch(() => {});

if (document.querySelector('[data-quota-status]')) {
  setInterval(() => {
    refreshStatUI();
    flushOfflineQueue().catch(() => {});
  }, 60000);
}

export { PAGES };

/*
 * 探测 API 独立域名（api.qtvq.cn）是否可用 —— 结果只在**下次加载**生效。
 * 放在 layout.js 是因为它被 11 个页面全部引用，一处改动即全站覆盖。
 * 失败/超时都只是把标记置 0，等同现状（同源），不会影响本次渲染。
 */
if (typeof window !== 'undefined') {
  if (document.readyState === 'complete') probeDirectOrigin();
  else window.addEventListener('load', () => probeDirectOrigin(), { once: true });

/*
 * 埋点接线（P0-T0.3）：只有报告页有对应的落地事件（书里 §7 的白名单）。
 * 其它页面暂不上报 —— 往字典里随手加事件会让三个月后的看板什么都查不出来。
 */
window.addEventListener(
  'load',
  () => {
    try {
      if (location.pathname.endsWith('/report.html') || location.pathname.endsWith('report.html')) {
        track('report_landing_view', { from: document.referrer ? 'referral' : 'direct' });
      }
    } catch {
      /* 埋点永不打断主流程 */
    }
  },
  { once: true },
);
}
