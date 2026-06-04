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

  await ossPutJson(env, 'api/payment.json', { company: COMPANY, source: 'oss-backup' });
  await ossPutJson(env, 'api/health.json', {
    project: 'qtvq-api',
    source: 'oss-backup',
    aiBound: false,
    kvBound: true,
    hint: 'Cloudflare 不可用时的备份健康检查',
  });
  await ossPutJson(env, 'api/quota-default.json', {
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
  });

  return ossUpdateManifest(env, { staticApiBackedUpAt: new Date().toISOString() });
}

export async function backupAllKv(env) {
  const kv = env?.QTVQ_KV;
  if (!kv) return { ok: false, error: 'KV not bound' };

  let cursor;
  let count = 0;

  do {
    const page = await kv.list({ prefix: 'client:', cursor, limit: 100 });
    for (const { name } of page.keys) {
      const raw = await kv.get(name);
      if (!raw) continue;
      const clientId = name.slice('client:'.length);
      try {
        await ossPutJson(env, `kv/clients/${clientId}.json`, {
          clientId,
          backedUpAt: new Date().toISOString(),
          record: JSON.parse(raw),
        });
        count += 1;
      } catch {
        /* skip */
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
        await ossPutJson(env, `kv/contacts/${record.id || name}.json`, record);
        count += 1;
      } catch {
        /* skip */
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  await backupStaticApiSnapshots(env);
  await ossUpdateManifest(env, { fullBackupAt: new Date().toISOString(), kvObjectCount: count });
  return { ok: true, count };
}
