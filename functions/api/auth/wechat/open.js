import {
  buildQrConnectUrl,
  getWechatOpenConfig,
  isWechatOpenLoginConfigured,
  codeToOpenAccess,
} from '../../../lib/wechat-open.js';
import { loginWechatUser, resetPasswordWithWechat } from '../../../lib/auth-store.js';
import { getQuota } from '../../../lib/quota-store.js';
import { corsPreflight, jsonResponse } from '../../../lib/http.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight(request);

  const url = new URL(request.url);

  if (request.method === 'GET') {
    if (!isWechatOpenLoginConfigured(env)) {
      return jsonResponse(request, {
        configured: false,
        hint: '请在 Cloudflare 配置 WECHAT_OPEN_APP_ID / WECHAT_OPEN_APP_SECRET / WECHAT_OPEN_REDIRECT_URI',
      });
    }
    const c = getWechatOpenConfig(env);
    const state = url.searchParams.get('state') || `qtvq_${Date.now()}`;
    return jsonResponse(request, {
      configured: true,
      appId: c.appId,
      redirectUri: c.redirectUri,
      loginUrl: buildQrConnectUrl(env, state),
    });
  }

  if (request.method !== 'POST') return jsonResponse(request, { error: 'Method not allowed' }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, { error: '无效 JSON' }, 400);
  }

  const { action, code, clientId, phone, newPassword } = body;
  if (!code) return jsonResponse(request, { error: '缺少微信 code' }, 400);

  const wx = await codeToOpenAccess(env, code);
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
    source: 'web',
  });
  if (result.error) return jsonResponse(request, { error: result.error }, 400);
  const quota = await getQuota(env, result.user.clientId);
  return jsonResponse(request, { ok: true, ...result, quota });
}
