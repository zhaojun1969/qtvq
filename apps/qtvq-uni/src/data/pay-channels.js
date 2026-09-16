/**
 * 与 Web js/pay-qr.js 一致的扫码收款渠道。
 *
 * 按业务要求只保留两个：微信支付 + 聚合码；支付宝（两个）与云闪付/工商银行已下线。
 * 改这里之后需要重新构建小程序并上传（uni:build:weixin 等），小程序端不会自动更新。
 */

export const PAY_CHANNELS = [
  {
    id: 'wechat',
    label: '微信支付',
    image: '/static/payment/qr-wechat.png',
    tip: '请打开微信 → 扫一扫 → 扫描下方二维码。在微信内可长按识别。付款备注请填写设备编号。',
  },
  {
    id: 'aggregate',
    label: '聚合码',
    image: '/static/payment/qr-aggregate.png',
    tip: '支持微信、支付宝、云闪付等扫码付款。付款后请在同一页面填写金额与设备编号并提交核实，客服核对到账后开通会员。',
  },
];
