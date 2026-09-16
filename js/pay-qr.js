/**
 * 扫码支付渠道配置。
 *
 * 按业务要求只保留两个：微信支付 + 聚合码。
 * 支付宝（两个）与云闪付/工商银行已下线 —— 渠道配置只留这里一份，
 * index.html 的卡片与 QR 放大查看器都读它，所以移除渠道时两处会自动一致。
 */

export const PAY_CHANNELS = {
  wechat: {
    id: 'wechat',
    label: '微信支付',
    image: 'assets/payment/qr-wechat.png',
    tip: '请打开微信 → 扫一扫 → 扫描上方二维码。在微信内打开本页可长按识别。付款备注请填写设备编号。',
    openApp: null,
  },
  aggregate: {
    id: 'aggregate',
    label: '聚合码',
    image: 'assets/payment/qr-aggregate.png',
    tip: '支持微信、支付宝、云闪付等扫码付款。付款后请在同一页面填写金额与设备编号并提交核实，客服核对到账后开通会员。',
    openApp: null,
  },
};

export function detectPayEnv() {
  const ua = navigator.userAgent || '';
  return {
    wechat: /MicroMessenger/i.test(ua),
    alipay: /AlipayClient/i.test(ua),
  };
}
