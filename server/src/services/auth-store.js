/**
 * 账号与会话 —— **境内 Mongo 版**（2026-10-26）
 *
 * ── 为什么迁 ──────────────────────────────────────────────────────────────
 * 原来账号记录（含**密码哈希**）与会话都在 Cloudflare KV：
 *   `auth:user:<id>`、`auth:p:<hash(phone)>`、`auth:s:<hash(token)>`
 * 两个问题：
 *   1. **合规**：密码哈希属于敏感数据，放在境外 KV 上是数据出境；
 *   2. **延迟**：`/api/auth` 与 `/api/auth/me` 因此只能跑在 Pages 上，客户端每次登录/开页都跨境
 *      （实测 P50 641ms / P95 6.7s）。
 *
 * ── 必须与 KV 版**逐位兼容**的地方 ────────────────────────────────────────
 * · 密码：PBKDF2 / SHA-256 / **100000 轮** / 16 字节盐 / base64(hash) 与 base64(salt)。
 *   参数变一个，所有存量用户就登不上（哈希对不上）。此处参数与
 *   `functions/lib/auth-store.js` 的 `deriveHash()` 完全一致，迁移后原密码继续可用。
 * · 会话键：KV 用的是 `auth:s:<sha256('session:'+token) 前 16 字节 hex>`。
 *   迁移时**直接沿用这个哈希作为 Mongo `_id`**，于是迁移前签发的 token 依然有效 ——
 *   否则所有在线用户会被踢下线。
 * · 对外用户结构：`{ id, phone(脱敏), wechatBound, hasPassword, clientId, createdAt }`
 *   与 KV 版的 `publicUser()` 一致，前端不用改。
 */

import crypto from 'node:crypto';
import { getDB } from '../config/db.js';
import { grantInviteCoupon } from './coupons.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const USERS = 'auth_users';
const SESSIONS = 'auth_sessions';

/* ------------------------------------------------------------------ 摘要工具 */

/** 与 KV 版同算法：sha256(原文) 前 16 字节的 hex。用于会话键，保证迁移前后一致。 */
export function hashKey(raw) {
  return crypto.createHash('sha256').update(String(raw ?? '')).digest('hex').slice(0, 32);
}

export const sessionKeyId = (token) => hashKey(`session:${token}`);

/* ---------------------------------------------------------------- 密码哈希 */

function deriveHash(password, saltB64) {
  const salt = saltB64 ? Buffer.from(saltB64, 'base64') : crypto.randomBytes(16);
  const bits = crypto.pbkdf2Sync(Buffer.from(String(password), 'utf8'), salt, 100000, 32, 'sha256');
  return { hash: bits.toString('base64'), salt: salt.toString('base64') };
}

export function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  const derived = deriveHash(password, salt);
  // 长度相等才比，避免 timingSafeEqual 抛错
  const a = Buffer.from(derived.hash, 'base64');
  const b = Buffer.from(hash, 'base64');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* -------------------------------------------------------------------- 用户 */

