import { codeToSession } from '../../lib/wechat-mp.js';
import { loginWechatUser, resetPasswordWithWechat } from '../../lib/auth-store.js';
import { getQuota } from '../../lib/quota-store.js';
import { corsPreflight, jsonResponse } from '../../lib/http.js';

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

  const { action, code, clientId, phone, newPassword } = body;

  if (!code) return jsonResponse(request, { error: '缺少微信 code' }, 400);

  const wx = await codeToSession(env, code);
  if (wx.error) return jsonResponse(request, { error: wx.error }, 400);

  if (action === 'resetPassword') {
    if (!phone || !newPassword) {
      return jsonResponse(request, { error: '请填写手机号与新密码' }, 400);
    }
    const result = await resetPasswordWithWechat(env, {
      phone,
      newPassword,
      openid: wx.openid,
      unionId: wx.unionid,
    });
    if (result.error) return jsonResponse(request, { error: result.error }, 400);
    const quota = await getQuota(env, result.user.clientId);
    return jsonResponse(request, { ok: true, ...result, quota });
  }

  if (!clientId) return jsonResponse(request, { error: '缺少 clientId' }, 400);

  const result = await loginWechatUser(env, {
    openid: wx.openid,
    unionId: wx.unionid,
    clientId,
    source: 'mp',
  });
  if (result.error) return jsonResponse(request, { error: result.error }, 400);
  const quota = await getQuota(env, result.user.clientId);
  return jsonResponse(request, { ok: true, ...result, quota });
}
