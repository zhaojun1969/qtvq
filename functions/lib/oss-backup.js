/**
 * 阿里云 OSS 备份（PutObject，Workers 异步写入）
 * 环境变量：OSS_ACCESS_KEY_ID, OSS_SECRET_ACCESS_KEY, OSS_ENDPOINT, OSS_BUCKET, OSS_BACKUP_PREFIX
 */

function ossConfig(env) {
  const ak = env.OSS_ACCESS_KEY_ID;
  const sk = env.OSS_SECRET_ACCESS_KEY;
  const bucket = env.OSS_BUCKET;
  const endpoint = (env.OSS_ENDPOINT || 'oss-cn-beijing.aliyuncs.com').replace(/^https?:\/\//, '');
  const prefix = (env.OSS_BACKUP_PREFIX || 'qtvq/backup/').replace(/^\//, '').replace(/\/?$/, '/');
  if (!ak || !sk || !bucket) return null;
  return { ak, sk, bucket, endpoint, prefix };
}

async function hmacSha1Base64(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  const bytes = new Uint8Array(sig);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** @returns {Promise<boolean>} */
export async function ossPutJson(env, relativeKey, data) {
  const cfg = ossConfig(env);
  if (!cfg) return false;

  const objectKey = cfg.prefix + relativeKey.replace(/^\//, '');
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  const contentType = 'application/json; charset=utf-8';
  const date = new Date().toUTCString();
  const canonicalizedResource = `/${cfg.bucket}/${objectKey}`;
  const stringToSign = `PUT\n\n${contentType}\n${date}\n${canonicalizedResource}`;
  const signature = await hmacSha1Base64(cfg.sk, stringToSign);
  const url = `https://${cfg.bucket}.${cfg.endpoint}/${objectKey}`;

  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        Date: date,
        Authorization: `OSS ${cfg.ak}:${signature}`,
      },
      body,
    });
    return res.ok;
  } catch (err) {
    console.error('OSS backup failed:', relativeKey, err);
    return false;
  }
}

export async function ossUpdateManifest(env, patch = {}) {
  const cfg = ossConfig(env);
  if (!cfg) return false;

  const manifest = {
    service: 'qtvq-api',
    updatedAt: new Date().toISOString(),
    backupPrefix: cfg.prefix,
    endpoints: {
      payment: 'api/payment.json',
      health: 'api/health.json',
      quotaDefault: 'api/quota-default.json',
      clientQuota: 'kv/clients/{clientId}.json',
    },
    ...patch,
  };
  return ossPutJson(env, 'manifest.json', manifest);
}

export async function backupClientRecord(env, clientId, rec) {
  if (!clientId) return false;
  const payload = {
    clientId,
    backedUpAt: new Date().toISOString(),
    record: rec,
  };
  const ok = await ossPutJson(env, `kv/clients/${clientId}.json`, payload);
  await ossUpdateManifest(env, { lastClientBackup: clientId, lastClientBackupAt: payload.backedUpAt });
  return ok;
}

export async function backupContactRecord(env, record) {
  if (!record?.id) return false;
  const ok = await ossPutJson(env, `kv/contacts/${record.id}.json`, record);
  await ossUpdateManifest(env, { lastContactId: record.id });
  return ok;
}

export async function backupStaticApiSnapshots(env) {
  const { PLANS, DAILY_ASK_LIMIT } = await import('./quota-store.js');

  const COMPANY = {
    name: '我心永恒（北京）网络科技有限公司',
    account: '0200251109200028909',
    cardNo: '9558830200002033769',
    bank: '中国工商银行北京海淀西区马连洼支行',
  };

  const results = await Promise.all([
    ossPutJson(env, 'api/payment.json', { company: COMPANY, source: 'oss-backup' }),
    ossPutJson(env, 'api/health.json', {
      project: 'qtvq-api',
      source: 'oss-backup',
      aiBound: false,
      kvBound: true,
      hint: 'Cloudflare 不可用时的备份健康检查',
    }),
    ossPutJson(env, 'api/quota-default.json', {
      unlimited: false,
      used: 0,
      remaining: DAILY_ASK_LIMIT,
      limit: DAILY_ASK_LIMIT,
      resetAt: null,
      subscription: null,
      paymentPending: null,
      plans: PLANS,
      storage: 'oss-backup',
      source: 'oss-backup',
    }),
  ]);

  const written = results.filter(Boolean).length;
  // 只有 3 个快照全部写成功才更新 manifest。
  // 旧实现无条件返回 ossUpdateManifest 的结果：三个快照全失败、只要 manifest 写成功，
  // 调用方仍会得到 ok:true —— 典型的"失败也报成功"。
  const manifestOk = written === results.length ? await ossUpdateManifest(env, { staticApiBackedUpAt: new Date().toISOString() }) : false;
  return { ok: written === results.length && manifestOk, written, total: results.length };
}

export async function backupAllKv(env) {
  const kv = env?.QTVQ_KV;
  if (!kv) return { ok: false, error: 'KV not bound' };

  // OSS 没配就没得备份 —— 旧实现会继续跑完整个 KV 遍历、把每条都算进 count，
  // 最后返回 ok:true 与一个漂亮的数字，而 OSS 上什么都没有。这里提前失败。
  if (!ossConfig(env)) return { ok: false, error: 'OSS 未配置（OSS_ACCESS_KEY_ID / OSS_SECRET_ACCESS_KEY / OSS_BUCKET）' };

  let cursor;
  let count = 0;
  let failed = 0;

  do {
    const page = await kv.list({ prefix: 'client:', cursor, limit: 100 });
    for (const { name } of page.keys) {
      const raw = await kv.get(name);
      if (!raw) continue;
      const clientId = name.slice('client:'.length);
      try {
        const written = await ossPutJson(env, `kv/clients/${clientId}.json`, {
          clientId,
          backedUpAt: new Date().toISOString(),
          record: JSON.parse(raw),
        });
        // 只有真的写进 OSS 才算数（旧实现无条件 count += 1，把失败也统计成成功）
        if (written) count += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  cursor = undefined;
  do {
    const page = await kv.list({ prefix: 'contact:', cursor, limit: 100 });
    for (const { name } of page.keys) {
      if (name.startsWith('contact:index:')) continue;
      const raw = await kv.get(name);
      if (!raw) continue;
      try {
        const record = JSON.parse(raw);
        const written = await ossPutJson(env, `kv/contacts/${record.id || name}.json`, record);
        if (written) count += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const snapshots = await backupStaticApiSnapshots(env);
  const ok = count > 0 && failed === 0 && snapshots.ok;
  await ossUpdateManifest(env, {
    fullBackupAt: new Date().toISOString(),
    kvObjectCount: count,
    kvObjectFailed: failed,
    snapshotWritten: snapshots.written,
  });
  return { ok, count, failed, snapshots };
}