const validPhone = (p) => /^1[3-9]\d{9}$/.test(String(p || ''));
const validPassword = (p) => typeof p === 'string' && p.length >= 6;
const maskPhone = (p) => (p ? `${String(p).slice(0, 3)}****${String(p).slice(-4)}` : null);
const newUserId = () => `u_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
const newToken = () => crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');

export function publicUser(user) {
  return {
    id: user.userId || user.id,
    phone: user.phone ? maskPhone(user.phone) : null,
    wechatBound: !!(user.wechatMpOpenId || user.wechatOpenId || user.wechatWebOpenId),
    hasPassword: !!user.passwordHash,
    clientId: user.clientId,
    createdAt: user.createdAt,
  };
}

async function findUserByPhone(phone) {
  return getDB().collection(USERS).findOne({ phone: String(phone) });
}

async function findUserById(userId) {
  return getDB().collection(USERS).findOne({ userId: String(userId) });
}

async function findUserByClientId(clientId) {
  return getDB().collection(USERS).findOne({ clientId: String(clientId) });
}

async function savePassword(userId, password) {
  const { hash, salt } = deriveHash(password);
  await getDB()
    .collection(USERS)
    .updateOne({ userId }, { $set: { passwordHash: hash, passwordSalt: salt, updatedAt: Date.now() } });
}

/* ------------------------------------------------------------------ 会话 */

async function saveSession(token, data) {
  const now = Date.now();
  const payload = { ...data, createdAt: now, expiresAt: now + SESSION_TTL_MS };
  await getDB()
    .collection(SESSIONS)
    .updateOne({ _id: sessionKeyId(token) }, { $set: payload }, { upsert: true });
  return payload;
}

async function loadSession(token) {
  if (!token) return null;
  const doc = await getDB().collection(SESSIONS).findOne({ _id: sessionKeyId(token) });
  if (!doc) return null;
  if (Number(doc.expiresAt || 0) <= Date.now()) return null;
  return doc;
}

async function deleteSession(token) {
  await getDB().collection(SESSIONS).deleteOne({ _id: sessionKeyId(token) });
}

async function createSession(user) {
  const token = newToken();
  await saveSession(token, { userId: user.userId, clientId: user.clientId });
  return { token, user: publicUser(user) };
}

/* -------------------------------------------------------------- 对外操作 */

/** 渠道码：只允许小写字母数字下划线连字符，2–24 位（内容矩阵里就是 xhs01 / dy07 这种） */
function normalizeChannel(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return /^[a-z0-9_-]{2,24}$/.test(s) ? s : null;
}

/**
 * 归一化注册归因（实施书 P3-T3.2）。
 * 渠道码与邀请人分开校验：渠道码脏了不该连带把邀请奖励也丢掉。
 * 两者都没有则返回 null —— 不写空对象，免得"有没有归因"这件事变得不可判断。
 */
export function normalizeAcquisition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const channel = normalizeChannel(raw.channel ?? raw.ch ?? raw.utm_source);
  const inviterRaw = String(raw.inviterUid ?? raw.inviter ?? '').trim();
  const inviterUid = /^[A-Za-z0-9_-]{6,64}$/.test(inviterRaw) ? inviterRaw : null;
  const landingAt = Number(raw.landingAt) > 0 ? Number(raw.landingAt) : Date.now();
  if (!channel && !inviterUid) return null;
  const out = { channel: channel || 'direct', landingAt };
  if (inviterUid) out.inviterUid = inviterUid;
  return out;
}

export async function registerUser({ phone, password, clientId, acquisition = null }) {
  if (!validPhone(phone)) return { error: '请输入正确的 11 位手机号' };
  if (!validPassword(password)) return { error: '密码至少 6 位' };
  if (!clientId || String(clientId).length > 64) return { error: '无效设备编号' };

  if (await findUserByPhone(phone)) return { error: '该手机号已注册，请直接登录' };

  const userId = newUserId();
  const now = Date.now();
  const doc = {
    userId,
    phone: String(phone),
    clientId: String(clientId),
    createdAt: now,
    updatedAt: now,
  };
  const acq = normalizeAcquisition(acquisition);
  if (acq) doc.acquisition = acq;
  const { hash, salt } = deriveHash(password);
  doc.passwordHash = hash;
  doc.passwordSalt = salt;
  await getDB().collection(USERS).updateOne({ userId }, { $set: doc }, { upsert: true });

  const user = await findUserById(userId);

  // 邀请奖励：注册成功才发券（发券失败不能把注册也弄挂 —— 用户已经建好了）
  let invite = null;
  if (acq?.inviterUid) {
    try {
      const r = await grantInviteCoupon({ inviterUid: acq.inviterUid, inviteeUid: userId });
      invite = r.ok ? { issued: true, valueFen: r.valueFen } : { issued: false, reason: r.error || (r.duplicate ? 'E_DUPLICATE' : 'E_UNKNOWN') };
    } catch (err) {
      console.error('[auth] 发邀请券失败：', err?.message || err);
      invite = { issued: false, reason: 'E_EXCEPTION' };
    }
    if (invite.issued) {
      console.log(`[auth] 邀请券已发：inviter=${acq.inviterUid} invitee=${userId} channel=${acq.channel}`);
    }
  }

  const session = await createSession(user);
  return invite ? { ...session, invite } : session;
}

export async function loginUser({ phone, password, clientId }) {
  const user = await findUserByPhone(phone);
  if (!user) return { error: '手机号或密码不正确' };
  if (!user.passwordHash) return { error: '该账号未设置密码，请用微信登录' };
  if (!verifyPassword(password, user.passwordHash, user.passwordSalt)) {
    return { error: '手机号或密码不正确' };
  }
  // 换设备登录：把 clientId 更新成当前设备，额度与账号就跟到新设备
  if (clientId && clientId !== user.clientId) {
    await getDB()
      .collection(USERS)
      .updateOne({ userId: user.userId }, { $set: { clientId: String(clientId), updatedAt: Date.now() } });
    user.clientId = String(clientId);
  }
  return createSession(user);
}

export async function resolveSession(token) {
  const session = await loadSession(token);
  if (!session) return null;
  const user = await findUserById(session.userId);
  if (!user) return null;
  return { session, user };
}

export async function logoutUser(token) {
  await deleteSession(token);
  return { ok: true };
}

export async function changePassword(userId, { oldPassword, newPassword }) {
  const user = await findUserById(userId);
  if (!user) return { error: '账号不存在' };
  if (user.passwordHash && !verifyPassword(oldPassword, user.passwordHash, user.passwordSalt)) {
    return { error: '原密码不正确' };
  }
  if (!validPassword(newPassword)) return { error: '新密码至少 6 位' };
  await savePassword(userId, newPassword);
  return { ok: true };
}

export async function adminResetPassword({ phone, newPassword }) {
  const user = await findUserByPhone(phone);
  if (!user) return { error: '该手机号未注册' };
  if (!validPassword(newPassword)) return { error: '新密码至少 6 位' };
  await savePassword(user.userId, newPassword);
  return { ok: true, phone: maskPhone(phone), userId: user.userId };
}

export async function verifyUserPassword(userId, password) {
  const user = await findUserById(userId);
  if (!user?.passwordHash) return false;
  return verifyPassword(password, user.passwordHash, user.passwordSalt);
}

export async function getPhoneByClientId(clientId) {
  const user = await findUserByClientId(clientId);
  return user?.phone ? maskPhone(user.phone) : null;
}

/* --------------------------------------------------- 供 Pages 侧调用的会话接口 */

/*
 * 微信登录、短信重置、注销仍在 Pages 上（依赖微信/阿里云 SDK 与通知邮件）。
 * 它们同样要签发/校验会话，所以这里提供**按哈希键**读写会话的接口：
 * Pages 侧算出同一个 `hashKey('session:'+token)`，就能与本服务共享会话。
 */
export async function adminSaveSession({ hashId, userId, clientId, expiresAt }) {
  if (!hashId) return false;
  await getDB()
    .collection(SESSIONS)
    .updateOne(
      { _id: String(hashId) },
      { $set: { userId, clientId, expiresAt: Number(expiresAt) || Date.now() + SESSION_TTL_MS, createdAt: Date.now() } },
      { upsert: true },
    );
  return true;
}

export async function adminLoadSession(hashId) {
  if (!hashId) return null;
  const doc = await getDB().collection(SESSIONS).findOne({ _id: String(hashId) });
  if (!doc) return null;
  if (Number(doc.expiresAt || 0) <= Date.now()) return null;
  return doc;
}

export async function adminDeleteSession(hashId) {
  if (!hashId) return false;
  await getDB().collection(SESSIONS).deleteOne({ _id: String(hashId) });
  return true;
}

export { SESSION_TTL_MS, maskPhone, validPhone };
