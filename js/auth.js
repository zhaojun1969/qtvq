/** 注册 / 登录会话（手机号 + 密码） */

import { apiFetch } from './api-fetch.js';
import { getClientId } from './quota.js';
import { applyServerQuota } from './app.js';
import { channel, track } from './track.js';

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

/**
 * 归因信息（P3-T3.2）：渠道码来自 URL `?ch=`（track.js 已持久化），
 * 邀请人来自分享卡落地页写进 localStorage 的 `qtvq_inviter`。
 * 两个都拿不到就都不带 —— 服务端 normalizeAcquisition 会当成"无归因"，
 * 而不是记一条 channel=direct 的假归因。
 */
function acquisitionPayload() {
  const out = {};
  try {
    const ch = channel();
    if (ch && ch !== 'direct') out.ch = ch;
  } catch {
    /* track.js 不可用时忽略 */
  }
  try {
    const inviter = JSON.parse(localStorage.getItem('qtvq_inviter') || 'null');
    if (inviter?.uid && /^[A-Za-z0-9_-]{6,64}$/.test(inviter.uid)) out.inviterUid = inviter.uid;
    if (inviter?.at) out.landingAt = Number(inviter.at) || Date.now();
  } catch {
    /* 坏数据当没有 */
  }
  return out;
}

export async function registerAccount(phone, password) {
  const clientId = getClientId();
  const res = await apiFetch('/api/auth', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ action: 'register', phone, password, clientId, ...acquisitionPayload() }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '注册失败');
  // 注册带来的邀请券直接清掉：留着会在下次注册时重复上报同一个邀请人
  try {
    localStorage.removeItem('qtvq_inviter');
  } catch {
    /* 忽略 */
  }
  /*
   * 注册漏斗（`register`/`login` 在白名单里，但**不参与激活判据** ——
   * 激活只认 `profile_complete` / `question_asked`，否则"注册了没做过任何事"也算激活）。
   * 必须在 `applyAuthPayload` 之后报：埋点在 flush 时读 localStorage 的 token，
   * 会话没落地之前报出去就是 uid=null。
   */
  const out = applyAuthPayload(data);
  track('register', { method: 'phone' });
  return out;
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
  const out = applyAuthPayload(data);
  track('login', { method: 'phone' });
  return out;
}

/**
 * 短信找回密码（后端 /api/auth/sms）
 *
 * 优先级高于微信扫码：扫码要求账号已绑定微信且有开放平台主体，
 * 而短信只要手机号可用 —— 对"忘了密码又被锁在外面"的人，这是唯一能自助走通的路。
 */

