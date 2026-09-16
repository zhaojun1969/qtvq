/**
 * API 源站。
 *
 * 生产改为**同源优先**：qtvq.cn 的 nginx 把 /api/ 反代到 Cloudflare Pages，
 * 浏览器只走阿里云（实测典型 1.6s），彻底避开「国内直连 Pages 偶尔 8–14 秒 →
 * 前端 8 秒超时 → 报 API 不可用且无备份」那条老路（2026-09-16 已实测复现）。
 * 直连 Pages 保留为备选，由 api-fetch.js 的 failover 顺序决定：
 *   同源（nginx 反代） → 直连 Pages → 阿里云 OSS 备份
 * 注意：小程序不能用这套（微信/支付宝的 request 合法域名是 qtvq-api.pages.dev），
 * 小程序有自己的 apps/qtvq-uni/src/api/config.js。
 */
export const API_ORIGIN = (() => {
  if (typeof location === 'undefined') return 'https://qtvq-api.pages.dev';
  const { hostname, port, origin } = location;
  if (hostname === 'localhost' || hostname === '127.0.0.1' || port === '8788' || origin.includes('qtvq-api.pages.dev')) {
    return '';
  }
  // 生产（qtvq.cn）：走同源，由 nginx 反代到 Pages
  return '';
})();

/** 备选源站：直连 Cloudflare Pages（同源失败时用） */
export const CROSS_ORIGIN = 'https://qtvq-api.pages.dev';

/**
 * 阿里云 OSS 备份读地址（Cloudflare 慢/不可用时降级）
 * 与 obs.env 中 OSS_BUCKET + OSS_BACKUP_PREFIX 对应，backup/api 建议公共读
 */
export const BACKUP_ORIGIN = (() => {
  if (typeof location === 'undefined') return 'https://qtvq.oss-cn-beijing.aliyuncs.com/qtvq/backup';
  return 'https://qtvq.oss-cn-beijing.aliyuncs.com/qtvq/backup';
})();

/** @param {string} path 以 / 开头的路径，如 /api/chat */
export function apiUrl(path) {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${API_ORIGIN}${p}`;
}
