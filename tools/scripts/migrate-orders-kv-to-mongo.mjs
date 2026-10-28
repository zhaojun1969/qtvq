#!/usr/bin/env node
/**
 * 订单数据出境整改：Cloudflare KV → 境内 MongoDB（G1）
 *
 * 背景
 * ----
 * `functions/lib/order-store.js` 把订单写进 `env.QTVQ_KV`（`order:<orderId>`），
 * 而订单里有 `openid`、`trace.phone`、`trace.ip`、`trace.userAgent` —— 属于
 * 《个人信息保护法》定义的可识别个人信息。KV 由 Cloudflare 全球网络承载，存于其上即数据出境。
 *
 * 代码侧已完成：新写入的 KV 副本只保留**剥离 PII 的投影**，完整记录同步到境内 Mongo
 * （方案见 docs/订单数据境内化双写方案.md）。本脚本负责**历史存量**：
 *   ① 把完整记录搬到境内 Mongo；
 *   ② 把 KV 里的每条订单**覆盖为投影**（去掉 PII）；
 *   ③ 抽查确认 KV 中再无 PII。
 *
 * 为什么是"覆盖"而不是"删除"：支付链路仍从 KV 读订单（读路径零改动，风险最小）。
 * 删除会让历史订单查不到、对账断档。覆盖为投影既保住可读性，又消除出境风险。
 *
 * 安全设计
 * --------
 *   1. 默认 dry-run，只报告不写；必须显式 `--apply`。
 *   2. 先写 Mongo 并**回读校验**，全部齐了才动 KV；任一条缺失则整批不写 KV。
 *   3. 覆盖前把原始值留一份到 `dist/migration-backup/orders/`（本地），便于万一回滚。
 *   4. 幂等：服务端按 orderId upsert，脚本可反复重跑。
 *
 * 用法
 * ----
 *   node tools/scripts/migrate-orders-kv-to-mongo.mjs            # 预演
 *   node tools/scripts/migrate-orders-kv-to-mongo.mjs --apply    # 真正迁移
 *
 * 依赖
 * ----
 *   cf.env        → CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
 *   server/.env   → ADMIN_KEY
 *   环境变量       → NODE_API_BASE（默认 https://qtvq.cn）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectForKv } from '../../functions/lib/order-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

const APPLY = process.argv.includes('--apply');
const BASE = (process.env.NODE_API_BASE || 'https://qtvq.cn').replace(/\/+$/, '');
const KV_NS = process.env.QTVQ_KV_NAMESPACE_ID || '4ec5d9cc8b3e4210bd29112073a6c502';
const BACKUP_DIR = path.join(ROOT, 'dist', 'migration-backup', 'orders');

/** KV 里任何键都不该再出现的 PII 迹象（抽查用） */
const PII_MARKERS = ['"openid"', '"ip"', '"userAgent"'];

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

async function kvPut(key, value) {
  const r = await fetch(kvApi(`/values/${encodeURIComponent(key)}`), {
    method: 'PUT',
    headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'text/plain' },
    body: value,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    console.log(`    ! 写入 ${key} 失败 HTTP ${r.status} ${body.slice(0, 120)}`);
  }
  return r.ok;
}

