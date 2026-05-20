import { getQuota, recordAsk } from '../lib/quota-store.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const clientId = url.searchParams.get('clientId');

  if (!clientId) return json({ error: '缺少 clientId' }, 400);

  if (request.method === 'GET') {
    const quota = await getQuota(env, clientId);
    if (!quota) return json({ error: '无效 clientId' }, 400);
    return json(quota);
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: '无效 JSON' }, 400);
    }
    if (body.action === 'record' && body.clientId === clientId) {
      await recordAsk(env, clientId);
      return json(await getQuota(env, clientId));
    }
    return json({ error: '未知操作' }, 400);
  }

  return json({ error: 'Method not allowed' }, 405);
}
