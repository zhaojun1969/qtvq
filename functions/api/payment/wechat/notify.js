import { activatePayment } from '../../../lib/quota-store.js';
import { markOrderPaid } from '../../../lib/order-store.js';
import {
  verifyWechatNotify,
  wechatNotifySuccessResponse,
  wechatNotifyFailResponse,
} from '../../../lib/wechat-pay.js';

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return wechatNotifyFailResponse('Method not allowed');
  }

  const verified = await verifyWechatNotify(env, request);
  if (!verified.ok) {
    return wechatNotifyFailResponse(verified.error || '验签失败');
  }

  const { outTradeNo, transactionId, tradeState } = verified;
  if (tradeState !== 'SUCCESS') {
    return wechatNotifySuccessResponse();
  }

  const paid = await markOrderPaid(env, outTradeNo, {
    platformTradeNo: transactionId,
    paidAt: Date.now(),
  });
  if (paid.error) {
    return wechatNotifyFailResponse(paid.error);
  }

  const { order, alreadyPaid } = paid;
  if (!alreadyPaid) {
    const activated = await activatePayment(env, order.clientId, order.plan);
    if (!activated) {
      return wechatNotifyFailResponse('会员激活失败');
    }
  }

  return wechatNotifySuccessResponse();
}
