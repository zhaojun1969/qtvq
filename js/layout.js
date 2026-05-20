import { mountLogo } from './logo.js';
import { getClientId } from './quota.js';
import { getUser, saveUser, refreshStatUI, syncQuotaFromServer } from './app.js';

const PAGES = { index: 'index.html', pitfalls: 'pitfalls.html', profile: 'profile.html' };

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
mountLogo();
initPioneerSlot();
initMobileNav();
setActiveNav();
syncQuotaFromServer();
refreshStatUI();

if (document.querySelector('[data-quota-status]')) {
  setInterval(() => refreshStatUI(), 60000);
}

export { PAGES };
