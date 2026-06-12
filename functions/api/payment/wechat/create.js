import { corsPreflight, jsonResponse } from '../../../lib/http.js';
import { validClientId, activatePayment, getQuota } from '../../../lib/quota-store.js';
import { createOrder, getPlan, updateOrder } from '../../../lib/order-store.js';
import {
  createWechatNativeOrder,
  createWechatJsapiOrder,
  isWechatPayConfigured,
} from '../../../lib/wechat-pay.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight(request);
  if (request.method !== 'POST') {
    return jsonResponse(request, { error: 'Method not allowed' }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, { error: '无效 JSON' }, 400);
  }

  const { clientId, plan, channel = 'native', openid } = body;
  if (!validClientId(clientId)) {
    return jsonResponse(request, { error: '无效的 clientId' }, 400);
  }
  if (!getPlan(plan)) {
    return jsonResponse(request, { error: '无效的套餐 plan' }, 400);
  }

  const payChannel = channel === 'jsapi' ? 'wechat_jsapi' : 'wechat_native';
  const created = await createOrder(env, {
    clientId,
    planId: plan,
    channel: payChannel,
    openid: openid || null,
  });
  if (created.error) return jsonResponse(request, { error: created.error }, 400);

  const { order } = created;
  const description = `Q问会员-${order.planLabel}`;

  try {
    let payResult;
    if (payChannel === 'wechat_jsapi') {
      payResult = await createWechatJsapiOrder(env, request, {
        orderId: order.orderId,
        description,
        amountFen: order.amountFen,
        openid,
      });
    } else {
      payResult = await createWechatNativeOrder(env, request, {
        orderId: order.orderId,
        description,
        amountFen: order.amountFen,
      });
    }

    await updateOrder(env, order.orderId, {
      codeUrl: payResult.codeUrl || null,
      prepayId: payResult.prepayId || null,
    });

    return jsonResponse(request, {
      ok: true,
      stub: !!payResult.stub,
      configured: isWechatPayConfigured(env),
      orderId: order.orderId,
      plan: order.plan,
      planLabel: order.planLabel,
      amount: order.amount,
      channel: payChannel,
      codeUrl: payResult.codeUrl || null,
      jsapi: payResult.jsapi || null,
      message: payResult.message || null,
    });
  } catch (err) {
    await updateOrder(env, order.orderId, { status: 'failed' });
    const msg = err.message || '微信下单失败';
    const hint =
      msg.includes('签名') || msg.includes('SIGN')
        ? '请核对 WECHAT_MCH_SERIAL 是否与 apiclient_key.pem 对应证书序列号一致（商户平台 → API 安全 → 管理证书）'
        : '若见 WECHAT_PAY_SIGNING_NOT_IMPLEMENTED，需在 functions/lib/wechat-pay.js 实现 V3 签名';
    return jsonResponse(request, { error: msg, orderId: order.orderId, hint }, 502);
  }
}
