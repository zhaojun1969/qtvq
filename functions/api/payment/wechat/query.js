import { corsPreflight, jsonResponse } from '../../../lib/http.js';
import { validClientId, getQuota } from '../../../lib/quota-store.js';
import { getOrder } from '../../../lib/order-store.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight(request);
  if (request.method !== 'GET') {
    return jsonResponse(request, { error: 'Method not allowed' }, 405);
  }

  const url = new URL(request.url);
  const orderId = url.searchParams.get('orderId');
  const clientId = url.searchParams.get('clientId');

  if (!orderId) return jsonResponse(request, { error: '缺少 orderId' }, 400);
  if (clientId && !validClientId(clientId)) {
    return jsonResponse(request, { error: '无效的 clientId' }, 400);
  }

  const order = await getOrder(env, orderId);
  if (!order) return jsonResponse(request, { error: '订单不存在' }, 404);
  if (clientId && order.clientId !== clientId) {
    return jsonResponse(request, { error: '无权查询该订单' }, 403);
  }

  const summary = {
    orderId: order.orderId,
    clientId: order.clientId,
    plan: order.plan,
    planLabel: order.planLabel,
    amount: order.amount,
    status: order.status,
    channel: order.channel,
    paidAt: order.paidAt,
    createdAt: order.createdAt,
  };

  const payload = { ok: true, order: summary };
  if (order.status === 'paid') {
    payload.quota = await getQuota(env, order.clientId);
  }

  return jsonResponse(request, payload);
}
