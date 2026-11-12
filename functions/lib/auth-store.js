/**
 * 用户注册/登录（手机号 + 密码），绑定 clientId 以便跨设备查看会员与打款状态
 */

import { validClientId } from './quota-store.js';

const USER_PREFIX = 'auth:user:';
/* 旧明文键前缀：仅用于「惰性迁移」识别与清理，新代码不再写入 */
const PHONE_PREFIX = 'auth:phone:';
const CLIENT_PREFIX = 'auth:client:';
const OPENID_PREFIX = 'auth:openid:';
const UNION_PREFIX = 'auth:union:';
const SESSION_PREFIX = 'auth:session:';

/*
 * 2026-10-26 · G1「数据境内化」：**索引与会话的键名改为不可逆哈希**（`auth:p:` / `auth:o:`
 * / `auth:u:` / `auth:c:` / `auth:s:`）。
 *
 * 为什么必须改键名而不只是清空值：
 * KV 的键名本身就是数据。改之前 `npx wrangler kv key list` 直接列出
 *   · `auth:phone:13800001234` —— 明文手机号；
 *   · `auth:openid:oXXXX` —— 微信用户标识；
 *   · `auth:session:<64位token>` —— **可用的登录令牌**，拿到即可冒充用户。
 * 这些是「看一眼键列表」就能拿到的信息，比值里存什么更危险。
 *
 * 哈希用 SHA-256 前 32 位十六进制：不可逆、定长、几乎无碰撞（本项目用户量级远低于 2^64）。
 * 不加盐 —— 这里的目标是"键名不泄露信息"，不是"抗字典攻击"；
 * 手机号空间有限，加盐也挡不住暴力枚举，真要防枚举应做限流（已有）。
 */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const memory = { users: new Map(), phones: new Map(), clients: new Map(), openids: new Map(), unions: new Map(), sessions: new Map() };

function getKv(env) {
  return env?.QTVQ_KV || null;
}

