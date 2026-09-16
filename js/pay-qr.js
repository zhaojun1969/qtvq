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
    tip: '① 打开微信 → 扫一扫 → 付款（备注建议填设备编号） ② 点下方「我已付款 · 提交核实」 ③ 客服核对到账后立即开通会员。',
    openApp: null,
  },
  aggregate: {
    id: 'aggregate',
    label: '聚合码',
    image: 'assets/payment/qr-aggregate.png',
    tip: '① 用微信/支付宝/云闪付扫一扫付款（备注建议填设备编号） ② 点下方「我已付款 · 提交核实」 ③ 客服核对到账后立即开通会员。',
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
