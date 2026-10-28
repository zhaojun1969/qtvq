#!/usr/bin/env node
/**
 * 客户端付款明细境内化：`client:<id>` → 境内 Mongo `client_billing`（G1 最后一块）
 *
 * 背景
 * ----
 * KV 的 `client:<id>` 值里同时装着两类东西：
 *   · `timestamps` / `subscription` —— 判额度用，**每次提问都要读**（热路径）；
 *   · `paymentPending` / `topupPending` / `paymentHistory` —— 付款人**真实姓名与手机号**。
 *
 * 代码侧已改为「KV 只留前两项 + 境内存明细」，本脚本处理历史存量：
 *   ① 把明细投递境内并回读确认；
 *   ② 把 KV 值覆盖为只含 timestamps/subscription 的副本。
 *
 * 安全设计
 * ----
 *   1. 默认 dry-run；
 *   2. 先投递、回读确认，**再**覆盖 KV；任一条失败则整批不动 KV；
 *   3. 幂等（境内按 clientId upsert）。
 *
 * 用法
 * ----
 *   node tools/scripts/migrate-client-billing.mjs            # 预演
 *   node tools/scripts/migrate-client-billing.mjs --apply    # 真正迁移
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeRecordForKv } from '../../functions/lib/quota-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const APPLY = process.argv.includes('--apply');
const KV_NS = process.env.QTVQ_KV_NAMESPACE_ID || '4ec5d9cc8b3e4210bd29112073a6c502';
const BASE = (process.env.NODE_API_BASE || 'https://qtvq.cn').replace(/\/+$/, '');
const KV_PREFIX = 'client:';

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

const api = (s) => `https://api.cloudflare.com/client/v4/accounts/${CF_ACC}/storage/kv/namespaces/${KV_NS}${s}`;
const AUTH = { Authorization: `Bearer ${CF_TOKEN}` };
const NODE_H = {
  'Content-Type': 'application/json',
  'X-Admin-Key': ADMIN_KEY,
  'User-Agent': 'qtvq-migrate-billing/1.0 (+https://qtvq.cn)',
};

async function kvList(prefix) {
  const out = [];
  let cursor = '';
  for (;;) {
    const u = new URL(api('/keys'));
    u.searchParams.set('prefix', prefix);
    u.searchParams.set('limit', '1000');
    if (cursor) u.searchParams.set('cursor', cursor);
    const j = await (await fetch(u, { headers: AUTH })).json();
    if (!j.success) throw new Error(`KV keys 失败: ${JSON.stringify(j.errors)}`);
    out.push(...j.result);
    cursor = j.result_info?.cursor || '';
    if (!cursor) break;
  }
  return out;
}

const kvGet = async (key) => {
  const r = await fetch(api(`/values/${encodeURIComponent(key)}`), { headers: AUTH });
  return r.ok ? r.text() : null;
};

const kvPut = async (key, value) => {
  const r = await fetch(api(`/values/${encodeURIComponent(key)}`), {
    method: 'PUT',
    headers: { ...AUTH, 'Content-Type': 'text/plain' },
    body: value,
  });
  return r.ok;
};

const HAS_BILLING = (rec) =>
  Boolean(
    (rec.paymentPending && Object.keys(rec.paymentPending).length) ||
      (rec.topupPending && Object.keys(rec.topupPending).length) ||
      (Array.isArray(rec.paymentHistory) && rec.paymentHistory.length),
  );

async function postBilling(clientId, rec) {
  const r = await fetch(`${BASE}/v1/admin/client-billing`, {
    method: 'POST',
    headers: NODE_H,
    body: JSON.stringify({
      clientId,
      paymentPending: rec.paymentPending || null,
      topupPending: rec.topupPending || null,
      paymentHistory: Array.isArray(rec.paymentHistory) ? rec.paymentHistory.slice(0, 20) : [],
    }),
  });
  return { ok: r.ok, status: r.status };
}

async function getBilling(clientId) {
  const r = await fetch(`${BASE}/v1/admin/client-billing/${encodeURIComponent(clientId)}`, {
    headers: { 'X-Admin-Key': ADMIN_KEY, 'User-Agent': NODE_H['User-Agent'] },
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j?.data || null;
}

const main = async () => {
  console.log(`模式: ${APPLY ? 'APPLY（投递境内并覆盖 KV）' : 'DRY-RUN（只报告）'}`);
  const keys = await kvList(KV_PREFIX);
  console.log(`KV 命中 ${KV_PREFIX}* 键：${keys.length} 个`);

  const prepared = [];
  const failed = [];
  for (const { name } of keys) {
    const raw = await kvGet(name);
    if (raw == null) {
      failed.push({ key: name, why: '读取失败' });
      continue;
    }
    let rec;
    try {
      rec = JSON.parse(raw);
    } catch {
      failed.push({ key: name, why: '值不是 JSON' });
      continue;
    }
    prepared.push({
      key: name,
      clientId: name.slice(KV_PREFIX.length),
      rec,
      sanitized: JSON.stringify(sanitizeRecordForKv(rec)),
      hasBilling: HAS_BILLING(rec),
    });
  }

  const withBilling = prepared.filter((p) => p.hasBilling);
  console.log(`含付款明细（姓名/手机）的记录：${withBilling.length} 个`);
  for (const p of withBilling.slice(0, 12)) {
    const bits = [];
    if (p.rec.paymentPending) bits.push('paymentPending');
    if (p.rec.topupPending) bits.push('topupPending');
    if (p.rec.paymentHistory?.length) bits.push(`history×${p.rec.paymentHistory.length}`);
    console.log(`  ${p.clientId} → 迁出 [${bits.join(', ')}]`);
  }

  if (!APPLY) {
    console.log('\nDRY-RUN 结束（未写入）。执行：node tools/scripts/migrate-client-billing.mjs --apply');
    if (failed.length) {
      failed.forEach((f) => console.log(`  ! ${f.key}: ${f.why}`));
      process.exitCode = 1;
    }
    return;
  }

  // ① 投递 + 回读确认（含明细的才需要确认内容）
  for (const p of prepared) {
    if (!p.hasBilling) continue;
    const res = await postBilling(p.clientId, p.rec);
    if (!res.ok) {
      failed.push({ key: p.key, why: `投递失败 HTTP ${res.status}` });
      continue;
    }
    const back = await getBilling(p.clientId);
    if (!back) {
      failed.push({ key: p.key, why: '回读境内记录失败' });
      continue;
    }
    if (p.rec.paymentPending && !back.paymentPending) failed.push({ key: p.key, why: 'paymentPending 未落库' });
    if (p.rec.topupPending && !back.topupPending) failed.push({ key: p.key, why: 'topupPending 未落库' });
    if (p.rec.paymentHistory?.length && !(back.paymentHistory || []).length) {
      failed.push({ key: p.key, why: 'paymentHistory 未落库' });
    }
  }

  if (failed.length) {
    console.log('\n有失败项，**不覆盖任何 KV**：');
    failed.forEach((f) => console.log(`  - ${f.key}: ${f.why}`));
    process.exitCode = 1;
    return;
  }

  // ② 覆盖 KV 为脱敏副本
  let done = 0;
  for (const p of prepared) {
    if (await kvPut(p.key, p.sanitized)) done += 1;
  }
  console.log(`KV 已覆盖为脱敏副本：${done}/${prepared.length}`);

  // ③ 抽查
  let dirty = 0;
  for (const p of prepared) {
    const raw = await kvGet(p.key);
    if (raw == null) continue;
    if (/"paymentPending"|"topupPending"|"paymentHistory"|"payerName"|"phone"/.test(raw)) {
      dirty += 1;
      console.log(`  ⚠ 仍含付款明细：${p.key}`);
    }
  }
  console.log(dirty === 0 ? '\n✅ 抽查通过：KV 客户端记录已无付款明细' : `\n❌ ${dirty} 个键仍含明细`);
  if (dirty) process.exitCode = 1;
};

main().catch((e) => {
  console.error('迁移失败:', e.message);
  process.exitCode = 1;
});
