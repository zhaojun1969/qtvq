/** 允许从国内静态域跨域调用 Cloudflare API */

export const ALLOW_ORIGINS = [
  'https://qtvq.cn',
  'https://www.qtvq.cn',
  'https://qtvq-api.pages.dev',
  'http://localhost:8788',
  'http://127.0.0.1:8788',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

export function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  const allow =
    origin && ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

export function corsPreflight(request) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request),
  });
}