/** SHA-256 前 32 位十六进制（不可逆） */
async function hashKey(raw) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(raw ?? '')));
  return [...new Uint8Array(buf)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const phoneKey = async (phone) => `auth:p:${await hashKey(`phone:${phone}`)}`;
const openidKey = async (openid) => `auth:o:${await hashKey(`openid:${openid}`)}`;
const unionKey = async (unionId) => `auth:u:${await hashKey(`union:${unionId}`)}`;
const clientKey = async (clientId) => `auth:c:${await hashKey(`client:${clientId}`)}`;
const sessionKey = async (token) => `auth:s:${await hashKey(`session:${token}`)}`;

/**
 * 读哈希键；未命中时回退读旧明文键，命中就顺手迁到哈希键并删除旧键。
 * 这样存量数据不需要停机迁移，第一次访问即完成搬迁。
 */
async function kvGetMigrating(kv, hashedKey, legacyKey) {
  const hit = await kv.get(hashedKey);
  if (hit != null) return hit;
  if (!legacyKey) return null;
  const legacy = await kv.get(legacyKey);
  if (legacy == null) return null;
  try {
    await kv.put(hashedKey, legacy);
    await kv.delete(legacyKey);
  } catch (err) {
    // 迁移失败不影响本次读取（值已经拿到了），下次访问会再试
    console.error('[auth] 索引键惰性迁移失败：', err?.message || err);
  }
  return legacy;
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

/** 境内用户回源（E.76）：境内注册的用户本体在 Mongo，不在本 KV —— 会话桥通了、用户也要桥。 */
async function loadUserViaNode(env, userId) {
  const cfg = nodeAuthConfig(env);
  if (!cfg || !userId) return null;
  try {
    let res = null;
    for (let attempt = 0; attempt < 2 && !res; attempt++) {
      try {
        res = await fetch(`${cfg.base}/v1/admin/auth-accounts/${encodeURIComponent(userId)}`, {
          headers: { 'X-Admin-Key': cfg.adminKey, 'User-Agent': 'qtvq-auth/1.0 (+https://qtvq.cn)' },
          signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
        });
        if (!res.ok) return null;
      } catch (err) {
        if (attempt === 1) throw err;
        res = null;
      }
    }
    if (!res) return null;
    const j = await res.json().catch(() => null);
    const u = j?.data;
    if (!u || !u.id) return null;
    return u;
  } catch (err) {
    console.error('[auth] 读境内用户异常：', err?.message || err);
    return null;
  }
}

async function loadUser(env, userId) {
  const kv = getKv(env);
  if (kv) {
    const raw = await kv.get(`${USER_PREFIX}${userId}`);
    if (!raw) {
      // KV 未命中 ≠ 用户不存在：境内（Node/Mongo）注册的用户不在本 KV。
      // 回源取（可识别字段不出境，见 Node 侧 auth-users 路由的安全边界注释）。
      return await loadUserViaNode(env, userId);
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      // 以前是静默返回 null —— 调用方会把它当成"用户不存在"，于是登录被拒、
      // 会话失效，却没有任何日志可查。这里至少留下线索。
      // （不返回默认对象：账号记录损坏时"当作用户不存在"比"当成新账号"安全，
      //   后者可能让损坏记录被覆盖，或让人误以为账号是空的。）
      console.error(`[auth] 用户记录损坏：userId=${userId}`, err?.message || err);
      return null;
    }
  }
  return memory.users.get(userId) || null;
}

/** 可识别字段名（KV 副本不含、境内记录的正是这几个） */
const IDENTITY_KEYS = ['phone', 'wechatOpenId', 'wechatWebOpenId', 'wechatMpOpenId', 'wechatUnionId'];

/** 只取有值的可识别字段：避免把 Mongo 的 `_id`/`updatedAt` 混进用户对象再写回 KV */
function stripNulls(obj) {
  const out = {};
  for (const k of IDENTITY_KEYS) if (obj?.[k]) out[k] = obj[k];
  return out;
}

/** 去掉可识别字段，得到可以放在境外的 KV 副本 */
export function sanitizeUserForKv(user) {
  if (!user || typeof user !== 'object') return user;
  const {
    phone: _phone,
    wechatOpenId: _o1,
    wechatWebOpenId: _o2,
    wechatMpOpenId: _o3,
    wechatUnionId: _u1,
    ...rest
  } = user;
  return rest;
}

const IDENTITY_TIMEOUT_MS = 3000;

/**
 * 把可识别字段同步到境内。永不抛异常、永不阻断主流程。
 * 失败只记日志：登录/鉴权不依赖它（KV 里有口令摘要），只是"认人"相关的少数路径会退化。
 */
async function syncUserIdentity(env, user, { remove = false } = {}) {
  const base = String(env?.NODE_API_BASE || '').replace(/\/+$/, '');
  const adminKey = String(env?.NODE_ADMIN_KEY || '');
  if (!base || !adminKey || !user?.id) return { ok: false, reason: 'not-configured' };
  try {
    const url = remove
      ? `${base}/v1/admin/auth-users/${encodeURIComponent(user.id)}`
      : `${base}/v1/admin/auth-users`;
    const res = await fetch(url, {
      method: remove ? 'DELETE' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': adminKey,
        'User-Agent': 'qtvq-auth-identity/1.0 (+https://qtvq.cn)',
      },
      body: remove
        ? undefined
        : JSON.stringify({
            userId: user.id,
            clientId: user.clientId || null,
            createdAt: user.createdAt || Date.now(),
            phone: user.phone || null,
            wechatOpenId: user.wechatOpenId || null,
            wechatWebOpenId: user.wechatWebOpenId || null,
            wechatMpOpenId: user.wechatMpOpenId || null,
            wechatUnionId: user.wechatUnionId || null,
          }),
      signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[auth] 可识别字段同步失败 ${user.id} HTTP ${res.status}`);
      return { ok: false, reason: `http-${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error('[auth] 可识别字段同步异常：', err?.message || err);
    return { ok: false, reason: 'network' };
  }
}

/**
 * 取回可识别字段（phone / 各 openid）并与 KV 里的记录合并。
 *
 * 为什么需要显式调用：KV 副本刻意不含这些字段，任何"要认人"的逻辑（脱敏展示、
 * 注销、微信身份匹配、收款通知）都必须先调它。**忘记调用的后果是静默的** ——
 * 例如 `loginWechatUser` 里若拿到没有 openid 的用户对象，会把"已绑定微信的老账号"
 * 当成"未绑定"，进而把新 openid 挂到一个本不该挂的账号上。
 */
export async function loadUserIdentity(env, userId) {
  const base = String(env?.NODE_API_BASE || '').replace(/\/+$/, '');
  const adminKey = String(env?.NODE_ADMIN_KEY || '');
  if (!base || !adminKey || !userId) return null;
  try {
    const res = await fetch(`${base}/v1/admin/auth-users/${encodeURIComponent(userId)}`, {
      headers: {
        'X-Admin-Key': adminKey,
        'User-Agent': 'qtvq-auth-identity/1.0 (+https://qtvq.cn)',
      },
      signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.error(`[auth] 读取可识别字段失败 ${userId} HTTP ${res.status}`);
      return null;
    }
    const j = await res.json().catch(() => null);
    return j?.data || null;
  } catch (err) {
    console.error('[auth] 读取可识别字段异常：', err?.message || err);
    return null;
  }
}

/** 取完整用户（KV 记录 + 可识别字段）。仅用于确实需要认人的路径。 */
export async function loadUserWithIdentity(env, userId) {
  const user = await loadUser(env, userId);
  if (!user) return null;
  const identity = await loadUserIdentity(env, userId);
  if (!identity) return user;
  return {
    ...user,
    phone: identity.phone || user.phone || null,
    wechatOpenId: identity.wechatOpenId || user.wechatOpenId || null,
    wechatWebOpenId: identity.wechatWebOpenId || user.wechatWebOpenId || null,
    wechatMpOpenId: identity.wechatMpOpenId || user.wechatMpOpenId || null,
    wechatUnionId: identity.wechatUnionId || user.wechatUnionId || null,
  };
}

async function saveUser(env, user) {
  const kv = getKv(env);
  if (kv) {
    // 值只写脱敏副本（无可识别字段）；完整字段进境内 Mongo
    await kv.put(`${USER_PREFIX}${user.id}`, JSON.stringify(sanitizeUserForKv(user)));
    // 索引一律写哈希键；同时清掉可能残留的旧明文键（删除失败不影响写入）
    const idx = [];
    if (user.phone) idx.push([await phoneKey(user.phone), `${PHONE_PREFIX}${user.phone}`]);
    if (user.clientId) idx.push([await clientKey(user.clientId), `${CLIENT_PREFIX}${user.clientId}`]);
    for (const oid of [user.wechatOpenId, user.wechatWebOpenId, user.wechatMpOpenId]) {
      if (oid) idx.push([await openidKey(oid), `${OPENID_PREFIX}${oid}`]);
    }
    if (user.wechatUnionId) idx.push([await unionKey(user.wechatUnionId), `${UNION_PREFIX}${user.wechatUnionId}`]);
    for (const [hashed, legacy] of idx) {
      await kv.put(hashed, user.id);
      try {
        if ((await kv.get(legacy)) != null) await kv.delete(legacy);
      } catch (err) {
        console.error('[auth] 清理旧明文索引键失败：', err?.message || err);
      }
    }
  } else {
    memory.users.set(user.id, user);
    if (user.phone) memory.phones.set(user.phone, user.id);
    if (user.clientId) memory.clients.set(user.clientId, user.id);
    if (user.wechatOpenId) memory.openids.set(user.wechatOpenId, user.id);
    if (user.wechatWebOpenId) memory.openids.set(user.wechatWebOpenId, user.id);
    if (user.wechatMpOpenId) memory.openids.set(user.wechatMpOpenId, user.id);
    if (user.wechatUnionId) memory.unions.set(user.wechatUnionId, user.id);
  }
  // 可识别字段进境内（失败不阻断：登录靠 KV 里的口令摘要，不依赖它）
  await syncUserIdentity(env, user);
}

async function findUserIdByOpenId(env, openid) {
  const kv = getKv(env);
  if (kv) return (await kvGetMigrating(kv, await openidKey(openid), `${OPENID_PREFIX}${openid}`)) || null;
  return memory.openids?.get(openid) || null;
}

async function findUserIdByUnionId(env, unionId) {
  if (!unionId) return null;
  const kv = getKv(env);
  if (kv) return (await kvGetMigrating(kv, await unionKey(unionId), `${UNION_PREFIX}${unionId}`)) || null;
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
  if (kv) return (await kvGetMigrating(kv, await clientKey(clientId), `${CLIENT_PREFIX}${clientId}`)) || null;
  return memory.clients.get(clientId) || null;
}

async function findUserIdByPhone(env, phone) {
  const kv = getKv(env);
  if (kv) {
    const viaKv = (await kvGetMigrating(kv, await phoneKey(phone), `${PHONE_PREFIX}${phone}`)) || null;
    if (viaKv) return viaKv;
    // KV 未命中 ≠ 账号不存在：境内注册的用户手机号索引在 Mongo `auth_users`，不在本 KV。
    // （2026-11-04 UI 实测：注册/改密走同源 Node、登录走直连 CF 时，这里查空 →
    //  误报「账号不存在，请先注册」。）回源按手机号找 userId。
    return await findUserIdByPhoneViaNode(env, phone);
  }
  return memory.phones.get(phone) || null;
}

/** 手机号 → userId 的境内回源（登录桥，配对 /v1/admin/auth-phone/:phone） */
async function findUserIdByPhoneViaNode(env, phone) {
  const cfg = nodeAuthConfig(env);
  if (!cfg || !phone) return null;
  try {
    const res = await fetch(`${cfg.base}/v1/admin/auth-phone/${encodeURIComponent(phone)}`, {
      headers: { 'X-Admin-Key': cfg.adminKey, 'User-Agent': 'qtvq-auth/1.0 (+https://qtvq.cn)' },
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    return j?.data?.userId || null;
  } catch (err) {
    console.error('[auth] 手机号回源异常：', err?.message || err);
    return null;
  }
}

/* ------------------------------------------------ 会话：境内 Node 优先（2026-10-26） */

/*
 * 会话权威已迁到境内 Node（Mongo `auth_sessions`）。
 *
 * 但**微信登录 / 短信重置 / 注销仍在本侧**，它们同样要签发和校验会话。
 * 若这里继续只写 KV，就会出现"微信登录成功、网页端却显示未登录"——
 * 因为网页端走的是 Node 的 `/api/auth/me`，它读 Mongo。
 *
 * 所以三处都改成"先 Node，失败再 KV"。会话主键统一为
 * `sha256('session:'+token)` 的前 32 个 hex 字符（与 KV 版同算法），两边算出来是同一个键。
 */
const SESSION_TIMEOUT_MS = 1500;

function nodeAuthConfig(env) {
  const base = String(env?.NODE_API_BASE || '').replace(/\/+$/, '');
  const adminKey = String(env?.NODE_ADMIN_KEY || '');
  return base && adminKey ? { base, adminKey } : null;
}

async function sessionIdOf(token) {
  return hashKey(`session:${token}`);
}

async function saveSessionViaNode(env, token, payload) {
  const cfg = nodeAuthConfig(env);
  if (!cfg) return false;
  try {
    const res = await fetch(`${cfg.base}/v1/admin/auth-sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': cfg.adminKey,
        'User-Agent': 'qtvq-auth/1.0 (+https://qtvq.cn)',
      },
      body: JSON.stringify({
        hashId: await sessionIdOf(token),
        userId: payload.userId,
        clientId: payload.clientId,
        expiresAt: payload.expiresAt,
      }),
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    });
    return res.ok;
  } catch (err) {
    console.error('[auth] 写境内会话异常：', err?.message || err);
    return false;
  }
}

async function loadSessionViaNode(env, token) {
  const cfg = nodeAuthConfig(env);
  if (!cfg) return null;
  try {
    let res = null;
    // 桥接带 1.5s 超时，串行负载下偶发超时（2026-11-04 E2E 实测 0 字节中断）—— 重试一次
    for (let attempt = 0; attempt < 2 && !res; attempt++) {
      try {
        res = await fetch(`${cfg.base}/v1/admin/auth-sessions/${await sessionIdOf(token)}`, {
          headers: { 'X-Admin-Key': cfg.adminKey, 'User-Agent': 'qtvq-auth/1.0 (+https://qtvq.cn)' },
          signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
        });
        if (!res.ok) return null;
      } catch (err) {
        if (attempt === 1) throw err;
        res = null;
      }
    }
    if (!res) return null;
    const j = await res.json().catch(() => null);
    const d = j?.data;
    if (!d || !d.userId) return null;
    if (Number(d.expiresAt || 0) <= Date.now()) return null;
    return { userId: d.userId, clientId: d.clientId, expiresAt: d.expiresAt };
  } catch (err) {
    console.error('[auth] 读境内会话异常：', err?.message || err);
    return null;
  }
}

async function deleteSessionViaNode(env, token) {
  const cfg = nodeAuthConfig(env);
  if (!cfg) return false;
  try {
    const res = await fetch(`${cfg.base}/v1/admin/auth-sessions/${await sessionIdOf(token)}`, {
      method: 'DELETE',
      headers: { 'X-Admin-Key': cfg.adminKey, 'User-Agent': 'qtvq-auth/1.0 (+https://qtvq.cn)' },
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    });
    return res.ok;
  } catch (err) {
    console.error('[auth] 删境内会话异常：', err?.message || err);
    return false;
  }
}

async function saveSession(env, token, data) {
  const kv = getKv(env);
  const payload = { ...data, expiresAt: Date.now() + SESSION_TTL_MS };
  // 先写境内；成功就不再写 KV（两处都写会分叉）
  if (await saveSessionViaNode(env, token, payload)) return payload;
  if (kv) {
    /*
     * 会话键同样是哈希：`auth:s:<sha256>`。
     * 旧写法 `auth:session:<token>` 把**可直接使用的登录令牌**放在键名里，
     * 任何能列出 KV 键的途径（后台、误配的诊断脚本、日志）都等于拿到一批可用会话。
     * 令牌本身仍只在客户端持有，服务端只存它的摘要。
     */
    await kv.put(await sessionKey(token), JSON.stringify(payload), {
      expirationTtl: Math.ceil(SESSION_TTL_MS / 1000),
    });
  } else {
    memory.sessions.set(token, payload);
  }
  return payload;
}

async function loadSession(env, token) {
  if (!token) return null;
  // 境内 Node 优先（会话权威已迁到 Mongo）；读不到才回退 KV
  const viaNode = await loadSessionViaNode(env, token);
  if (viaNode) return viaNode;
  const kv = getKv(env);
  let raw = null;
  if (kv) raw = await kvGetMigrating(kv, await sessionKey(token), `${SESSION_PREFIX}${token}`);
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
  await deleteSessionViaNode(env, token);
  const kv = getKv(env);
  if (kv) {
    await kv.delete(await sessionKey(token));
    // 兼容：旧明文会话键也一并删除（迁移窗口内可能同时存在）
    try {
      if ((await kv.get(`${SESSION_PREFIX}${token}`)) != null) await kv.delete(`${SESSION_PREFIX}${token}`);
    } catch {
      /* 旧键清理失败不影响登出 */
    }
  } else {
    memory.sessions.delete(token);
  }
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

  /*
   * 这里**必须**取回可识别字段再判断：
   * KV 副本不含 openid，若直接用 loadUser 的对象去看"是否已绑定微信"，
   * 三个 openid 字段全是 undefined → 会把已绑定微信的老账号误判成未绑定，
   * 进而把新 openid 挂到本不该挂的账号上（静默的账号串号）。
   */
  const loadFullUser = async (id) => {
    const u = await loadUser(env, id);
    if (!u) return null;
    const identity = await loadUserIdentity(env, id);
    return identity ? { ...u, ...stripNulls(identity) } : u;
  };

  if (unionId) {
    const unionUserId = await findUserIdByUnionId(env, unionId);
    if (unionUserId) {
      const user = await loadFullUser(unionUserId);
      if (!user) return { error: '账号异常，请联系客服' };
      applyWechatIdentity(user, { openid, unionId, source });
      if (user.clientId !== clientId) user.clientId = clientId;
      await saveUser(env, user);
      return createSession(env, user);
    }
  }

  const existingId = await findUserIdByOpenId(env, openid);
  if (existingId) {
    const user = await loadFullUser(existingId);
    if (!user) return { error: '账号异常，请联系客服' };
    applyWechatIdentity(user, { openid, unionId, source });
    if (user.clientId !== clientId) user.clientId = clientId;
    await saveUser(env, user);
    return createSession(env, user);
  }

  const clientUserId = await findUserIdByClientId(env, clientId);
  if (clientUserId) {
    const user = await loadFullUser(clientUserId);
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

  const user = await loadUserWithIdentity(env, userId);
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
  const userId = await findUserIdByClientId(env, clientId);
  if (!userId) return null;
  // 手机号在境内可识别字段里，KV 副本没有 —— 必须带 identity 才能脱敏展示
  const user = await loadUserWithIdentity(env, userId);
  return user && user.phone ? maskPhone(user.phone) : null;
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
  /*
   * 必须取回可识别字段：KV 副本里已经没有 phone/openid，而注销恰恰要靠它们
   * 去删对应的索引键（`auth:p:` / `auth:o:` / `auth:u:`）。
   * 只用 loadUser 的话，索引键会全部留下来 —— 变成指向已删账号的孤儿索引，
   * 而且手机号索引还在就意味着"这个号还占着"，用户重新注册会被判"已注册"。
   */
  const user = (await loadUserWithIdentity(env, userId)) || (await loadUser(env, userId));
  if (!user) return { ok: false, error: '账号不存在' };

  const kv = getKv(env);
  let removedKeys = 0;
  if (kv) {
    const keys = [
      `${USER_PREFIX}${user.id}`,
      user.phone ? await phoneKey(user.phone) : null,
      user.clientId ? await clientKey(user.clientId) : null,
      ...(await Promise.all(
        [user.wechatOpenId, user.wechatWebOpenId, user.wechatMpOpenId]
          .filter(Boolean)
          .map((oid) => openidKey(oid)),
      )),
      user.wechatUnionId ? await unionKey(user.wechatUnionId) : null,
      // 旧明文索引键也一并清掉（迁移窗口内可能残留）
      user.phone ? `${PHONE_PREFIX}${user.phone}` : null,
      user.clientId ? `${CLIENT_PREFIX}${user.clientId}` : null,
      ...(user.wechatOpenId ? [`${OPENID_PREFIX}${user.wechatOpenId}`] : []),
      ...(user.wechatWebOpenId ? [`${OPENID_PREFIX}${user.wechatWebOpenId}`] : []),
      ...(user.wechatMpOpenId ? [`${OPENID_PREFIX}${user.wechatMpOpenId}`] : []),
      user.wechatUnionId ? `${UNION_PREFIX}${user.wechatUnionId}` : null,
    ].filter(Boolean);
    for (const k of keys) {
      try {
        await kv.delete(k);
        removedKeys += 1;
      } catch (err) {
        console.error('[auth] 删除索引键失败：', k.slice(0, 12) + '…', err?.message || err);
      }
    }

    /*
     * 吊销该账号的全部会话。会话键现在是哈希（`auth:s:`），**键名里已经没有 token**，
     * 所以不能再像以前那样从键名反推 token 去 loadSession —— 必须直接读值比对 userId。
     * 新旧两种前缀都要扫，避免迁移窗口内旧会话漏网。
     */
    for (const prefix of ['auth:s:', SESSION_PREFIX]) {
      let cursor;
      for (let page = 0; page < 10; page += 1) {
        const list = await kv.list({ prefix, cursor });
        for (const { name } of list.keys) {
          const raw = await kv.get(name);
          if (!raw) continue;
          let s = null;
          try {
            s = JSON.parse(raw);
          } catch {
            continue;
          }
          if (s?.userId === user.id) {
            await kv.delete(name);
            removedKeys += 1;
          }
        }
        if (list.list_complete) break;
        cursor = list.cursor;
      }
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

  // 境内可识别字段：注销就是删除权，整条删掉（不做脱敏保留 —— 需要保留的是订单）
  await syncUserIdentity(env, { id: user.id }, { remove: true });

  /*
   * 境内账号本体桥删（E.76）：境内注册的用户本体在 Mongo `users` 集合，KV 里没有，
   * 上面的 KV 清理对它们是空操作 —— 不桥删的话"注销"删不掉本体，手机号还能重新注册。
   * 失败不阻塞（与 syncUserIdentity 同一原则：境内侧失败打日志，返回体里带 removed 标记）。
   */
  let nodeDeleted = false;
  try {
    const cfg = nodeAuthConfig(env);
    if (cfg) {
      const res = await fetch(`${cfg.base}/v1/admin/auth-accounts/${encodeURIComponent(user.id)}`, {
        method: 'DELETE',
        headers: { 'X-Admin-Key': cfg.adminKey, 'User-Agent': 'qtvq-auth/1.0 (+https://qtvq.cn)' },
        signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
      });
      nodeDeleted = Boolean(res.ok);
      if (!res.ok) console.error('[auth] 境内账号本体删除失败：HTTP', res.status);
    }
  } catch (err) {
    console.error('[auth] 境内账号本体删除异常：', err?.message || err);
  }

  return {
    ok: true,
    removedKeys,
    nodeDeleted,
    clientId: user.clientId || null,
    phoneMasked: user.phone ? maskPhone(user.phone) : null,
  };
}

export { maskPhone, validPhone };
/*
 * 键派生函数导出给迁移脚本复用（`tools/scripts/migrate-auth-keys-hash.mjs`）。
 * 与 `order-store.projectForKv` 同样的理由：脚本自己再实现一遍哈希规则的话，
 * 一旦两边漂移，脚本就会"迁移"出一批代码永远查不到的孤儿键 —— 登录会莫名其妙失败。
 */
export { phoneKey, openidKey, unionKey, clientKey, sessionKey };
