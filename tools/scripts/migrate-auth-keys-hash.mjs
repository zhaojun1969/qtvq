#!/usr/bin/env node
/**
 * auth 索引键去明文：`auth:phone:138…` → `auth:p:<sha256>`
 *
 * 背景（G1，2026-10-26）
 * ---------------------
 * KV 的**键名本身就是数据**。改之前一次 `kv key list` 就能拿到：
 *   · `auth:phone:13800001234`  —— 明文手机号
 *   · `auth:openid:oXXXX`       —— 微信用户标识
 *   · `auth:union:uXXXX`        —— 微信 unionid
 *   · `auth:client:q_XXXX`      —— 设备编号（准标识符）
 *   · `auth:session:<64位token>` —— **可直接使用的登录令牌**（最严重：等同账号冒用凭据）
 *
 * 代码侧已改为只写哈希键，并保留「惰性迁移」：老键第一次被访问时会自动搬到哈希键再删除。
 * 本脚本负责**主动清扫**——让那些再也不会被访问的键（长期不登录的用户、过期会话）
 * 也尽快从明文形态消失，而不是躺在 KV 里等到 TTL。
 *
 * 安全设计
 * --------
 *   1. 默认 dry-run，只报告；
 *   2. `--apply` 时先写哈希键、回读确认值一致，**才**删除明文键；任一步失败就保留原键；
 *   3. 幂等：哈希键已存在则跳过写入，只清理明文键。
 *
 * 用法
 * ----
 *   node tools/scripts/migrate-auth-keys-hash.mjs            # 预演
 *   node tools/scripts/migrate-auth-keys-hash.mjs --apply    # 真正迁移
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { phoneKey, openidKey, unionKey, clientKey, sessionKey } from '../../functions/lib/auth-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const APPLY = process.argv.includes('--apply');
const KV_NS = process.env.QTVQ_KV_NAMESPACE_ID || '4ec5d9cc8b3e4210bd29112073a6c502';

const LEGACY = [
  { prefix: 'auth:phone:', build: phoneKey, name: '手机号' },
  { prefix: 'auth:openid:', build: openidKey, name: 'openid' },
  { prefix: 'auth:union:', build: unionKey, name: 'unionid' },
  { prefix: 'auth:client:', build: clientKey, name: '设备号' },
  { prefix: 'auth:session:', build: sessionKey, name: '会话令牌' },
];

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
const CF_TOKEN = cf.CLOUDFLARE_API_TOKEN;
const CF_ACC = cf.CLOUDFLARE_ACCOUNT_ID;
if (!CF_TOKEN || !CF_ACC) throw new Error('缺少 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID');

const api = (suffix) =>
  `https://api.cloudflare.com/client/v4/accounts/${CF_ACC}/storage/kv/namespaces/${KV_NS}${suffix}`;
const AUTH = { Authorization: `Bearer ${CF_TOKEN}` };

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

async function kvGet(key) {
  const r = await fetch(api(`/values/${encodeURIComponent(key)}`), { headers: AUTH });
  if (!r.ok) return null;
  return r.text();
}

async function kvPut(key, value, ttlSeconds) {
  const u = new URL(api(`/values/${encodeURIComponent(key)}`));
  if (ttlSeconds) u.searchParams.set('expiration_ttl', String(ttlSeconds));
  const r = await fetch(u, {
    method: 'PUT',
    headers: { ...AUTH, 'Content-Type': 'text/plain' },
    body: value,
  });
  return r.ok;
}

async function kvDelete(key) {
  const r = await fetch(api(`/values/${encodeURIComponent(key)}`), { method: 'DELETE', headers: AUTH });
  return r.ok;
}

const SESSION_TTL = 30 * 24 * 3600;

const main = async () => {
  console.log(`模式: ${APPLY ? 'APPLY（写哈希键并删除明文键）' : 'DRY-RUN（只报告）'}`);

  let totalPlanned = 0;
  let totalDone = 0;
  let totalFailed = 0;

  for (const { prefix, build, name } of LEGACY) {
    const keys = await kvList(prefix);
    console.log(`\n${name}（${prefix}*）：${keys.length} 个明文键`);
    if (!keys.length) continue;

    for (const { name: key } of keys) {
      const raw = key.slice(prefix.length);
      const hashed = await build(raw);
      totalPlanned += 1;

      if (!APPLY) {
        console.log(`  ${key.slice(0, prefix.length + 6)}… → ${hashed}`);
        continue;
      }

      const value = await kvGet(key);
      if (value == null) {
        console.log(`  ! ${key.slice(0, prefix.length + 6)}… 读取失败，跳过`);
        totalFailed += 1;
        continue;
      }

      const existing = await kvGet(hashed);
      if (existing == null) {
        const ok = await kvPut(hashed, value, name === '会话令牌' ? SESSION_TTL : undefined);
        if (!ok) {
          console.log(`  ! 写入哈希键失败：${hashed}（保留明文键）`);
          totalFailed += 1;
          continue;
        }
      }
      /*
       * 回读确认后才能删明文键 —— 但 **Cloudflare KV 是最终一致的**：
       * PUT 之后立刻 GET，可能仍读到旧值或 null（跨节点传播通常几十毫秒，不保证）。
       * 首版就是在这里误判了 4 个键（"回读不一致"），实际写入是成功的。
       * 所以用退避重试，而不是一次读不到就放弃。
       */
      let verify = null;
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        verify = await kvGet(hashed);
        if (verify === value) break;
        await new Promise((r) => setTimeout(r, 150 * attempt));
      }
      if (verify !== value) {
        console.log(`  ! 回读不一致（重试 6 次）：${hashed}（保留明文键）`);
        totalFailed += 1;
        continue;
      }
      if (await kvDelete(key)) totalDone += 1;
      else {
        console.log(`  ! 删除明文键失败：${key.slice(0, prefix.length + 6)}…`);
        totalFailed += 1;
      }
    }
  }

  console.log(`\n合计：计划 ${totalPlanned} 个` + (APPLY ? `，完成 ${totalDone} 个，失败 ${totalFailed} 个` : '（未写入）'));
  if (!APPLY) {
    console.log('DRY-RUN 结束。执行：node tools/scripts/migrate-auth-keys-hash.mjs --apply');
  }
  if (totalFailed) process.exitCode = 1;
};

main().catch((e) => {
  console.error('迁移失败:', e.message);
  process.exitCode = 1;
});
