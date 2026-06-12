/** 与 Web js/pay-qr.js 一致的四种扫码收款渠道 */

export const PAY_CHANNELS = [
  {
    id: 'wechat',
    label: '微信支付',
    image: '/static/payment/qr-wechat.png',
    tip: '请打开微信 → 扫一扫 → 扫描下方二维码。在微信内可长按识别。付款备注请填写设备编号。',
  },
  {
    id: 'alipay-shop',
    label: '支付宝',
    image: '/static/payment/qr-alipay-shop.png',
    tip: '请打开支付宝 → 扫一扫 → 扫描下方二维码。付款备注请填写设备编号。',
  },
  {
    id: 'alipay-scan',
    label: '支付宝 · 扫一扫',
    image: '/static/payment/qr-alipay-scan.png',
    tip: '打开支付宝 → 扫一扫 → 扫描下方二维码。付款备注请填写设备编号。',
  },
  {
    id: 'unionpay',
    label: '云闪付 / 工商银行',
    image: '/static/payment/qr-unionpay-icbc.png',
    tip: '请打开云闪付或工商银行 App → 扫一扫 → 扫描下方二维码。可在 App 内设置金额为所选套餐。',
  },
];
