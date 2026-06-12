/** 当前运行平台 */

export function platformLabel() {
  // #ifdef MP-WEIXIN
  return '微信小程序';
  // #endif
  // #ifdef MP-ALIPAY
  return '支付宝小程序';
  // #endif
  // #ifdef MP-TOUTIAO
  return '抖音小程序';
  // #endif
  // #ifdef H5
  return 'H5';
  // #endif
  // #ifdef APP-PLUS
  return 'App';
  // #endif
  return '未知';
}

export function isMiniProgram() {
  // #ifdef MP-WEIXIN || MP-ALIPAY || MP-TOUTIAO
  return true;
  // #endif
  return false;
}
