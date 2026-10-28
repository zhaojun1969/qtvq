import { corsPreflight, jsonResponse } from '../../../lib/http.js';
import { validClientId, getQuota } from '../../../lib/quota-store.js';
import { getOrder } from '../../../lib/order-store.js';
import { activatePaidOrder } from '../../../lib/payment-activate.js';
import { queryWechatOrder } from '../../../lib/wechat-pay.js';

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

  let order = await getOrder(env, orderId);
  if (!order) return jsonResponse(request, { error: '订单不存在' }, 404);
  if (clientId && order.clientId !== clientId) {
    return jsonResponse(request, { error: '无权查询该订单' }, 403);
  }

  // ── 自愈：本地还显示未支付时，主动向微信查真实交易状态 ──
  // 回调可能因为公钥没配好 / 验签失败 / 外网不可达而永远不到，那会导致「钱已付、会员没开通」。
  // 只要微信侧是 SUCCESS，这里就直接落库 + 开通会员 + 发通知，不依赖回调。
  let reconciled = false;
  let wechatTradeState = '';
  /*
   * ⚠️ 这里原来写的是 `order.status !== 'paid'` —— 也就是**已经 paid 的订单不再走这段**。
   * 2026-10-11 事故（毛敏两笔 ¥1 被吞）正是卡在这里：
   *   payment-activate.js 先把订单标成 paid、再入账；入账失败后订单仍是 paid，
   *   于是查询接口因为 `status === 'paid'` 永不重试 → 钱永久不入账、用户只看到"已支付"。
   * 修法：**充值订单即使已 paid 也再走一次**（activatePaidOrder 对 topup 已改成幂等自愈，
   * ref=orderId 保证不会重复加钱）。会员订单维持原判据不变。
   */
  const isWechatChannel = String(order.channel || '').startsWith('wechat');
  const shouldReconcile = order.status !== 'paid' || (order.plan === 'topup' && isWechatChannel);
  if (shouldReconcile && isWechatChannel) {
    try {
      const q = await queryWechatOrder(env, order.orderId);
      if (q.ok) wechatTradeState = q.tradeState || 'UNKNOWN';
      else wechatTradeState = `QUERY_FAILED:${q.error}`;
      if (q.ok && q.tradeState === 'SUCCESS' && Number(q.amountTotal) === Number(order.amountFen)) {
        const r = await activatePaidOrder(env, order, {
          platformTradeNo: q.transactionId,
          source: '主动查询',
        });
        if (r.ok) {
          reconciled = !r.alreadyPaid;
          order = (await getOrder(env, orderId)) || order;
        } else {
          console.error('[query] 微信已收款但入账失败：', r.error, order.orderId);
        }
      } else if (q.ok && q.tradeState === 'SUCCESS') {
        // 实收金额与订单金额不一致：不自动开通，留人工处理（防止改价/串单）
        console.error(
          '[query] 金额不一致，未自动开通：',
          order.orderId,
          '应付',
          order.amountFen,
          '实收',
          q.amountTotal,
        );
      }
    } catch (err) {
      // 查询失败不能影响状态查询本身：前端仍会继续轮询
      console.error('[query] 主动查询微信订单失败：', err);
    }
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

  const payload = { ok: true, order: summary, reconciled, wechatTradeState };
  if (order.status === 'paid') {
    payload.quota = await getQuota(env, order.clientId);
  }

  return jsonResponse(request, payload);
}
