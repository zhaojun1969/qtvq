import { mountLogo } from './logo.js';
import { getClientId } from './quota.js';
import { getUser, saveUser, refreshStatUI, syncQuotaFromServer } from './app.js';
import { initContactModal } from './contact.js';
import { flushOfflineQueue } from './api-fetch.js';
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

function initNav() {
  const nav = document.querySelector('.nav-main');
  if (!nav) return;

  // 用统一清单重建功能导航（覆盖各页面自己写的旧列表）
  nav.textContent = '';
  for (const item of NAV_ITEMS) {
    const a = document.createElement('a');
    a.href = item.href;
    a.textContent = item.label;
    nav.appendChild(a);
  }

  // 账户入口：与功能导航视觉分离；文案只表示"登录状态"，不显示微信/手机号
  if (!nav.querySelector('[data-nav-account]')) {
    const acct = document.createElement('a');
    acct.href = 'account.html';
    acct.setAttribute('data-nav-account', '');
    acct.className = 'nav-account';
    acct.innerHTML = '<span data-auth-label>登录 / 注册</span>';
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
