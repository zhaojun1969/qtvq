/** 各端下载链接配置 — 上架后填写 href，留空则显示「即将上线」 */

export const DOWNLOAD_LINKS = {
  android: {
    label: 'Android 下载',
    href: '', // 例: https://qtvq.cn/release/qtvq-android.apk
    store: '', // 例: 应用宝链接
  },
  ios: {
    label: 'App Store',
    href: '', // 例: https://apps.apple.com/app/idXXXXXXXX
  },
  harmony: {
    label: '华为应用市场',
    href: '', // 例: appgallery.huawei.com/...
  },
  weixin: {
    label: '打开微信小程序',
    href: '', // 例: weixin://dl/business/?t=xxx 或短链
    qrcode: '', // 例: assets/download/weixin-mp.png
  },
  alipay: {
    label: '打开支付宝小程序',
    href: '',
    qrcode: '',
  },
  douyin: {
    label: '打开抖音小程序',
    href: '',
  },
};
