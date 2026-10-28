#!/usr/bin/env node
/**
 * 留言数据出境整改：Cloudflare KV → 境内 MongoDB
 *
 * 背景（P0-1）
 * ------------
 * `functions/api/contact.js` 过去把留言记录写进 `env.QTVQ_KV`（`contact:<id>` 与
 * `contact:index:<id>`）。KV 由 Cloudflare 全球网络承载，而留言里的 `replyEmail`
 * 与自由文本 `message` 属于《个人信息保护法》定义的个人信息，存于境外节点即构成数据出境。
 *
 * 该函数现已改为只写境内 Node 服务（MongoDB `contact_messages`），本脚本负责
 * **把历史存量迁走，并在校验通过后删除 KV 中的键**。
 *
 * 安全设计
 * --------
 *   1. 默认 dry-run，只报告不删除；必须显式加 `--apply` 才会删除 KV 键。
 *   2. 删除前先回读 MongoDB，逐条确认 id 已存在；任一条缺失即整批不删。
 *   3. 图片只迁元数据（name/type/bytes）——base64 正文已在境内 OSS 备份，
 *      放进 Mongo 会撑大文档并撞上服务端 1mb 请求体上限。
 *   4. 幂等：服务端按 id upsert，脚本可反复重跑。
 *
 * 用法
 * ----
 *   node tools/scripts/migrate-contact-kv-to-mongo.mjs            # 预演
 *   node tools/scripts/migrate-contact-kv-to-mongo.mjs --apply    # 真正迁移并清理 KV
 *
 * 依赖
 * ----
 *   cf.env        → CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID（已有）
 *   server/.env   → ADMIN_KEY（服务端 X-Admin-Key）
 *   环境变量       → NODE_API_BASE（默认 https://qtvq.cn）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

const APPLY = process.argv.includes('--apply');
const BASE = (process.env.NODE_API_BASE || 'https://qtvq.cn').replace(/\/+$/, '');
const KV_NS = process.env.QTVQ_KV_NAMESPACE_ID || '4ec5d9cc8b3e4210bd29112073a6c502';

function readEnvFile(rel) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) throw new Error(`缺少 ${rel}`);
  const map = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    map[m[1]] = v;
  }
  return map;
}

const cf = readEnvFile('cf.env');
const srv = readEnvFile('server/.env');
const CF_TOKEN = cf.CLOUDFLARE_API_TOKEN;
const CF_ACC = cf.CLOUDFLARE_ACCOUNT_ID;
const ADMIN_KEY = srv.ADMIN_KEY;

for (const [k, v] of Object.entries({ CF_TOKEN, CF_ACC, ADMIN_KEY })) {
  if (!v) throw new Error(`缺少凭据：${k}`);
}

/* curl 在本机需 --ssl-no-revoke（企业网络吊销检查常不可达），Node fetch 无此问题 */
const kvApi = (suffix) =>
  `https://api.cloudflare.com/client/v4/accounts/${CF_ACC}/storage/kv/namespaces/${KV_NS}${suffix}`;

async function kvList(prefix) {
  const out = [];
  let cursor = '';
  for (;;) {
    const u = new URL(kvApi('/keys'));
    u.searchParams.set('prefix', prefix);
    u.searchParams.set('limit', '1000');
    if (cursor) u.searchParams.set('cursor', cursor);
    const r = await fetch(u, { headers: { Authorization: `Bearer ${CF_TOKEN}` } });
    const j = await r.json();
    if (!j.success) throw new Error(`KV keys 失败: ${JSON.stringify(j.errors)}`);
    out.push(...j.result);
    cursor = j.result_info?.cursor || '';
    if (!cursor) break;
  }
  return out;
}

async function kvGet(key) {
  const r = await fetch(kvApi(`/values/${encodeURIComponent(key)}`), {
    headers: { Authorization: `Bearer ${CF_TOKEN}` },
  });
  if (!r.ok) return { ok: false, status: r.status, text: '' };
  return { ok: true, text: await r.text() };
}

