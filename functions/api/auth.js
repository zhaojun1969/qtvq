import {
  registerUser,
  loginUser,
  logoutUser,
  changePassword,
  adminResetPassword,
  resolveSession,
} from '../lib/auth-store.js';
import { getQuota } from '../lib/quota-store.js';
import { corsPreflight, jsonResponse } from '../lib/http.js';

function bearerToken(request) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function checkAdmin(env, adminKey) {
  const key = env.PAYMENT_ADMIN_KEY || env.ADMIN_KEY;
  return key && adminKey === key;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight(request);
  if (request.method !== 'POST') return jsonResponse(request, { error: 'Method not allowed' }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, { error: '无效 JSON' }, 400);
  }

  const { action, phone, password, clientId, oldPassword, newPassword, adminKey } = body;

  if (action === 'logout') {
    const token = bearerToken(request) || body.token;
    if (!token) return jsonResponse(request, { error: '缺少 token' }, 400);
    await logoutUser(env, token);
    return jsonResponse(request, { ok: true });
  }

  if (action === 'changePassword') {
    const token = bearerToken(request) || body.token;
    const resolved = await resolveSession(env, token);
    if (!resolved) return jsonResponse(request, { error: '请先登录' }, 401);
    const result = await changePassword(env, resolved.user.id, { oldPassword, newPassword });
    if (result.error) return jsonResponse(request, { error: result.error }, 400);
    return jsonResponse(request, result);
  }

  if (action === 'adminResetPassword') {
    if (!checkAdmin(env, adminKey)) return jsonResponse(request, { error: '无权限' }, 403);
    if (!phone || !newPassword) return jsonResponse(request, { error: '请填写手机号与新密码' }, 400);
    const result = await adminResetPassword(env, { phone, newPassword });
    if (result.error) return jsonResponse(request, { error: result.error }, 400);
    return jsonResponse(request, { ok: true, message: '密码已重置', ...result });
  }

  if (!phone || !password || !clientId) {
    if (action === 'register' || action === 'login') {
      return jsonResponse(request, { error: '请填写手机号、密码与设备编号' }, 400);
    }
  }

  if (action === 'register') {
    const result = await registerUser(env, { phone, password, clientId });
    if (result.error) return jsonResponse(request, { error: result.error }, 400);
    const quota = await getQuota(env, result.user.clientId);
    return jsonResponse(request, { ok: true, ...result, quota });
  }

  if (action === 'login') {
    const result = await loginUser(env, { phone, password, clientId });
    if (result.error) return jsonResponse(request, { error: result.error }, 401);
    const quota = await getQuota(env, result.user.clientId);
    return jsonResponse(request, { ok: true, ...result, quota });
  }

  return jsonResponse(request, { error: '未知操作' }, 400);
}
