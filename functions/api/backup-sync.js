import { corsPreflight, jsonResponse } from '../lib/http.js';
import { backupAllKv, backupStaticApiSnapshots } from '../lib/oss-backup.js';

function checkAdmin(env, adminKey) {
  const key = env.PAYMENT_ADMIN_KEY || env.ADMIN_KEY;
  return key && adminKey === key;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight(request);

  const url = new URL(request.url);
  const adminKey = url.searchParams.get('adminKey') || request.headers.get('X-Admin-Key');

  if (request.method === 'GET') {
    return jsonResponse(request, {
      service: 'qtvq-backup-sync',
      usage: 'POST ?adminKey= 全量 KV→OSS；POST body {"action":"static"} 仅静态 API 快照',
      ossConfigured: !!(env.OSS_ACCESS_KEY_ID && env.OSS_BUCKET),
    });
  }

  if (request.method !== 'POST') {
    return jsonResponse(request, { error: 'Method not allowed' }, 405);
  }

  if (!checkAdmin(env, adminKey)) {
    return jsonResponse(request, { error: '无权限' }, 403);
  }

  let body = {};
  try {
    if (request.headers.get('content-type')?.includes('json')) {
      body = await request.json();
    }
  } catch {
    /* empty */
  }

  if (body.action === 'static') {
    const r = await backupStaticApiSnapshots(env);
    // 旧实现无论成败都返回 200 + 写死"已写入 OSS" —— 失败也报成功，等于把备份当成了安全感。
    if (!r.ok) {
      return jsonResponse(
        request,
        {
          ok: false,
          error: `静态 API 快照写入不完整（成功 ${r.written}/${r.total}）`,
          written: r.written,
          total: r.total,
        },
        500,
      );
    }
    return jsonResponse(request, { ok: true, message: `静态 API 快照已写入 OSS（${r.written}/${r.total}）` });
  }

  const result = await backupAllKv(env);
  if (!result.ok) {
    return jsonResponse(
      request,
      {
        ok: false,
        error: result.error || `KV 备份不完整（成功 ${result.count} 条，失败 ${result.failed} 条）`,
        count: result.count,
        failed: result.failed,
        snapshots: result.snapshots,
      },
      500,
    );
  }
  return jsonResponse(request, {
    ok: true,
    message: `已备份 ${result.count} 条 KV 记录至 OSS`,
    count: result.count,
    snapshots: result.snapshots,
  });
}
