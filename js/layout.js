import { mountLogo } from './logo.js';
import { getClientId } from './quota.js';
import { getUser, saveUser, refreshStatUI, syncQuotaFromServer } from './app.js';
import { initContactModal } from './contact.js';
import { flushOfflineQueue } from './api-fetch.js';
import { fetchAccountMe, isLoggedIn, refreshAuthNav } from './auth.js';

const PAGES = { index: 'index.html', pitfalls: 'pitfalls.html', profile: 'profile.html', account: 'account.html', help: 'help.html' };

function initAuthNav() {
  const nav = document.querySelector('.nav-main');
  if (!nav || nav.querySelector('[data-nav-account]')) return;
  const a = document.createElement('a');
  a.href = 'account.html';
  a.setAttribute('data-nav-account', '');
  a.innerHTML = '<span data-auth-label>登录 / 注册</span>';
  nav.appendChild(a);
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
initAuthNav();
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
