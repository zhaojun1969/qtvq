/**
 * 扫码收款渠道 —— **规则来自 `packages/shared`（跨端唯一来源）**。
 *
 * 本文件只做两件"各端特有"的事，不重复任何业务规则：
 *   ① 资源路径映射：shared 里不带 `image`（网页是 `assets/payment/qr-*.png`，
 *      小程序静态目录是 `/static/payment/qr-*.png`，两端资源位置天然不同）；
 *   ② 形态转换：页面用 `v-for` 遍历（要数组），shared 里是便于按 id 取值的对象。
 *
 * 2026-10-11 起因：此前这里与 Web `js/pay-qr.js` **各写一份**，而小程序这份
 * 少了两样东西 —— `autoCredit` 字段与「不会自动到账」的提示。后果是用户以为
 * 静态码付了就会自动到账（业务方实测两次），而两边不一致只能靠检查器事后发现。
 * 现在规则只存在于 shared，两端 import 同一份，结构上不再可能漂移。
 */
import { STATIC_PAY_CHANNELS, channelTip } from '@qtvq/shared';

const IMAGES = {
  wechat: '/static/payment/qr-wechat.png',
  aggregate: '/static/payment/qr-aggregate.png',
};

export const PAY_CHANNELS = Object.values(STATIC_PAY_CHANNELS).map((c) => ({
  ...c,
  image: IMAGES[c.id] || '',
}));

/* 静态收款码不会自动带入金额、也不会自动到账 —— 提示文案与网页端完全同一份实现 */
export { channelTip };