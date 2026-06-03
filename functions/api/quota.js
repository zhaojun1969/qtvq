import { getQuota, recordAsk } from '../lib/quota-store.js';
import { corsPreflight, jsonResponse } from '../lib/http.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight(request);

  const url = new URL(request.url);
  const clientId = url.searchParams.get('clientId');

  if (!clientId) return jsonResponse(request, { error: '缺少 clientId' }, 400);

  if (request.method === 'GET') {
    const quota = await getQuota(env, clientId);
    if (!quota) return jsonResponse(request, { error: '无效 clientId' }, 400);
    return jsonResponse(request, quota);
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(request, { error: '无效 JSON' }, 400);
    }
    if (body.action === 'record' && body.clientId === clientId) {
      await recordAsk(env, clientId);
      return jsonResponse(request, await getQuota(env, clientId));
    }
    return jsonResponse(request, { error: '未知操作' }, 400);
  }

  return jsonResponse(request, { error: 'Method not allowed' }, 405);
}