async function postOrder(order) {
  const r = await fetch(`${BASE}/v1/admin/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Key': ADMIN_KEY,
      'User-Agent': 'qtvq-migrate-orders/1.0 (+https://qtvq.cn)',
    },
    body: JSON.stringify(order),
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, body: text.slice(0, 200) };
}

async function listStoredOrderIds() {
  const ids = new Set();
  let offsetLimit = 200;
  for (let i = 0; i < 20; i += 1) {
    const r = await fetch(`${BASE}/v1/admin/orders?limit=${offsetLimit}`, {
      headers: { 'X-Admin-Key': ADMIN_KEY, 'User-Agent': 'qtvq-migrate-orders/1.0' },
    });
    if (!r.ok) throw new Error(`回读失败 HTTP ${r.status}`);
    const j = await r.json();
    for (const it of j?.data?.items || []) ids.add(it.orderId);
    break; // 单页足够：历史订单 < 200
  }
  return ids;
}

const main = async () => {
  console.log(`模式: ${APPLY ? 'APPLY（会覆盖 KV 订单为投影）' : 'DRY-RUN（只报告）'}`);
  console.log(`目标: ${BASE}/v1/admin/orders`);

  const keys = await kvList('order:');
  console.log(`KV 命中的 order:* 键：${keys.length} 个`);
  if (!keys.length) {
    console.log('没有需要迁移的订单。');
    return;
  }

  const migrated = [];
  const failed = [];
  const backup = [];

  /*
   * 预演必须**完全不写**：早期版本把「投递 Mongo」放在开关之外，于是 DRY-RUN 也会
   * 往 Mongo 写 124 条 —— 数据本身去向正确、也确实幂等，但"预演却产生了副作用"
   * 会让操作者再也不敢信这个模式。现在写入动作一律在 APPLY 之下。
   */
  if (!APPLY) {
    let parsed = 0;
    let bad = 0;
    let sample = null;
    for (const { name } of keys) {
      const got = await kvGet(name);
      if (!got.ok) {
        failed.push({ key: name, why: `读取失败 HTTP ${got.status}` });
        continue;
      }
      try {
        const o = JSON.parse(got.text);
        parsed += 1;
        if (!sample) sample = o;
      } catch {
        bad += 1;
        failed.push({ key: name, why: '值不是 JSON' });
      }
    }
    console.log(`可解析订单：${parsed} 条；坏数据：${bad} 条`);
    if (failed.length) failed.forEach((f) => console.log(`  - ${f.key}: ${f.why}`));
    if (sample) {
      console.log('\n投影样例（apply 后 KV 中将是这个形状）：');
      console.log('  ' + JSON.stringify(projectForKv(sample)).slice(0, 220) + '…');
    }
    console.log('\nDRY-RUN 结束（未写入任何存储）。执行：node tools/scripts/migrate-orders-kv-to-mongo.mjs --apply');
    if (bad) process.exitCode = 1;
    return;
  }

  for (const { name } of keys) {
    const got = await kvGet(name);
    if (!got.ok) {
      failed.push({ key: name, why: `读取失败 HTTP ${got.status}` });
      continue;
    }
    let order;
    try {
      order = JSON.parse(got.text);
    } catch {
      failed.push({ key: name, why: '值不是 JSON' });
      continue;
    }
    backup.push({ key: name, raw: got.text });

    const res = await postOrder(order);
    if (res.ok) {
      migrated.push(order.orderId);
    } else {
      failed.push({ key: name, why: `HTTP ${res.status} ${res.body}` });
    }
  }

  if (failed.length) {
    console.log('\n有失败项，**不覆盖任何 KV 键**：');
    failed.forEach((f) => console.log(`  - ${f.key}: ${f.why}`));
    process.exitCode = 1;
    return;
  }
  console.log(`已投递境内 Mongo：${migrated.length} 条`);

  // 回读校验
  const stored = await listStoredOrderIds();
  const missing = migrated.filter((id) => !stored.has(id));
  if (missing.length) {
    console.log(`\n回读校验失败，缺 ${missing.length} 条，**不覆盖任何 KV 键**：${missing.slice(0, 5).join(', ')}…`);
    process.exitCode = 1;
    return;
  }
  console.log(`回读校验通过：${migrated.length} 条均已存在于境内 MongoDB`);

  if (!APPLY) {
    const sample = backup[0] ? projectForKv(JSON.parse(backup[0].raw)) : null;
    if (sample) {
      console.log('\n投影样例（覆盖后 KV 中将是这个形状）：');
      console.log('  ' + JSON.stringify(sample).slice(0, 220) + '…');
    }
    console.log('\nDRY-RUN 结束。确认无误后执行：node tools/scripts/migrate-orders-kv-to-mongo.mjs --apply');
    return;
  }

  // 本地留底（万一需要回滚：原始值含 PII，仅存本机 dist/，不要提交）
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(BACKUP_DIR, `orders-kv-${stamp}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2), 'utf8');
  console.log(`\n原始值已留底：${path.relative(ROOT, backupFile)}（含 PII，勿提交）`);

  let okCount = 0;
  for (const { key, raw } of backup) {
    const projected = JSON.stringify(projectForKv(JSON.parse(raw)));
    if (await kvPut(key, projected)) okCount += 1;
  }
  console.log(`KV 已覆盖为投影：${okCount}/${backup.length}`);

  // 抽查：KV 里不应再有 PII 迹象
  let dirty = 0;
  for (const { name } of keys) {
    const got = await kvGet(name);
    if (!got.ok) continue;
    if (PII_MARKERS.some((m) => got.text.includes(m))) {
      dirty += 1;
      console.log(`  ⚠ 仍含 PII：${name}`);
    }
  }
  console.log(dirty === 0 ? '\n✅ 抽查通过：KV 中订单不再含 openid / ip / userAgent' : `\n❌ ${dirty} 个键仍含 PII`);
  if (dirty) process.exitCode = 1;
};

main().catch((e) => {
  console.error('迁移失败:', e.message);
  process.exitCode = 1;
});
