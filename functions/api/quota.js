import { getQuota, recordAsk } from '../lib/quota-store.js';
import { reconcileClientPendingOrders } from '../lib/payment-activate.js';
import { corsPreflight, jsonResponse } from '../lib/http.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight(request);

  const url = new URL(request.url);

  if (request.method === 'GET') {
    const clientId = url.searchParams.get('clientId');
    if (!clientId) return jsonResponse(request, { error: '缺少 clientId' }, 400);
    const quota = await getQuota(env, clientId);
    if (!quota) return jsonResponse(request, { error: '无效 clientId' }, 400);
    // 兜底补开通：如果这个客户有未激活的微信订单、而微信侧其实已收款（回调没到），这里补上。
    // 放在返回之前，这样本次响应里的会员状态就是最新的。
    try {
      const r = await reconcileClientPendingOrders(env, clientId);
      if (r.activated > 0) return jsonResponse(request, await getQuota(env, clientId));
    } catch (err) {
      console.error('[quota] 补开通检查失败：', err);
    }
    return jsonResponse(request, quota);
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(request, { error: '无效 JSON' }, 400);
    }
    const clientId = url.searchParams.get('clientId') || body.clientId;
    if (!clientId) return jsonResponse(request, { error: '缺少 clientId' }, 400);
    if (body.action === 'record' && body.clientId === clientId) {
      await recordAsk(env, clientId);
      return jsonResponse(request, await getQuota(env, clientId));
    }
    return jsonResponse(request, { error: '未知操作' }, 400);
  }

  return jsonResponse(request, { error: 'Method not allowed' }, 405);
}
