/**
 * 配对报告（Node 服务 /v1/report/*，与 ECS 同机、延迟最低）
 *
 * 注意：这些接口位于 Node 服务，**必须带登录 token**（utils/auth.js 的 authHeader 会自动带上）。
 * 与 Web 端 js/report-api.js 保持同一路径口径 —— 后端路由实测：
 *   POST /v1/report/generate         生成报告（会校验余额/扣费，幂等）
 *   GET  /v1/report/mine             我的报告列表
 *   GET  /v1/report/:id              报告详情
 *   POST /v1/report/:id/share        生成分享链接
 *   POST /v1/report/invite           生成邀请链接（增长候选池）
 *   GET  /v1/report/invite/:token    查看邀请
 *   POST /v1/report/invite/:token/accept  接受邀请
 */
import { get, post } from './request.js';

/** 生成配对报告（tier: basic 免费 / 其他档位按 quote 计价） */
export function generateReport({ targetUid, tier = 'basic', question = '', idempotencyKey } = {}) {
  return post('/v1/report/generate', { targetUid, tier, question, idempotencyKey });
}

export function fetchMyReports(limit = 20) {
  return get('/v1/report/mine', { limit });
}

export function fetchReport(reportId, shareToken) {
  return get(`/v1/report/${encodeURIComponent(reportId)}`, shareToken ? { share: shareToken } : undefined);
}

export function shareReport(reportId) {
  return post(`/v1/report/${encodeURIComponent(reportId)}/share`);
}

export function createInvite() {
  return post('/v1/report/invite');
}

export function fetchInvite(token) {
  return get(`/v1/report/invite/${encodeURIComponent(token)}`);
}

export function acceptInvite(token) {
  return post(`/v1/report/invite/${encodeURIComponent(token)}/accept`);
}
