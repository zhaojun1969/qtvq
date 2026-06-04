/** 四种扫码支付渠道配置 */

export const PAY_CHANNELS = {
  wechat: {
    id: 'wechat',
    label: '微信支付',
    image: 'assets/payment/qr-wechat.png',
    tip: '请打开微信 → 扫一扫 → 扫描上方二维码。在微信内打开本页可长按识别。付款备注请填写设备编号。',
    openApp: null,
  },
  'alipay-shop': {
    id: 'alipay-shop',
    label: '支付宝',
    image: 'assets/payment/qr-alipay-shop.png',
    tip: '请打开支付宝 → 扫一扫 → 扫描上方二维码。付款备注请填写设备编号。',
    openApp: 'alipays://platformapi/startapp?saId=10000007',
  },
  'alipay-scan': {
    id: 'alipay-scan',
    label: '支付宝 · 扫一扫',
    image: 'assets/payment/qr-alipay-scan.png',
    tip: '点击「打开支付宝」或手动打开支付宝 → 扫一扫 → 扫描上方二维码。',
    openApp: 'alipays://platformapi/startapp?saId=10000007',
  },
  unionpay: {
    id: 'unionpay',
    label: '云闪付 / 工商银行',
    image: 'assets/payment/qr-unionpay-icbc.png',
    tip: '请打开云闪付或工商银行 App → 扫一扫 → 扫描上方二维码。可在 App 内设置金额为所选套餐。',
    openApp: 'upwallet://native/scanCode',
  },
};

export function detectPayEnv() {
  const ua = navigator.userAgent || '';
  return {
    wechat: /MicroMessenger/i.test(ua),
    alipay: /AlipayClient/i.test(ua),
  };
}
