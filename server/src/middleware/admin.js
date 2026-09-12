/** 运营台鉴权：未配置 ADMIN_KEY 时整组接口按 404 处理，不暴露「这里有个后台」 */
import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError } from '../lib/http.js';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

export function requireAdmin(req, res, next) {
  if (!env.adminKey) {
    return next(new ApiError(404, 'Not found', 'E_NOT_FOUND'));
  }
  // 只接受请求头。刻意不支持 query 传参：URL 会进 Nginx access log
  const key = req.headers['x-admin-key'];
  if (!safeEqual(key, env.adminKey)) {
    return next(new ApiError(401, '运营口令无效', 'E_ADMIN_AUTH'));
  }
  req.admin = 'admin';
  next();
}
