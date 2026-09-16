import { activatePayment } from '../../../lib/quota-store.js';
import { markOrderPaid } from '../../../lib/order-store.js';
import { sendNoticeMail } from '../../../lib/mail.js';
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

    // 付款成功 → 立刻通知运营（邮件）。
    // 只在实际扣款成功（!alreadyPaid）时发一次，微信重试回调不会重复发信。
    // 通知失败必须吞掉：它不能影响回调结果，否则微信会重试、可能造成订单/会员状态不一致。
    try {
      const cny = (Number(order.amountFen || 0) / 100).toFixed(2);
      await sendNoticeMail(env, {
        subject: `[Q问收款] ¥${cny} 已到账 · ${order.planLabel || order.plan} · 会员已自动开通`,
        text: [
          '微信在线支付成功，会员已自动开通，无需人工核实。',
          '',
          `订单号：${order.orderId}`,
          `套餐：${order.planLabel || order.plan}（${order.plan}）`,
          `金额：¥${cny}`,
          `客户标识：${order.clientId}`,
          `微信交易号：${transactionId}`,
          `时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
          '',
          '本条为系统自动通知；全部订单可在运营台「在线订单」查看。',
        ].join('\n'),
      });
    } catch (err) {
      console.error('[notify] 付款通知邮件发送失败：', err);
    }
  }

  return wechatNotifySuccessResponse();
}