async function postSms(payload) {
  const res = await apiFetch('/api/auth/sms', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

/** 短信服务是否已配置（未配置则不展示入口，避免点了没反应） */
export async function fetchSmsStatus() {
  try {
    const data = await postSms({ action: 'status' });
    return !!data.smsConfigured;
  } catch {
    return false;
  }
}

export async function sendSmsCode(phone) {
  return postSms({ action: 'send', phone });
}

export async function resetPasswordBySms({ phone, code, newPassword }) {
  return postSms({ action: 'reset', phone, code, newPassword });
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

const WX_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * state 校验（防 CSRF）：必须匹配我们自己生成的值。
 *
 * 2026-09-17 修：原来只把 state 存进 `sessionStorage`。它是**单标签页**作用域 ——
 * 换标签页、从微信内置浏览器/新窗口回到回调页、或隐私模式清理后，state 就"丢了"，
 * 于是扫码后被判成「登录状态校验失败」，登录永远失败（业务方反馈的"微信扫码登录老问题"）。
 * 现在双写 sessionStorage + localStorage（带 10 分钟时间戳），任一命中即通过，
 * 过期或都不命中才拒绝 —— 安全性不变（依然只接受我们自己发出的 state），但抗丢失能力强得多。
 */
function rememberWxState(state) {
  try {
    sessionStorage.setItem(WX_STATE_KEY, state);
  } catch {
    /* 隐私模式可能禁用 */
  }
  try {
    localStorage.setItem(WX_STATE_KEY, JSON.stringify({ state, at: Date.now() }));
  } catch {
    /* ignore */
  }
}

function consumeWxState(gotState) {
  const readSession = (() => {
    try {
      return sessionStorage.getItem(WX_STATE_KEY);
    } catch {
      return null;
    }
  })();
  let readLocal = null;
  try {
    const raw = localStorage.getItem(WX_STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && Date.now() - Number(parsed.at || 0) < WX_STATE_TTL_MS) {
        readLocal = parsed.state;
      }
    }
  } catch {
    /* ignore */
  }

  const matched = gotState && (gotState === readSession || gotState === readLocal);
  try {
    sessionStorage.removeItem(WX_STATE_KEY);
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(WX_STATE_KEY);
  } catch {
    /* ignore */
  }
  return matched;
}

export async function startWechatOpenLogin({ forReset = false } = {}) {
  const state = crypto.randomUUID().replace(/-/g, '');
  rememberWxState(state);
  try {
    if (forReset) sessionStorage.setItem(WX_FORGOT_KEY, '1');
    else sessionStorage.removeItem(WX_FORGOT_KEY);
  } catch {
    /* ignore */
  }
  const cfg = await fetchWechatOpenConfig(state);

  // 首选：微信内嵌二维码（小弹窗），扫码后**整个页面**跳回回调页 —— 业务方反馈
  // "点完跳到一个占满屏幕的大二维码页面"体验不合理。内嵌方式把二维码放进我们自己的弹窗，
  // 扫完自动回到 account.html。
  // self_redirect: false 是关键：true 只在 iframe 内跳转（弹窗里出不来），
  // false 才会让**顶层页面**跳到 redirect_uri。
  const embedded = await tryEmbeddedQrLogin(cfg, state);
  if (embedded) return;

  // 兜底：内嵌脚本加载失败（网络/被拦截）时，退回官方整页二维码，保证登录仍然可用
  console.warn('[wechat] 内嵌二维码不可用，退回整页扫码');
  location.href = cfg.loginUrl;
}

/** 动态加载微信官方 wxLogin.js（内嵌二维码） */
function loadWxLoginScript() {
  if (window.WxLogin) return Promise.resolve(true);
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'https://res.wx.qq.com/connect/zh_CN/htmledition/js/wxLogin.js';
    s.onload = () => resolve(!!window.WxLogin);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

async function tryEmbeddedQrLogin(cfg, state) {
  const modal = document.getElementById('wx-login-modal');
  const box = document.getElementById('wx-login-box');
  if (!modal || !box) return false;

  const ok = await loadWxLoginScript();
  if (!ok) return false;

  box.innerHTML = '';
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');

  try {
    // eslint-disable-next-line no-new
    new window.WxLogin({
      self_redirect: false, // 顶层页面跳转（弹窗里出不来）
      id: 'wx-login-box',
      appid: cfg.appId,
      scope: 'snsapi_login',
      redirect_uri: encodeURIComponent(cfg.redirectUri),
      state,
      style: 'black',
      href: '',
    });
    return true;
  } catch (err) {
    console.warn('[wechat] 内嵌二维码初始化失败：', err);
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    return false;
  }
}

/** 关闭扫码弹窗（用户取消时） */
export function closeWechatLoginModal() {
  const modal = document.getElementById('wx-login-modal');
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  try {
    sessionStorage.removeItem(WX_STATE_KEY);
    localStorage.removeItem(WX_STATE_KEY);
  } catch {
    /* ignore */
  }
}

export async function loginWechatOpen(code, state) {
  if (!consumeWxState(state)) {
    const err = new Error('登录状态校验失败（state 不匹配或已过期）');
    err.diagnostic = {
      reason: 'state_mismatch',
      gotState: state ? `${state.slice(0, 8)}…（长度 ${state.length}）` : '(回调里没有 state)',
      hint: '可能是回调页与发起登录的不是同一个标签页/浏览器，或超过 10 分钟才完成扫码。请回到账户页重新点「微信扫码登录」。',
    };
    throw err;
  }

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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `微信登录失败（HTTP ${res.status}）`);
    // 把服务端的原始响应带出去，回调页才能把"到底哪一步失败"显示给人看
    err.diagnostic = { reason: 'api_rejected', httpStatus: res.status, response: data };
    throw err;
  }
  const out = applyAuthPayload(data);
  // 同一个扫码流程既用于登录也用于找回密码（`action==='resetPassword'`），
  // 找回密码不算登录，别把漏斗算胖
  if (body.action !== 'resetPassword') track('login', { method: 'wechat' });
  return out;
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

/**
 * 注销账号（不可恢复）。
 * 有密码的账号传 password 做二次确认；纯微信账号（无密码）传 confirmText='注销账号'。
 * 服务端策略：订单脱敏保留；未到期会员或待核实付款会被拒绝（引导联系客服协商）。
 */
export async function deleteAccount({ password, confirmText } = {}) {
  const res = await apiFetch('/api/auth/delete', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(password ? { password } : { confirmText }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || '注销失败');
    err.code = data.code || null;
    throw err;
  }
  return data;
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
  // 导航里的账户入口只表达"登录状态"，不再显示手机号或「微信用户」：
  // 那是登录方式，不是栏目名，混进功能导航会让人以为多了一栏
  // （登录方式与绑定情况在 account.html 里展示）。
  document.querySelectorAll('[data-auth-label]').forEach((el) => {
    el.textContent = user ? '我的账户' : '登录 / 注册';
  });
  document.querySelectorAll('[data-auth-logged]').forEach((el) => {
    el.hidden = !user;
  });
  document.querySelectorAll('[data-auth-guest]').forEach((el) => {
    el.hidden = !!user;
  });
}
