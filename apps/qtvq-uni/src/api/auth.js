import { post, get } from './request.js';
import { getClientId } from '../utils/clientId.js';
import {
  setAuthSession,
  clearAuthSession,
  bindAccountClientId,
  getAuthToken,
  getAuthUser,
  authHeader,
} from '../utils/auth.js';

function applyAuth(data) {
  if (data.user && data.token) setAuthSession(data.token, data.user);
  if (data.user?.clientId) bindAccountClientId(data.user.clientId);
  return data;
}

export function registerAccount(phone, password) {
  return post('/api/auth', {
    action: 'register',
    phone,
    password,
    clientId: getClientId(),
  }).then(applyAuth);
}

export function loginAccount(phone, password) {
  return post('/api/auth', {
    action: 'login',
    phone,
    password,
    clientId: getClientId(),
  }).then(applyAuth);
}

export function loginWechat(code) {
  return post('/api/auth/wechat', {
    code,
    clientId: getClientId(),
  }).then(applyAuth);
}

export function resetPasswordWechat(phone, newPassword, code) {
  return post('/api/auth/wechat', {
    action: 'resetPassword',
    phone,
    newPassword,
    code,
  }).then(applyAuth);
}

export function changePassword(oldPassword, newPassword) {
  return post('/api/auth', {
    action: 'changePassword',
    oldPassword,
    newPassword,
  });
}

export function fetchAccountMe() {
  const token = getAuthToken();
  if (!token) return Promise.reject(new Error('未登录'));
  return get('/api/auth/me', { token }).then((data) => {
    if (data.user?.clientId) bindAccountClientId(data.user.clientId);
    const prev = getAuthUser() || {};
    setAuthSession(token, { ...prev, ...data.user });
    return data;
  });
}

export function logoutAccount() {
  const token = getAuthToken();
  clearAuthSession();
  if (!token) return Promise.resolve({ ok: true });
  return post('/api/auth', { action: 'logout', token }, authHeader()).catch(() => ({ ok: true }));
}

export function wechatLoginCode() {
  return new Promise((resolve, reject) => {
    uni.login({
      provider: 'weixin',
      success: (res) => {
        if (res.code) resolve(res.code);
        else reject(new Error('未获取微信 code'));
      },
      fail: reject,
    });
  });
}
