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
 * 是否"非微信的小程序端"（支付宝 / 抖音 / 小红书 / QQ / 百度 / 快手 / 京东）。
 *
 * 用 `!isWechatMiniProgram()` 而不是逐个列平台：本文件开头已经写明新增平台
 * 必须同步改这里，而"逐个列"的写法每加一个平台就多一处漏改机会 —— 漏掉的那个
 * 会被当成"微信端"，从而拿到微信端的支付与登录分支。
 */
export function isOtherMiniProgram() {
  // #ifdef MP
  return !isWechatMiniProgram();
  // #endif
  // #ifndef MP
  return false;
  // #endif
}

/**
 * 是否禁止在小程序内售卖虚拟商品。两类端，原因完全不同：
 *
 * ① **微信小程序 · iOS**：微信禁止在 iOS 小程序内完成虚拟商品交易。
 *    把 JSAPI 按钮换成静态收款码（或引导扫自家对公码）属于**同一条违规的
 *    另一种写法**，不是规避成功，所以必须"整块不出现"。
 * ② **非微信的其它小程序端**（2026-10-28 补）：
 *    这些平台各有自己的虚拟支付能力（支付宝支付、抖音支付、快手支付…），
 *    本项目只接了微信 JSAPI。原来这些端回落到"静态收款码 + 提交核实"，
 *    实际渲染出来就是：**在快手页面里显示"微信支付"按钮、拉起微信/支付宝收款码**。
 *    这在任一平台上都同时踩两条：站内售卖虚拟商品未走平台支付 + 站内推广第三方支付。
 *    所以一律整块隐藏，与 iOS 同一处理方式。
 *
 * 与 `supportsWechatJsapiPay()` 的分工：后者只决定"能不能直接扣款"，
 * 本函数决定"整块付费区还要不要显示"。
 */
export function isVirtualPayBlocked() {
  // #ifdef MP
  return isOtherMiniProgram() || isIosMiniProgram();
  // #endif
  // #ifndef MP
  return false;
  // #endif
}

/**
 * 付费区被禁用时，"范围"在标题里怎么称呼。
 *
 * 微信端是"iOS 端"（同一个 APK 里安卓能买、iOS 不能，说清是哪一端很重要）；
 * 其它小程序端是"小程序内"（整端都不能买，不存在"换台设备就行"）。
 */
export function payBlockScopeLabel() {
  // #ifdef MP-WEIXIN
  return 'iOS 端';
  // #endif
  // #ifndef MP-WEIXIN
  return '小程序内';
  // #endif
}

/**
 * 付费区被禁用时，要不要给"去网页版购买"的出口。
 *
 * 只有微信 iOS 给：那是**同一个产品在同一平台上的另一端**，用户手上的权益不变，
 * 指路是合理的。其它小程序端不给 —— 在快手/抖音里放一个"去 qtvq.cn 买"的按钮，
 * 正是这些平台明令禁止的站外交易引导，等于用另一种方式重犯刚绕开的错。
 */
export function canReferWebPurchase() {
  // #ifdef MP-WEIXIN
  return true;
  // #endif
  // #ifndef MP-WEIXIN
  return false;
  // #endif
}

/**
 * 付费区被禁用时的统一文案。**按平台分两份**，不能共用一句：
 *
 * - 微信 iOS：说明是哪条平台规则、并给出明确出路（安卓设备 / 浏览器）。
 *   只写"暂不支持"会让用户以为产品坏了。
 * - 其它小程序端：只陈述"站内不提供在线购买"，**不提任何外部渠道**。
 *   这类平台的审核口径是把"引导站外交易"本身当作违规项，文案里点名官网、
 *   手机号或二维码都会把刚做对的屏蔽重新变成问题。
 */
// #ifdef MP-WEIXIN
export const VIRTUAL_PAY_BLOCKED_TIP =
  '受微信平台规则限制，iOS 端小程序内不支持购买会员或充值缘值（此为虚拟商品交易）。' +
  '请在安卓设备上打开小程序，或用电脑/手机浏览器访问 qtvq.cn 完成购买，权益与小程序内一致。';
// #endif
// #ifndef MP-WEIXIN
export const VIRTUAL_PAY_BLOCKED_TIP =
  '本小程序不提供在线购买与充值，站内不涉及任何支付。免费功能与已购权益不受影响。';
// #endif

/**
 * 能不能充值（与 `isVirtualPayBlocked()` 同义，但语义从"页面"换成"按钮"）。
 *
 * 给「我的」页的充值按钮做 `v-if` 用：付费被禁用的端如果只把按钮文案改中性，
 * 会出现两个都跳钱包页的按钮（"查看缘值余额与流水" 与 "缘值钱包"），
 * 用户点进去发现不能充，反而更像坏了。所以这里直接不显示这个按钮。
 */
export function canTopup() {
  return !isVirtualPayBlocked();
}

/**
 * 额度不足时的提示尾句（报告页 / 转盘页共用）。
 *
 * 同样分两类：能充值的端指路到充值；不能充值的端**不能指路** ——
 * 指过去只有一句"不支持"，用户会以为产品坏了，还会在快手页面里读到
 * "用微信在线支付"这种不属于该平台的说法。
 */
export function needQuotaHint() {
  if (isVirtualPayBlocked()) return '。会员每日有免费次数，可在「办理会员」页查看。';
  return '。去「我的账户 → 缘值充值」用微信在线支付，付完自动到账。';
}
