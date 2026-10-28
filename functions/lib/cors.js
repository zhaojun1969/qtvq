/** 允许从国内静态域跨域调用 Cloudflare API */

export const ALLOW_ORIGINS = [
  'https://qtvq.cn',
  'https://www.qtvq.cn',
  'https://qtvq-api.pages.dev',
  'http://localhost:8788',
  'http://127.0.0.1:8788',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  // 多端 H5 壳 / 本地调试（按需追加）
  // 'http://localhost:5173',
];

export function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  const allow =
    origin && ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    /*
     * Authorization 必须放行：独立域名（api.qtvq.cn）对 qtvq.cn 是**跨域**调用，
     * 而 `/api/auth/*`、`/api/auth/me` 都带 Bearer 令牌。只放 Content-Type 的话，
     * 预检（OPTIONS）会直接失败 —— 表现为"独立域名下登录态全部失效"。
     * X-Admin-Key 供运营工具跨域使用（同样需要预检放行）。
     */
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key',
    'Access-Control-Max-Age': '86400',
  };
}

export function corsPreflight(request) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request),
  });
}
