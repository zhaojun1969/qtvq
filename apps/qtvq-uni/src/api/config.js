/**
 * API 基址（与 Web 端 js/config.js 保持同一口径）
 *
 * ⚠️ 2026-09-18 修正：原来指向 `https://qtvq-api.pages.dev`，这在小程序里**会直接被拦**：
 *   微信小程序的 request 合法域名要求**已完成 ICP 备案**，而 `pages.dev` 是 Cloudflare 的域名、
 *   不可能备案。上线后所有接口都会失败（开发者工具里勾了"不校验合法域名"才能通，真机必挂）。
 *   现在统一走自有备案域名 `https://qtvq.cn`（nginx 已把 `/api/` 反代到 Pages、`/v1/` 反代到 ECS Node 服务）。
 *
 * 小程序后台需要配置的合法域名：
 *   request 合法域名：https://qtvq.cn
 *   （不需要再配 pages.dev；下载/上传类域名按需再加）
 */
export const API_BASE = 'https://qtvq.cn';

export function apiUrl(path) {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE}${p}`;
}
