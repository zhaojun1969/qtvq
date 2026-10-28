import { activatePaidOrder } from '../../../lib/payment-activate.js';
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
    // 非成功状态也要回 SUCCESS，否则微信会一直重试
    return wechatNotifySuccessResponse();
  }

  const result = await activatePaidOrder(env, outTradeNo, {
    platformTradeNo: transactionId,
    source: '微信回调',
  });
  if (!result.ok) {
    return wechatNotifyFailResponse(result.error);
  }

  return wechatNotifySuccessResponse();
}