async function kvDelete(key) {
  /*
   * Cloudflare KV 的删除路径是 `/values/{key}`（与读取同路径，换方法即可）。
   * 首版误写成 `/namespaces/{ns}/{key}`，接口返回非 2xx、删除静默失败 ——
   * 表现为「迁移成功但 KV 里还剩 6 个键」，所以这里返回真实结果供上层统计。
   */
  const r = await fetch(kvApi(`/values/${encodeURIComponent(key)}`), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${CF_TOKEN}` },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    console.log(`    ! 删除 ${key} 失败 HTTP ${r.status} ${body.slice(0, 120)}`);
  }
  return r.ok;
}

async function postContact(record) {
  const r = await fetch(`${BASE}/v1/admin/contact`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Key': ADMIN_KEY,
      'User-Agent': 'qtvq-migrate-contact/1.0 (+https://qtvq.cn)',
    },
    body: JSON.stringify(record),
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, body: text.slice(0, 200) };
}

async function listStoredIds(limit = 100) {
  const r = await fetch(`${BASE}/v1/admin/contact?limit=${limit}`, {
    headers: { 'X-Admin-Key': ADMIN_KEY, 'User-Agent': 'qtvq-migrate-contact/1.0' },
  });
  if (!r.ok) throw new Error(`回读失败 HTTP ${r.status}`);
  const j = await r.json();
  return new Set((j?.data?.items || []).map((x) => x.id));
}

function metaOnly(images) {
  if (!Array.isArray(images)) return [];
  return images.slice(0, 4).map((i) => {
    const data = String(i?.data || '');
    const b64 = data.includes(',') ? data.split(',')[1] : '';
    return {
      name: String(i?.name || '').slice(0, 80),
      type: String(i?.type || '').slice(0, 40),
      bytes: Number(i?.bytes) || (b64 ? Math.ceil((b64.length * 3) / 4) : null),
    };
  });
}

const main = async () => {
  console.log(`模式: ${APPLY ? 'APPLY（会删除 KV 键）' : 'DRY-RUN（只报告）'}`);
  console.log(`目标: ${BASE}/v1/admin/contact`);

  const keys = await kvList('contact:');
  const dataKeys = keys.filter((k) => /^contact:\d/.test(k.name));
  const indexKeys = keys.filter((k) => k.name.startsWith('contact:index:'));

  console.log(`KV 命中: 数据键 ${dataKeys.length} 个, 索引键 ${indexKeys.length} 个`);

  const migrated = [];
  const failed = [];

  for (const { name } of dataKeys) {
    const got = await kvGet(name);
    if (!got.ok) {
      failed.push({ key: name, why: `读取失败 HTTP ${got.status}` });
      continue;
    }
    let rec;
    try {
      rec = JSON.parse(got.text);
    } catch {
      failed.push({ key: name, why: '值不是 JSON' });
      continue;
    }
    const payload = {
      ...rec,
      images: metaOnly(rec.images),
      source: 'kv-migrated',
    };
    const res = await postContact(payload);
    if (res.ok) {
      migrated.push(payload.id);
      console.log(`  ✓ ${name} → mongo id=${payload.id}`);
    } else {
      failed.push({ key: name, why: `HTTP ${res.status} ${res.body}` });
      console.log(`  ✗ ${name} HTTP ${res.status}`);
    }
  }

  if (failed.length) {
    console.log('\n有失败项，**不删除任何 KV 键**：');
    failed.forEach((f) => console.log(`  - ${f.key}: ${f.why}`));
    process.exitCode = 1;
    return;
  }

  // 回读校验：逐条确认已在 MongoDB
  const stored = await listStoredIds(200);
  const missing = migrated.filter((id) => !stored.has(id));
  if (missing.length) {
    console.log(`\n回读校验失败，缺 ${missing.length} 条，**不删除任何 KV 键**：${missing.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n回读校验通过：${migrated.length} 条均已存在于境内 MongoDB`);

  if (!APPLY) {
    console.log('\nDRY-RUN 结束。确认无误后执行：node tools/scripts/migrate-contact-kv-to-mongo.mjs --apply');
    return;
  }

  let delData = 0;
  let delIndex = 0;
  for (const { name } of dataKeys) if (await kvDelete(name)) delData += 1;
  for (const { name } of indexKeys) if (await kvDelete(name)) delIndex += 1;

  console.log(`\n已删除 KV：数据键 ${delData}/${dataKeys.length}，索引键 ${delIndex}/${indexKeys.length}`);

  const left = await kvList('contact:');
  console.log(`KV 中剩余 contact:* 键：${left.length} 个${left.length ? '（需人工检查）' : ' ✓ 已清空'}`);
  if (left.length) process.exitCode = 1;
};

main().catch((e) => {
  console.error('迁移失败:', e.message);
  process.exitCode = 1;
});
