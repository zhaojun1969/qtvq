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

/** @param {string} path 以 / 开头的路径，如 /api/chat */
export function apiUrl(path) {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${API_ORIGIN}${p}`;
}
