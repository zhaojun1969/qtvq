/**
 * 个人资料（Node 服务 /v1/profile/*）
 *
 * 后端路由实测：
 *   GET   /v1/profile/me     我的资料
 *   PATCH /v1/profile/me     保存资料（昵称、性别等）
 *   GET   /v1/profile/:uid   看别人的资料（用于转盘/报告展示）
 *
 * 为什么资料重要：**转盘要求先完善资料**（需要知道你的性别才能只出异性候选），
 * 否则 `/v1/wheel/candidates` 会返回 needsProfile，转盘按钮会被禁用。
 */
import { get, request } from './request.js';
import { apiUrl } from './config.js';

export function fetchMyProfile() {
  return get('/v1/profile/me');
}

/** 保存资料。字段按后端要求传：nickname / gender / city / tags 等 */
export function saveMyProfile(patch) {
  return request({
    url: apiUrl('/v1/profile/me'),
    method: 'PATCH',
    header: { 'Content-Type': 'application/json' },
    data: patch,
  });
}

export function fetchProfile(uid) {
  return get(`/v1/profile/${encodeURIComponent(uid)}`);
}
