/**
 * 用户注册/登录（手机号 + 密码），绑定 clientId 以便跨设备查看会员与打款状态
 */

import { validClientId } from './quota-store.js';

const USER_PREFIX = 'auth:user:';
const PHONE_PREFIX = 'auth:phone:';
const CLIENT_PREFIX = 'auth:client:';
const OPENID_PREFIX = 'auth:openid:';
const UNION_PREFIX = 'auth:union:';
const SESSION_PREFIX = 'auth:session:';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const memory = { users: new Map(), phones: new Map(), clients: new Map(), openids: new Map(), unions: new Map(), sessions: new Map() };

function getKv(env) {
  return env?.QTVQ_KV || null;
}

function validPhone(phone) {
  return typeof phone === 'string' && /^1[3-9]\d{9}$/.test(phone);
}

function validPassword(password) {
  return typeof password === 'string' && password.length >= 6 && password.length <= 64;
}

function maskPhone(phone) {
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function newUserId() {
  return `u_${Date.now().toString(36)}_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

function newToken() {
  return `${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`;
}

async function deriveHash(password, saltB64) {
  const enc = new TextEncoder();
  const salt = saltB64
    ? Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0))
    : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  const hash = btoa(String.fromCharCode(...new Uint8Array(bits)));
  const saltOut = saltB64 || btoa(String.fromCharCode(...salt));
  return { hash, salt: saltOut };
}

async function verifyPassword(password, hash, salt) {
  const derived = await deriveHash(password, salt);
  return derived.hash === hash;
}

async function loadUser(env, userId) {
  const kv = getKv(env);
  if (kv) {
    const raw = await kv.get(`${USER_PREFIX}${userId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return memory.users.get(userId) || null;
}

async function saveUser(env, user) {
  const kv = getKv(env);
  if (kv) {
    await kv.put(`${USER_PREFIX}${user.id}`, JSON.stringify(user));
    if (user.phone) await kv.put(`${PHONE_PREFIX}${user.phone}`, user.id);
    if (user.clientId) await kv.put(`${CLIENT_PREFIX}${user.clientId}`, user.id);
    if (user.wechatOpenId) await kv.put(`${OPENID_PREFIX}${user.wechatOpenId}`, user.id);
    if (user.wechatWebOpenId) await kv.put(`${OPENID_PREFIX}${user.wechatWebOpenId}`, user.id);
    if (user.wechatMpOpenId) await kv.put(`${OPENID_PREFIX}${user.wechatMpOpenId}`, user.id);
    if (user.wechatUnionId) await kv.put(`${UNION_PREFIX}${user.wechatUnionId}`, user.id);
  } else {
    memory.users.set(user.id, user);
    if (user.phone) memory.phones.set(user.phone, user.id);
    if (user.clientId) memory.clients.set(user.clientId, user.id);
    if (user.wechatOpenId) memory.openids.set(user.wechatOpenId, user.id);
    if (user.wechatWebOpenId) memory.openids.set(user.wechatWebOpenId, user.id);
    if (user.wechatMpOpenId) memory.openids.set(user.wechatMpOpenId, user.id);
    if (user.wechatUnionId) memory.unions.set(user.wechatUnionId, user.id);
  }
}

async function findUserIdByOpenId(env, openid) {
  const kv = getKv(env);
  if (kv) return (await kv.get(`${OPENID_PREFIX}${openid}`)) || null;
  return memory.openids?.get(openid) || null;
}

async function findUserIdByUnionId(env, unionId) {
  if (!unionId) return null;
  const kv = getKv(env);
  if (kv) return (await kv.get(`${UNION_PREFIX}${unionId}`)) || null;
  return memory.unions?.get(unionId) || null;
}

function wechatIdentityMatches(user, openid, unionId) {
  if (!user) return false;
  if (unionId && user.wechatUnionId === unionId) return true;
  const ids = [user.wechatOpenId, user.wechatWebOpenId, user.wechatMpOpenId].filter(Boolean);
  return ids.includes(openid);
}

function applyWechatIdentity(user, { openid, unionId, source = 'mp' }) {
  if (source === 'web') user.wechatWebOpenId = openid;
  else user.wechatMpOpenId = openid;
  user.wechatOpenId = openid;
  if (unionId) user.wechatUnionId = unionId;
  return user;
}

async function findUserIdByClientId(env, clientId) {
  const kv = getKv(env);
  if (kv) return (await kv.get(`${CLIENT_PREFIX}${clientId}`)) || null;
  return memory.clients.get(clientId) || null;
}

async function findUserIdByPhone(env, phone) {
  const kv = getKv(env);
  if (kv) return (await kv.get(`${PHONE_PREFIX}${phone}`)) || null;
  return memory.phones.get(phone) || null;
}

async function saveSession(env, token, data) {
  const kv = getKv(env);
  const payload = { ...data, expiresAt: Date.now() + SESSION_TTL_MS };
  if (kv) {
    await kv.put(`${SESSION_PREFIX}${token}`, JSON.stringify(payload), { expirationTtl: Math.ceil(SESSION_TTL_MS / 1000) });
  } else {
    memory.sessions.set(token, payload);
  }
  return payload;
}

async function loadSession(env, token) {
  if (!token) return null;
  const kv = getKv(env);
  let raw = null;
  if (kv) raw = await kv.get(`${SESSION_PREFIX}${token}`);
  else raw = memory.sessions.get(token);
  if (!raw) return null;
  try {
    const session = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (session.expiresAt <= Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

async function deleteSession(env, token) {
  const kv = getKv(env);
  if (kv) await kv.delete(`${SESSION_PREFIX}${token}`);
  else memory.sessions.delete(token);
}

function publicUser(user) {
  return {
    id: user.id,
    phone: user.phone ? maskPhone(user.phone) : null,
    wechatBound: !!user.wechatOpenId,
    hasPassword: !!user.passwordHash,
    clientId: user.clientId,
    createdAt: user.createdAt,
  };
}

async function createSession(env, user) {
  const token = newToken();
  await saveSession(env, token, { userId: user.id, clientId: user.clientId });
  return { token, user: publicUser(user) };
}

export async function registerUser(env, { phone, password, clientId }) {
  if (!validPhone(phone)) return { error: '请输入正确的 11 位手机号' };
  if (!validPassword(password)) return { error: '密码至少 6 位' };
  if (!validClientId(clientId)) return { error: '无效设备编号' };

  const existing = await findUserIdByPhone(env, phone);
  if (existing) return { error: '该手机号已注册，请直接登录' };

  const { hash, salt } = await deriveHash(password);
  const user = {
    id: newUserId(),
    phone,
    passwordHash: hash,
    passwordSalt: salt,
    clientId,
    createdAt: Date.now(),
  };
  await saveUser(env, user);
  return createSession(env, user);
}

export async function loginUser(env, { phone, password, clientId }) {
  if (!validPhone(phone)) return { error: '请输入正确的 11 位手机号' };
  if (!validPassword(password)) return { error: '密码错误' };
  if (!validClientId(clientId)) return { error: '无效设备编号' };

  const userId = await findUserIdByPhone(env, phone);
  if (!userId) return { error: '账号不存在，请先注册' };

  const user = await loadUser(env, userId);
  if (!user) return { error: '账号不存在，请先注册' };

  if (!user.passwordHash) return { error: '该账号使用微信登录，请点「微信登录」或在小程序打开' };

  const ok = await verifyPassword(password, user.passwordHash, user.passwordSalt);
  if (!ok) return { error: '手机号或密码错误' };

  return createSession(env, user);
}

export async function loginWechatUser(env, { openid, unionId, clientId, source = 'mp' }) {
  if (!openid || !validClientId(clientId)) return { error: '无效参数' };

  if (unionId) {
    const unionUserId = await findUserIdByUnionId(env, unionId);
    if (unionUserId) {
      const user = await loadUser(env, unionUserId);
      if (!user) return { error: '账号异常，请联系客服' };
      applyWechatIdentity(user, { openid, unionId, source });
      if (user.clientId !== clientId) user.clientId = clientId;
      await saveUser(env, user);
      return createSession(env, user);
    }
  }

  const existingId = await findUserIdByOpenId(env, openid);
  if (existingId) {
    const user = await loadUser(env, existingId);
    if (!user) return { error: '账号异常，请联系客服' };
    applyWechatIdentity(user, { openid, unionId, source });
    if (user.clientId !== clientId) user.clientId = clientId;
    await saveUser(env, user);
    return createSession(env, user);
  }

  const clientUserId = await findUserIdByClientId(env, clientId);
  if (clientUserId) {
    const user = await loadUser(env, clientUserId);
    if (user && !user.wechatOpenId && !user.wechatWebOpenId && !user.wechatMpOpenId) {
      applyWechatIdentity(user, { openid, unionId, source });
      await saveUser(env, user);
      return createSession(env, user);
    }
  }

  const user = {
    id: newUserId(),
    phone: null,
    passwordHash: null,
    passwordSalt: null,
    wechatOpenId: openid,
    wechatMpOpenId: source === 'mp' ? openid : null,
    wechatWebOpenId: source === 'web' ? openid : null,
    wechatUnionId: unionId || null,
    clientId,
    createdAt: Date.now(),
  };
  await saveUser(env, user);
  return createSession(env, user);
}

export async function changePassword(env, userId, { oldPassword, newPassword }) {
  if (!validPassword(newPassword)) return { error: '新密码至少 6 位' };
  const user = await loadUser(env, userId);
  if (!user) return { error: '用户不存在' };

  if (user.passwordHash) {
    if (!oldPassword) return { error: '请输入原密码' };
    const ok = await verifyPassword(oldPassword, user.passwordHash, user.passwordSalt);
    if (!ok) return { error: '原密码错误' };
  }

  const { hash, salt } = await deriveHash(newPassword);
  user.passwordHash = hash;
  user.passwordSalt = salt;
  await saveUser(env, user);
  return { ok: true, user: publicUser(user) };
}

export async function resetPasswordWithWechat(env, { phone, newPassword, openid, unionId }) {
  if (!validPhone(phone)) return { error: '请输入正确的手机号' };
  if (!validPassword(newPassword)) return { error: '新密码至少 6 位' };
  if (!openid) return { error: '微信验证失败' };

  const userId = await findUserIdByPhone(env, phone);
  if (!userId) return { error: '该手机号未注册' };

  const user = await loadUser(env, userId);
  if (!user) return { error: '该手机号未注册' };
  if (!user.wechatOpenId && !user.wechatWebOpenId && !user.wechatMpOpenId && !user.wechatUnionId) {
    return { error: '该账号未绑定微信，请先用微信登录一次，或联系客服' };
  }
  if (!wechatIdentityMatches(user, openid, unionId)) {
    return { error: '微信身份与手机号不匹配' };
  }

  const { hash, salt } = await deriveHash(newPassword);
  user.passwordHash = hash;
  user.passwordSalt = salt;
  await saveUser(env, user);
  return createSession(env, user);
}

export async function adminResetPassword(env, { phone, newPassword }) {
  if (!validPhone(phone)) return { error: '请输入正确的手机号' };
  if (!validPassword(newPassword)) return { error: '新密码至少 6 位' };

  const userId = await findUserIdByPhone(env, phone);
  if (!userId) return { error: '该手机号未注册' };

  const user = await loadUser(env, userId);
  if (!user) return { error: '该手机号未注册' };

  const { hash, salt } = await deriveHash(newPassword);
  user.passwordHash = hash;
  user.passwordSalt = salt;
  await saveUser(env, user);
  return { ok: true, phone: maskPhone(phone), userId: user.id };
}

export async function resolveSession(env, token) {
  const session = await loadSession(env, token);
  if (!session) return null;
  const user = await loadUser(env, session.userId);
  if (!user) return null;
  return { session, user };
}

export async function logoutUser(env, token) {
  await deleteSession(env, token);
  return { ok: true };
}

export async function getPhoneByClientId(env, clientId) {
  const kv = getKv(env);
  let userId = null;
  if (kv) userId = await kv.get(`${CLIENT_PREFIX}${clientId}`);
  else userId = memory.clients.get(clientId);
  if (!userId) return null;
  const user = await loadUser(env, userId);
  return user ? maskPhone(user.phone) : null;
}

/** 校验某账号的密码（注销等敏感操作需要二次确认）。纯微信账号无密码，返回 false。 */
export async function verifyUserPassword(env, userId, password) {
  const user = await loadUser(env, userId);
  if (!user?.passwordHash || !user?.passwordSalt) return false;
  return verifyPassword(String(password || ''), user.passwordHash, user.passwordSalt);
}

/**
 * 注销账号：删除用户本体与全部索引，并吊销该账号的所有会话。
 *
 * 只负责"人"这一块；订单脱敏保留、配额记录清理、OSS 备份覆盖由调用方
 * （functions/api/auth/delete.js）处理 —— 那些要用到 quota / order / oss 模块，
 * 放到这里会形成循环依赖。
 *
 * **订单不删**：业务方 2026-09-16 决定「注销后订单脱敏保留」（财务与审计需要）。
 */
export async function deleteUserAccount(env, userId) {
  const user = await loadUser(env, userId);
  if (!user) return { ok: false, error: '账号不存在' };

  const kv = getKv(env);
  let removedKeys = 0;
  if (kv) {
    const keys = [
      `${USER_PREFIX}${user.id}`,
      user.phone ? `${PHONE_PREFIX}${user.phone}` : null,
      user.clientId ? `${CLIENT_PREFIX}${user.clientId}` : null,
      user.wechatOpenId ? `${OPENID_PREFIX}${user.wechatOpenId}` : null,
      user.wechatWebOpenId ? `${OPENID_PREFIX}${user.wechatWebOpenId}` : null,
      user.wechatMpOpenId ? `${OPENID_PREFIX}${user.wechatMpOpenId}` : null,
      user.wechatUnionId ? `${UNION_PREFIX}${user.wechatUnionId}` : null,
    ].filter(Boolean);
    for (const k of keys) {
      await kv.delete(k);
      removedKeys += 1;
    }

    // 吊销该账号的全部会话：KV 不能按值查询，只能列前缀后逐条比对。
    // 会话数量很小，最多翻 10 页，避免极端情况下无限循环。
    let cursor;
    for (let page = 0; page < 10; page += 1) {
      const list = await kv.list({ prefix: SESSION_PREFIX, cursor });
      for (const { name } of list.keys) {
        const s = await loadSession(env, name.slice(SESSION_PREFIX.length));
        if (s?.userId === user.id) {
          await kv.delete(name);
          removedKeys += 1;
        }
      }
      if (list.list_complete) break;
      cursor = list.cursor;
    }
  }

  // 内存模式（本地开发无 KV）同样要清干净，否则注销后还能"登录"回来
  memory.users.delete(user.id);
  if (user.phone) memory.phones.delete(user.phone);
  if (user.clientId) memory.clients.delete(user.clientId);
  for (const oid of [user.wechatOpenId, user.wechatWebOpenId, user.wechatMpOpenId]) {
    if (oid) memory.openids.delete(oid);
  }
  if (user.wechatUnionId) memory.unions.delete(user.wechatUnionId);
  for (const [token, s] of [...memory.sessions]) {
    if (s?.userId === user.id) memory.sessions.delete(token);
  }

  return {
    ok: true,
    removedKeys,
    clientId: user.clientId || null,
    phoneMasked: user.phone ? maskPhone(user.phone) : null,
  };
}

export { maskPhone, validPhone };
