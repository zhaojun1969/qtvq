/**
 * `/api/auth` 与 `/api/auth/me` —— 账号与会话（**境内 Node 版**，2026-10-26）
 *
 * 契约与 `functions/api/auth.js` 一一对应（action: register / login / logout /
 * changePassword / adminResetPassword），前端无需改动。
 *
 * ── 为什么只迁这两个 ──────────────────────────────────────────────────────
 * `auth/sms`（阿里云短信）、`auth/wechat*`（微信登录）、`auth/delete`（注销）
 * 依赖各自 SDK 与通知邮件，仍在 Pages 上。
 * 但它们签发的会话必须与本服务共享 —— 否则"微信登录后在网页端显示未登录"。
 * 做法见 `services/auth-store.js` 的 `adminSaveSession/adminLoadSession`：
 * **以 `hashKey('session:'+token)` 作为会话主键**，两侧算出同一个键即可互通。
 */

import { Router } from 'express';
import {
  registerUser,
  loginUser,
  logoutUser,
  changePassword,
  adminResetPassword,
  resolveSession,
} from '../services/auth-store.js';
import { getQuota } from '../services/quota-store.js';
import { wrap } from '../lib/http.js';
/* E.87：GET /me 无 try/catch，resolveSession/getQuota 异常会崩进程 → 套 wrap。 */

const router = Router();

function bearerToken(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function isAdmin(req) {
  const key = process.env.PAYMENT_ADMIN_KEY || process.env.ADMIN_KEY;
  const given = (req.body || {}).adminKey || req.headers['x-admin-key'];
  return Boolean(key) && given === key;
}

/** POST /api/auth */
router.post('/', async (req, res) => {
  const body = req.body || {};
  const { action, phone, password, clientId, oldPassword, newPassword } = body;

  try {
    if (action === 'logout') {
      const token = bearerToken(req) || body.token;
      if (!token) return res.status(400).json({ error: '缺少 token' });
      await logoutUser(token);
      return res.json({ ok: true });
    }

    if (action === 'changePassword') {
      const token = bearerToken(req) || body.token;
      const resolved = await resolveSession(token);
      if (!resolved) return res.status(401).json({ error: '请先登录' });
      const result = await changePassword(resolved.user.userId, { oldPassword, newPassword });
      if (result.error) return res.status(400).json({ error: result.error });
      return res.json(result);
    }

    if (action === 'adminResetPassword') {
      if (!isAdmin(req)) return res.status(403).json({ error: '无权限' });
      if (!phone || !newPassword) return res.status(400).json({ error: '请填写手机号与新密码' });
      const result = await adminResetPassword({ phone, newPassword });
      if (result.error) return res.status(400).json({ error: result.error });
      return res.json({ ok: true, message: '密码已重置', ...result });
    }

    if (!phone || !password || !clientId) {
      if (action === 'register' || action === 'login') {
        return res.status(400).json({ error: '请填写手机号、密码与设备编号' });
      }
    }

    if (action === 'register') {
      // 归因：渠道码 ch（落地页/小程序 scene 带过来）+ 邀请人 uid（分享卡链接带过来）
      const acquisition = {
        channel: body.ch || body.channel || req.query.ch || null,
        inviterUid: body.inviterUid || body.inviter || null,
        landingAt: Number(body.landingAt) || Date.now(),
      };
      const result = await registerUser({ phone, password, clientId, acquisition });
      if (result.error) return res.status(400).json({ error: result.error });
      const quota = await getQuota(result.user.clientId);
      return res.json({ ok: true, ...result, quota });
    }

    if (action === 'login') {
      const result = await loginUser({ phone, password, clientId });
      if (result.error) return res.status(401).json({ error: result.error });
      const quota = await getQuota(result.user.clientId);
      return res.json({ ok: true, ...result, quota });
    }

    return res.status(400).json({ error: '未知操作' });
  } catch (err) {
    console.error('[auth] 处理失败：', err?.message || err);
    return res.status(500).json({ error: '服务异常，请稍后重试' });
  }
});

/** GET /api/auth/me —— 用 Bearer token 取当前身份 */
router.get('/me', wrap(async (req, res) => {
  const token = bearerToken(req) || String(req.query.token || '');
  if (!token) return res.status(401).json({ error: '请先登录' });
  const resolved = await resolveSession(token);
  if (!resolved) return res.status(401).json({ error: '登录已过期，请重新登录' });
  const quota = await getQuota(resolved.user.clientId);
  return res.json({
    ok: true,
    user: {
      id: resolved.user.userId,
      phone: resolved.user.phone ? `${String(resolved.user.phone).slice(0, 3)}****${String(resolved.user.phone).slice(-4)}` : null,
      wechatBound: !!(resolved.user.wechatMpOpenId || resolved.user.wechatOpenId || resolved.user.wechatWebOpenId),
      hasPassword: !!resolved.user.passwordHash,
      clientId: resolved.user.clientId,
      createdAt: resolved.user.createdAt,
    },
    quota,
  });
}));

export default router;
