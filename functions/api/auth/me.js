import { resolveSession } from '../../lib/auth-store.js';
import { getQuota } from '../../lib/quota-store.js';
import { corsPreflight, jsonResponse } from '../../lib/http.js';

function bearerToken(request) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight(request);
  if (request.method !== 'GET') return jsonResponse(request, { error: 'Method not allowed' }, 405);

  const url = new URL(request.url);
  const token = bearerToken(request) || url.searchParams.get('token');
  const resolved = await resolveSession(env, token);
  if (!resolved) return jsonResponse(request, { error: '未登录或会话已过期' }, 401);

  const { user } = resolved;
  const quota = await getQuota(env, user.clientId);
  return jsonResponse(request, {
    user: {
      id: user.id,
      phone: user.phone ? `${user.phone.slice(0, 3)}****${user.phone.slice(-4)}` : null,
      wechatBound: !!user.wechatOpenId,
      hasPassword: !!user.passwordHash,
      clientId: user.clientId,
      createdAt: user.createdAt,
    },
    quota,
  });
}
