/**
 * Q问 · 跨端共享规则（唯一来源）
 *
 * ── 为什么要有这个包（2026-10-11 的两次真实事故）──────────────────────────
 * 同一份规则此前**网页写一遍、小程序再写一遍**，于是：
 *   ① 举报原因白名单：网页 7 项、小程序 4 项 → 小程序举报**必然 400**（用户点了没反应）；
 *   ② 收款渠道的 `autoCredit`：小程序那份没标"不会自动到账" → 用户以为付了就会自动到账。
 * 两次都是靠"事后加检查器比对字符串"兜住的 —— 那是**发现**不一致，不是**消除**不一致。
 * 现在把这类纯常量收到这里，两端 import 同一份，结构上不再可能漂移。
 *
 * ── 边界（克制很重要）────────────────────────────────────────────────────
 * 这里**只放"纯数据与纯函数"**：不放 DOM、不放 uni API、不放 fetch、不放任何平台特性。
 * 需要平台差异时，由各端自己包一层（例如小程序的支付按钮显隐），而不是把 ifdef 塞进来。
 */

/**
 * 举报原因白名单 —— **唯一来源**。
 *
 * 2026-10-26 更正：这里原来写的是"必须与服务端 moderation.js 的 REPORT_REASONS 一致"，
 * 那描述的是"靠人工同步"的老状态。现在三端都直接 import 本常量：
 *   · 官网     `js/report-api.js`
 *   · 小程序   `apps/qtvq-uni/src/data/moderation.js`（经 `@qtvq/shared` alias）
 *   · 服务端   `server/src/services/moderation.js`
 * 由 `tools/scripts/check-shared-derivation.mjs` 机器校验，不再依赖"记得改另一个地方"。
 */
export const REPORT_REASONS = ['涉黄', '广告', '诈骗', '辱骂', '头像违规', '虚假资料', '其他'];

/**
 * 静态收款码渠道（**不会自动到账**）。
 *
 * `autoCredit: true` 表示"付款后系统能自动入账"；静态收款码没有订单号、没有回调，
 * 因此恒为 false —— 界面必须据此显示"不会自动到账、需人工核实"，不能只靠文案自觉。
 * 动态在线支付（微信订单码）不属于这个列表，它由 `/api/payment/wechat/create` 下单后临时生成。
 */
export const STATIC_PAY_CHANNELS = {
  wechat: {
    id: 'wechat',
    label: '微信支付',
    image: 'assets/payment/qr-wechat.png',
    autoCredit: false,
    tip: '⚠️ 静态收款码：**不会自动到账，也不会自动生成充值/开通记录**。\n① 打开微信 → 扫一扫 → 付款（备注建议填设备编号） ② 必须点下方「我已付款 · 提交核实」 ③ 客服核对到账后**手工入账**。',
    openApp: null,
  },
  aggregate: {
    id: 'aggregate',
    label: '聚合码',
    image: 'assets/payment/qr-aggregate.png',
    autoCredit: false,
    tip: '⚠️ 静态收款码：**不会自动到账，也不会自动生成充值/开通记录**。\n① 用微信/支付宝/云闪付扫一扫付款（备注建议填设备编号） ② 必须点下方「我已付款 · 提交核实」 ③ 客服核对到账后**手工入账**。',
    openApp: null,
  },
};

/** 缘值充值金额上限（与服务端 `validateTopupAmount` 同口径：¥1–2000，两位小数） */
export const TOPUP_MIN = 1;
export const TOPUP_MAX = 2000;

/** 充值金额是否合法（两端共用同一判据，避免"前端允许 0 元、后端拒收"这类分歧） */
export function isValidTopupAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return false;
  if (n < TOPUP_MIN || n > TOPUP_MAX) return false;
  return Math.round(n * 100) === n * 100; // 最多两位小数
}

/** 举报原因是否在白名单内（客户端先挡一道，服务端仍会再校验） */
export function isReportReason(v) {
  return REPORT_REASONS.includes(String(v || '').trim());
}

/**
 * 渠道提示的组装（纯函数，无 DOM）。
 * 静态码渠道第一行必须是"不会自动到账" —— 这是业务方实测踩过两次的坑。
 */
export function channelTip(channelId, price) {
  const ch = STATIC_PAY_CHANNELS[channelId];
  if (!ch) return '';
  const amount = String(price ?? '').trim();
  const lines = [
    `① 付款金额请填 ¥${amount}（可点下方「复制金额」一键复制），备注填设备编号`,
    '② 付完点下方「我已付款 · 提交核实」',
    '③ 客服核对到账后**手工入账**（静态码不会自动识别，必须做第②步）',
  ];
  if (ch.autoCredit === false) {
    lines.unshift('⚠️ 此通道为静态收款码：**不会自动到账，也不会自动生成记录**，需人工核实后入账');
  }
  return lines.join('\n');
}