/**
 * 身份桥接（strangler 模式的关键）
 *
 * 目标：**不迁移现有账号数据**，也能让新服务认识老用户。
 *
 * 现有系统的会话存在 Cloudflare KV，只有 Pages Functions 能验证。
 * 因此本中间件按顺序尝试：
 *   1) 本服务自签 JWT（JWT_SECRET 已配置时）—— 供日后独立注册使用
 *   2) 回源校验：带旧 token 调 LEGACY_API_BASE/api/auth/me，取回 user.id 作为 uid
 *   3) 开发模式 dev-login 签发的 token（ALLOW_DEV_LOGIN=1 时才可能被签出）
 *
 * 这样老的注册/登录/微信扫码/支付/会员全部不用动，
 * 新功能却可以立刻用到同一批用户 —— 迁移可以分批、可回滚。
 */
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { unauthorized } from '../lib/http.js';

const LEGACY_TIMEOUT_MS = 6000;

export function bearerToken(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const q = typeof req.query?.token === 'string' ? req.query.token : null;
  return q || null;
}

function verifyLocal(token) {
  if (!env.jwtSecret) return null;
  try {
    const payload = jwt.verify(token, env.jwtSecret);
    if (payload?.uid) return { uid: payload.uid, source: 'local', legacy: false };
  } catch {
    /* 交给回源校验 */
  }
  return null;
}

export function signLocalToken(uid) {
  if (!env.jwtSecret) throw new Error('JWT_SECRET 未配置，无法签发本地 token');
  return jwt.sign({ uid }, env.jwtSecret, { expiresIn: env.jwtTtl });
}

async function verifyWithLegacy(token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LEGACY_TIMEOUT_MS);
  try {
    const res = await fetch(`${env.legacyApiBase}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    const uid = body?.user?.id;
    if (!uid) return null;

    // 顺带把现网的会员状态带回来：报告计费要用它判断「会员每日免费次数」。
    // 拿不到时按“非会员”处理（宁可少给免费次数，也不能白送）。
    const sub = body?.quota?.subscription;
    const activeUntil = sub?.activeUntil || null;
    const membership = {
      active: !!(activeUntil && Number(activeUntil) > Date.now()),
      activeUntil,
      plan: sub?.plan || null,
      unlimited: !!body?.quota?.unlimited,
    };

    return { uid, source: 'legacy', legacy: true, legacyUser: body.user, membership };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 解析身份，失败返回 null（用于「可选登录」的接口） */
export async function resolveIdentity(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const local = verifyLocal(token);
  if (local) return { ...local, membership: { active: false } };
  return verifyWithLegacy(token);
}

/** 强制登录 */
export async function requireAuth(req, res, next) {
  try {
    const identity = await resolveIdentity(req);
    if (!identity) throw unauthorized();
    req.identity = identity;
    req.uid = identity.uid;
    req.membership = identity.membership || { active: false };
    next();
  } catch (err) {
    next(err);
  }
}
