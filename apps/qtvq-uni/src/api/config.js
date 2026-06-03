/** 与 Web js/config.js 一致 */
export const API_BASE = 'https://qtvq-api.pages.dev';

export function apiUrl(path) {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE}${p}`;
}
