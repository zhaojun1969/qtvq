/** 注册 / 登录会话（手机号 + 密码） */

import { apiFetch } from './api-fetch.js';
import { getClientId } from './quota.js';
import { applyServerQuota } from './app.js';

const TOKEN_KEY = 'qtvq_auth_token';
const USER_KEY = 'qtvq_auth_user';

export function getAuthToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function getAuthUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setAuthSession(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearAuthSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function bindAccountClientId(clientId) {
  if (clientId) localStorage.setItem('qtvq_client_id', clientId);
}

function authHeaders(extra = {}) {
  const token = getAuthToken();
  const headers = { 'Content-Type': 'application/json', ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function applyAuthPayload(data) {
  if (data.user) setAuthSession(data.token, data.user);
  if (data.user?.clientId) bindAccountClientId(data.user.clientId);
  if (data.quota) applyServerQuota(data.quota);
  return data;
}

export async function registerAccount(phone, password) {
  const clientId = getClientId();
  const res = await apiFetch('/api/auth', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ action: 'register', phone, password, clientId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '注册失败');
  return applyAuthPayload(data);
}

export async function loginAccount(phone, password) {
  const clientId = getClientId();
  const res = await apiFetch('/api/auth', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ action: 'login', phone, password, clientId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '登录失败');
  return applyAuthPayload(data);
}

export async function fetchAccountMe() {
  const token = getAuthToken();
  if (!token) return null;
  const res = await apiFetch('/api/auth/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 401) clearAuthSession();
    throw new Error(data.error || '获取账户失败');
  }
  if (data.user?.clientId) bindAccountClientId(data.user.clientId);
  if (data.quota) applyServerQuota(data.quota);
  if (data.user) {
    const prev = getAuthUser() || {};
    setAuthSession(token, { ...prev, ...data.user });
  }
  return data;
}

export async function changePassword(oldPassword, newPassword) {
  const res = await apiFetch('/api/auth', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ action: 'changePassword', oldPassword, newPassword }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '修改失败');
  return data;
}

const WX_STATE_KEY = 'qtvq_wx_open_state';
const WX_FORGOT_KEY = 'qtvq_wx_open_forgot';

export async function fetchWechatOpenConfig(state) {
  const qs = state ? `?state=${encodeURIComponent(state)}` : '';
  const res = await apiFetch(`/api/auth/wechat/open${qs}`);
  const data = await res.json();
  if (!res.ok || !data.configured) throw new Error(data.hint || data.error || '网站应用登录未配置');
  return data;
}

export async function startWechatOpenLogin({ forReset = false } = {}) {
  const state = crypto.randomUUID().replace(/-/g, '');
  sessionStorage.setItem(WX_STATE_KEY, state);
  if (forReset) sessionStorage.setItem(WX_FORGOT_KEY, '1');
  else sessionStorage.removeItem(WX_FORGOT_KEY);
  const cfg = await fetchWechatOpenConfig(state);
  location.href = cfg.loginUrl;
}

export async function loginWechatOpen(code, state) {
  const saved = sessionStorage.getItem(WX_STATE_KEY);
  if (!saved || saved !== state) throw new Error('登录状态校验失败，请重试');
  sessionStorage.removeItem(WX_STATE_KEY);

  const forReset = sessionStorage.getItem(WX_FORGOT_KEY) === '1';
  sessionStorage.removeItem(WX_FORGOT_KEY);

  const clientId = getClientId();
  const body = { code, clientId };
  if (forReset) {
    const form = document.getElementById('forgot-form');
    const fd = form ? new FormData(form) : null;
    const phone = fd?.get('phone')?.toString().trim();
    const np = fd?.get('newPassword')?.toString();
    const np2 = fd?.get('newPassword2')?.toString();
    if (!phone || !np || np !== np2) throw new Error('请先填写手机号与一致的新密码');
    body.action = 'resetPassword';
    body.phone = phone;
    body.newPassword = np;
  }

  const res = await apiFetch('/api/auth/wechat/open', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '微信登录失败');
  return applyAuthPayload(data);
}

export async function handleWechatOpenCallback() {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code) return null;
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
  return loginWechatOpen(code, state);
}

export async function logoutAccount() {
  const token = getAuthToken();
  if (token) {
    try {
      await apiFetch('/api/auth', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ action: 'logout', token }),
      });
    } catch {
      /* ignore */
    }
  }
  clearAuthSession();
}

export function isLoggedIn() {
  return !!getAuthToken();
}

export function refreshAuthNav() {
  const user = getAuthUser();
  document.querySelectorAll('[data-auth-label]').forEach((el) => {
    if (!user) el.textContent = '登录 / 注册';
    else if (user.phone) el.textContent = user.phone;
    else if (user.wechatBound) el.textContent = '微信用户';
    else el.textContent = '我的账户';
  });
  document.querySelectorAll('[data-auth-logged]').forEach((el) => {
    el.hidden = !user;
  });
  document.querySelectorAll('[data-auth-guest]').forEach((el) => {
    el.hidden = !!user;
  });
}
