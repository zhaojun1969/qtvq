import { post, get } from './request.js';
import { getClientId } from '../utils/clientId.js';
import { attributionPayload, clearInviter } from '../utils/attribution.js';
import {
  setAuthSession,
  clearAuthSession,
  bindAccountClientId,
  getAuthToken,
  getAuthUser,
  authHeader,
} from '../utils/auth.js';
import { track } from '../utils/track.js';

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
    // 渠道码 + 邀请人（P3-T3.2）：没有归因就不带，服务端会当作无归因
    ...attributionPayload(),
  })
    .then((data) => {
      clearInviter(); // 发券已在服务端完成，别再对同一台设备的后续注册重复上报
      return data;
    })
    .then((data) => {
      const out = applyAuth(data);
      // 注册漏斗（不参与激活判据：激活只认 profile_complete / question_asked）
      track('register', { method: 'phone' });
      return out;
    });
}

export function loginAccount(phone, password) {
  return post('/api/auth', {
    action: 'login',
    phone,
    password,
    clientId: getClientId(),
  }).then((data) => {
    const out = applyAuth(data);
    track('login', { method: 'phone' });
    return out;
  });
}

export function loginWechat(code) {
  return post('/api/auth/wechat', {
    code,
    clientId: getClientId(),
  }).then((data) => {
    const out = applyAuth(data);
    track('login', { method: 'wechat' });
    return out;
  });
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

/* ───────────────── 短信找回密码（/api/auth/sms）─────────────────
 * 与 Web 端同一套：发送验证码（同号码 60 秒一次、每天最多 10 条，后端节流）
 * → 填验证码 + 新密码 → 校验通过即重置。不暴露手机号是否已注册。
 */
export function sendSmsCode(phone) {
  return post('/api/auth/sms', { action: 'send', phone });
}

export function resetPasswordBySms(phone, code, newPassword) {
  return post('/api/auth/sms', { action: 'reset', phone, code, newPassword });
}

export function fetchSmsStatus() {
  return post('/api/auth/sms', { action: 'status' }).catch(() => ({ smsConfigured: false }));
}

/* ───────────────── 注销账号（/api/auth/delete）─────────────────
 * 服务端会再拦一道：会员未到期（未协商）或有待核实付款时不允许自助注销；
 * 注销后订单以脱敏方式保留，其余（资料/凭证/提问/微信绑定）立即删除。
 */
export function deleteAccount({ password, confirmText } = {}) {
  const token = getAuthToken();
  if (!token) return Promise.reject(new Error('未登录'));
  return post('/api/auth/delete', { password, confirmText }, authHeader()).then((data) => {
    clearAuthSession();
    return data;
  });
}

/* ───────────────── 开放平台扫码登录（/api/auth/wechat/open）─────────────────
 * 小程序内一般用 wx.login（上面的 loginWechat），这条是给 **H5/PC 扫码**用的；
 * 在小程序里保留封装是为了 App 端与 H5 复用同一套 api 层。
 */
export function fetchWechatOpenConfig(state) {
  return get('/api/auth/wechat/open', state ? { state } : undefined);
}

export function loginWechatOpen(code, state, clientId) {
  return post('/api/auth/wechat/open', { code, state, clientId: clientId || getClientId() }).then(applyAuth);
}
