/**
 * 幸运转盘（Node 服务 /v1/wheel/*）
 *
 * 后端路由实测：
 *   GET  /v1/wheel/quote       本次要花多少（会员每日免一次；否则从钱包扣 ¥1）
 *   GET  /v1/wheel/candidates  候选池（含 needsProfile / empty，**转盘能不能转由它决定**）
 *   POST /v1/wheel/spin        转一次（服务端决定结果，前端只做动画）
 *   GET  /v1/wheel/history     历史记录
 *
 * 关键约定（来自后端实现，别改）：
 *   · 结果一定以 `/spin` 返回的 targetIndex 为准 —— 前端**不得**自己随机，
 *     否则就变成"假转盘"（消保法 55 条风险）。
 *   · 未完善资料或候选池为空时，按钮应禁用并给出提示，而不是让用户点了失败。
 */
import { get, post } from './request.js';

export function fetchWheelQuote() {
  return get('/v1/wheel/quote');
}

export function fetchWheelCandidates() {
  return get('/v1/wheel/candidates');
}

export function spinWheel() {
  return post('/v1/wheel/spin');
}

export function fetchSpinHistory(limit = 10) {
  return get('/v1/wheel/history', { limit });
}
