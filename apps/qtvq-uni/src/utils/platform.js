/**
 * 当前运行平台
 *
 * 加平台时**必须同步改这个文件**：`platformLabel()` 决定界面文案，`isMiniProgram()`
 * 决定走小程序分支还是浏览器分支。这两处漏改的后果是静默的 ——
 * 新平台会显示「未知」并走错分支（历史上 MP-XHS 就是这样漏过一次）。
 *
 * 新增平台清单（共 8 个小程序端）：微信 / 支付宝 / 抖音 / 小红书 / QQ / 百度 / 快手 / 京东
 * 另有 H5 与 APP-PLUS（Android / iOS / 鸿蒙）。
 *
 * 覆盖检查：`npm run check:platforms`（在 apps/qtvq-uni 下）会核对
 * manifest.json、package.json 脚本、本文件三处是否一致。
 */

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
  // #ifdef MP-XHS
  return '小红书小程序';
  // #endif
  // #ifdef MP-QQ
  return 'QQ 小程序';
  // #endif
  // #ifdef MP-BAIDU
  return '百度小程序';
  // #endif
  // #ifdef MP-KUAISHOU
  return '快手小程序';
  // #endif
  // #ifdef MP-JD
  return '京东小程序';
  // #endif
  // #ifdef H5
  return 'H5';
  // #endif
  // #ifdef APP-PLUS
  return 'App';
  // #endif
  return '未知';
}

/**
 * 是否小程序环境。
 *
 * 用 `MP` 一次覆盖所有小程序平台，而不是逐个列出 —— 逐个列出的写法
 * （原来的 `MP-WEIXIN || MP-ALIPAY || MP-TOUTIAO || MP-XHS`）每加一个平台就得改一次，
 * 漏改时新平台会被当成"浏览器环境"，走到不该走的代码分支。
 */
export function isMiniProgram() {
  // #ifdef MP
  return true;
  // #endif
  return false;
}

/** 是否微信小程序（JSAPI 支付、微信一键登录、微信内容安全等仅微信可用） */
export function isWechatMiniProgram() {
  // #ifdef MP-WEIXIN
  return true;
  // #endif
  return false;
}

/**
 * 是否支持「微信在线支付」。
 *
 * 只有微信小程序能调 `uni.requestPayment`（JSAPI）。其它小程序平台各有自己的支付
 * （支付宝小程序用支付宝、抖音用抖音支付…），本项目**尚未逐个接入**，
 * 所以其它端一律回落到"静态收款码 + 提交核实"这条人工通道（见订阅页的 #ifdef）。
 * 这里返回布尔值而不是写死判断，是为了让订阅页/钱包页只有一个判断点。
 */
export function supportsWechatJsapiPay() {
  // #ifdef MP-WEIXIN
  return true;
  // #endif
  return false;
}
