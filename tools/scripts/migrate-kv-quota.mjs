#!/usr/bin/env node
/**
 * 把 Cloudflare KV 的额度记录（`client:<id>`）迁移到境内 Mongo（`client_quota`）。
 *
 * ── 为什么必须迁，不能"重置" ──────────────────────────────────────────────
 * KV 里的 `client:<id>` 只有两项：`timestamps`（24 小时窗口内的提问时间）与
 * `subscription`（**付费会员的到期时间**）。
 * 如果迁移时"没搬"或者搬错，付费用户会**凭空变成免费用户** —— 那不只是体验问题，
 * 是要退钱的。所以本脚本：
 *   · 只读 KV，不删不改；
 *   · 逐条 POST 到 Node 的管理接口（幂等 upsert）；
 *   · 迁移后自动回读校验（条数 + 订阅条数 + 每个 clientId 的 subscription 是否一致）。
 *
 * ── 前置 ──────────────────────────────────────────────────────────────────
 * 1. Node 已部署且含 `/v1/admin/client-quota/:clientId`（2026-10-26 新增）；
 * 2. cf.env 里有 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID；
 * 3. 环境变量 QTVQ_NODE_ADMIN_KEY + QTVQ_NODE_BASE（或传 --admin-key / --base）。
 *
 * 用法：
 *   node tools/scripts/migrate-kv-quota.mjs --dry-run
 *   node tools/scripts/migrate-kv-quota.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DRY = process.argv.includes('--dry-run');

function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#') || !s.includes('=')) continue;
    const i = s.indexOf('=');
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const cf = readEnvFile(path.join(ROOT, 'cf.env'));
const token = cf.CLOUDFLARE_API_TOKEN;
const accountId = cf.CLOUDFLARE_ACCOUNT_ID;
if (!token || !accountId) {
  console.error('✗ cf.env 缺少 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID');
  process.exit(1);
}

// KV namespace 从 wrangler.toml 读，避免脚本里再写死一份
const wrangler = fs.readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8');
const nsMatch = /binding\s*=\s*"QTVQ_KV"[\s\S]{0,200}?id\s*=\s*"([a-f0-9]{32})"/.exec(wrangler);
const ns = nsMatch ? nsMatch[1] : null;
if (!ns) {
  console.error('✗ 无法从 wrangler.toml 解析 QTVQ_KV 的 namespace id');
  process.exit(1);
}

const base = arg('base', process.env.QTVQ_NODE_BASE || 'https://qtvq.cn').replace(/\/+$/, '');
const adminKey = arg('admin-key', process.env.QTVQ_NODE_ADMIN_KEY || '');
if (!DRY && !adminKey) {
  console.error('✗ 需要 --admin-key 或 QTVQ_NODE_ADMIN_KEY（写入 /v1/admin/client-quota 用）');
  process.exit(1);
}

const H = { Authorization: `Bearer ${token}` };
const API = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${ns}`;

async function listKeys() {
  const all = [];
  let cursor = '';
  for (;;) {
    const url = `${API}/keys?prefix=client:&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetch(url, { headers: H });
    const j = await res.json();
    if (!j.success) throw new Error(`列 KV 键失败: ${JSON.stringify(j.errors)}`);
    all.push(...j.result);
    if (!j.result_info?.cursor) break;
    cursor = j.result_info.cursor;
  }
  return all;
}

async function getValue(name) {
  const res = await fetch(`${API}/values/${encodeURIComponent(name)}`, { headers: H });
  if (!res.ok) throw new Error(`取 ${name} 失败 HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function putToNode(clientId, rec) {
  const res = await fetch(`${base}/v1/admin/client-quota/${encodeURIComponent(clientId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
    body: JSON.stringify({ timestamps: rec.timestamps, subscription: rec.subscription }),
  });
  if (!res.ok) throw new Error(`写入 ${clientId} 失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function getFromNode(clientId) {
  const res = await fetch(`${base}/v1/admin/client-quota/${encodeURIComponent(clientId)}`, {
    headers: { 'X-Admin-Key': adminKey },
  });
  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  return j?.data || null;
}

const keys = await listKeys();
console.log(`读取 KV：${keys.length} 个 \`client:\` 键`);
if (!keys.length) {
  console.log('没有需要迁移的记录');
  process.exit(0);
}

const records = [];
for (const { name } of keys) {
  const raw = await getValue(name);
  if (!raw) {
    console.warn(`  跳过（内容无法解析）：${name}`);
    continue;
  }
  records.push({
    clientId: name.slice('client:'.length),
    timestamps: Array.isArray(raw.timestamps) ? raw.timestamps : [],
    subscription: raw.subscription || null,
  });
}

const paid = records.filter((r) => r.subscription).length;
console.log(`可迁移：${records.length} 条（其中有订阅 ${paid} 条 —— 这些必须完整保留）`);

if (DRY) {
  for (const r of records) {
    const sub = r.subscription ? `订阅至 ${new Date(r.subscription.activeUntil).toISOString()}` : '无订阅';
    console.log(`  ${r.clientId.padEnd(28)} timestamps=${String(r.timestamps.length).padStart(2)}  ${sub}`);
  }
  console.log('\n(--dry-run：未写入)');
  process.exit(0);
}

let okCount = 0;
const failed = [];
for (const r of records) {
  try {
    await putToNode(r.clientId, r);
    okCount += 1;
  } catch (err) {
    failed.push(`${r.clientId}: ${err.message}`);
  }
}

console.log(`\n写入完成：成功 ${okCount} / ${records.length}`);
if (failed.length) {
  console.error('失败明细：');
  for (const f of failed) console.error('  ' + f);
  process.exit(1);
}

// ── 回读校验：条数、订阅数、逐条 subscription 到期时间 ──
let mismatch = 0;
for (const r of records) {
  const got = await getFromNode(r.clientId);
  if (!got) {
    console.error(`  ✗ 回读不到 ${r.clientId}`);
    mismatch += 1;
    continue;
  }
  const a = r.subscription?.activeUntil || null;
  const b = got.subscription?.activeUntil || null;
  if (a !== b) {
    console.error(`  ✗ ${r.clientId} 订阅不一致：KV=${a} Mongo=${b}`);
    mismatch += 1;
  }
}
if (mismatch) {
  console.error(`\n✗ 校验失败：${mismatch} 条不一致。**不要**删 KV 记录，先排查。`);
  process.exit(1);
}
console.log(`✅ 校验通过：${records.length} 条全部一致（含 ${paid} 条订阅）`);
console.log('   KV 记录**未删除**，保留作为回滚依据（可后续人工清理）。');
