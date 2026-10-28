/**
 * Q问 · 跨端文案查表（i18n 入口）
 *
 * 纯函数，零平台依赖（已通过 check-shared-purity）。
 * 各端各自 import { t } 并使用，不直接 import zh-CN（避免绕过 t 的 fallback 逻辑）。
 *
 * 用法
 * ----
 *   import { t } from '../packages/i18n/src/index.js';
 *   t('contact.title')               // → '联系客服'
 *   t('contact.toastFailed')         // → '提交失败'
 *   t('order.paidAt', { time: '10:30' })  // → '已于 10:30 支付'（模板插值）
 *   t('missing.key')                 // → 'missing.key'（fallback 到键名，不崩）
 */
import zhCN from './zh-CN.js';

/** 当前语言 */
export const locale = 'zh-CN';

/**
 * 查表。命中返回文案；未命中返回 key 本身（不抛异常，不返回空串）。
 * 支持 `{name}` 模板插值。
 */
export function t(key, params) {
  const str = zhCN[key];
  if (str === undefined) return key;
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (_, k) =>
    params[k] !== undefined ? String(params[k]) : `{${k}}`
  );
}

/** 批量查表：传入键数组，返回 { key: text } 对象。用于一次性取一页全部文案。 */
export function pick(keys) {
  const out = {};
  for (const k of keys) out[k] = t(k);
  return out;
}
