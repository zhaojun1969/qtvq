/** API 源站：国内静态站 qtvq.cn 跨域请求 Cloudflare Pages */

export const API_ORIGIN = (() => {
  if (typeof location === 'undefined') return 'https://qtvq-api.pages.dev';
  const { hostname, port, origin } = location;
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    port === '8788' ||
    origin.includes('qtvq-api.pages.dev')
  ) {
    return '';
  }
  return 'https://qtvq-api.pages.dev';
})();

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
