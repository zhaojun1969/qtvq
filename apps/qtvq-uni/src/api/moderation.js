/**
 * 举报与内容安全（Node 服务 /v1/moderation/*、/v1/safety/*）
 *
 * 后端路由实测：
 *   POST /v1/moderation/report    举报用户/内容（重复举报会返回 duplicate）
 *   GET  /v1/moderation/mine      我的举报记录
 *   GET  /v1/safety/status        内容安全当前状态（本地词表条数、外部服务是否接入）
 *   POST /v1/safety/check         提交前预检文本（与后端同一套判定）
 *
 * 为什么要预检：本地词表只覆盖"底线"（涉黄赌毒诈等），涉政类刻意不内置；
 * 举报是人工兜底通道，配合运营台审核。
 */
import { get, post } from './request.js';
/*
 * 举报原因白名单 —— **唯一来源是 `packages/shared`**（服务端 `server/src/services/moderation.js` 也对着它校验）。
 *
 * 2026-10-11 事故：这里曾自己写一份，而网页端写的是 7 项、小程序只写了 4 项
 * ⇒ 小程序举报**必然**被服务端拒（400 E_BAD_REASON「无效的举报原因」），用户点了没反应。
 * 收敛到 shared 后，两端不再可能各写一份。
 */
import { REPORT_REASONS } from '@qtvq/shared';

export { REPORT_REASONS };

export function submitReport({ targetType = 'user', targetId, reason, detail = '' }) {
  return post('/v1/moderation/report', { targetType, targetId, reason, detail });
}

export function fetchMyReports(limit = 20) {
  return get('/v1/moderation/mine', { limit });
}

export function fetchSafetyStatus() {
  return get('/v1/safety/status');
}

export function checkText(text, field = 'default') {
  return post('/v1/safety/check', { text, field });
}