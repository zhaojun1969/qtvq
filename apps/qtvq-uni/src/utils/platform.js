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
 * 是否 iOS 版小程序（微信规则下的虚拟支付禁区）。
 *
 * 为什么要单独一个函数：`sys.platform` 在小程序里只有 `ios` / `android` / `devtools`
 * 三种常见取值（开发者工具是 `devtools`，按"非 iOS"处理 —— 工具里不校验支付，
 * 若在这里挡掉，本地调试会看不到支付按钮，反而更难发现问题）。
 *
 * 用 `#ifndef MP` 显式给出另一条 return，而不是让 MP 分支 return 后落到外层 return：
 * 后者在小程序编译产物里会留下不可达代码，某些 linter 会报错，且读起来像"漏了分支"。
 */
export function isIosMiniProgram() {
  // #ifdef MP
  try {
    const sys = uni.getSystemInfoSync();
    return String(sys?.platform || '').toLowerCase() === 'ios';
  } catch {
    // 取不到系统信息时按"非 iOS"处理：宁可多给一个按钮（点了会失败并提示），
    // 也不要在异常路径上把整块付费区静默隐藏 —— 后者对用户是"功能消失"，无从判断。
    return false;
  }
  // #endif
  // #ifndef MP
  return false;
  // #endif
}

/**
 * 是否支持「微信在线支付」。
 *
 * 只有微信小程序能调 `uni.requestPayment`（JSAPI）。其它小程序平台各有自己的支付
 * （支付宝小程序用支付宝、抖音用抖音支付…），本项目**尚未逐个接入**，
 * 所以其它端一律回落到"静态收款码 + 提交核实"这条人工通道（见订阅页的 #ifdef）。
 * 这里返回布尔值而不是写死判断，是为了让订阅页/钱包页只有一个判断点。
 *
 * ⚠️ 2026-10-28（E.44）修正：原实现只要 `MP-WEIXIN` 就返回 true，**没有排除 iOS**。
 * 微信小程序 iOS 端不允许用微信支付购买虚拟商品（会员、缘值、额度都算），
 * 这是审核的明确驳回项（微信「AI 生成合成内容标识」公告的违规案例里就写着
 * "② ios 暂不支持虚拟支付"）。在 iOS 上照常弹 `requestPayment` 的后果不是"付不了"，
 * 而是**提审被拒**，连 Android 一起上不了线。所以这里把 iOS 判成不支持。
 */
export function supportsWechatJsapiPay() {
  // #ifdef MP-WEIXIN
  return !isIosMiniProgram();
  // #endif
  // #ifndef MP-WEIXIN
  return false;
  // #endif
}

/**
 * 是否禁止在小程序内售卖虚拟商品（当前只有一处：iOS 微信小程序）。
 *
 * 与 `supportsWechatJsapiPay()` 的区别是**范围**：后者只决定"能不能直接扣款"，
 * 前者决定"整块付费区还要不要显示"。iOS 端必须按后者处理，原因是——
 *
 * 微信禁的是"在 iOS 小程序内完成虚拟商品交易"，把 JSAPI 按钮换成静态收款码
 * （或者引导用户扫自己的对公码）属于**同一条违规的另一种写法**，不是规避成功。
 * 所以 iOS 端不能"少一个按钮"，必须"整块不出现"，只留一句说明和去网页版的出口。
 *
 * 对公汇款一并隐藏：它在这里的用途就是个人用户买会员，性质仍是虚拟商品交易。
 */
export function isVirtualPayBlocked() {
  // #ifdef MP-WEIXIN
  return isIosMiniProgram();
  // #endif
  // #ifndef MP-WEIXIN
  return false;
  // #endif
}

/**
 * iOS 端禁用付费时的统一文案。
 *
 * 单一来源：订阅页、钱包页、以及检查脚本都读这一行，避免三处各写一句、
 * 改了一处漏两处。文案刻意给出**明确出路**（安卓设备 / 电脑浏览器），
 * 只写"暂不支持"会让用户以为产品坏了。
 */
export const VIRTUAL_PAY_BLOCKED_TIP =
  '受微信平台规则限制，iOS 端小程序内不支持购买会员或充值缘值（此为虚拟商品交易）。' +
  '请在安卓设备上打开小程序，或用电脑/手机浏览器访问 qtvq.cn 完成购买，权益与小程序内一致。';
