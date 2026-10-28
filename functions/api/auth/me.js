import { resolveSession, loadUserIdentity } from '../../lib/auth-store.js';
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
  /*
   * 手机号与微信绑定状态在**境内**（`auth:user:` 的 KV 副本已剥离这些字段，
   * 见 auth-store.js 顶部说明）。这一段只服务于"展示我是谁"，是低频路径，
   * 多一次境内往返可以接受；热路径（每次提问的配额检查）不经过这里。
   */
  const identity = await loadUserIdentity(env, user.id);
  const phone = identity?.phone || user.phone || null;
  const wechatBound = !!(
    identity?.wechatOpenId ||
    identity?.wechatWebOpenId ||
    identity?.wechatMpOpenId ||
    user.wechatOpenId
  );
  const quota = await getQuota(env, user.clientId);
  return jsonResponse(request, {
    user: {
      id: user.id,
      phone: phone ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : null,
      wechatBound,
      hasPassword: !!user.passwordHash,
      clientId: user.clientId,
      createdAt: user.createdAt,
    },
    quota,
  });
}
