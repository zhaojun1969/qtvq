#!/usr/bin/env node
/**
 * 把 Cloudflare KV 里的账号与会话迁移到境内 Mongo（2026-10-26）。
 *
 * ── 迁什么 ────────────────────────────────────────────────────────────────
 *   `auth:user:<userId>` → `auth_users`（含 **passwordHash / passwordSalt**）
 *   `auth:s:<hash>`      → `auth_sessions`（`_id` 直接用这个 hash）
 *
 * ── 两个必须做对的点 ──────────────────────────────────────────────────────
 * 1. **密码哈希原样搬，不重算**。PBKDF2 100k 轮的参数必须与 Node 侧一致；
 *    若这里"顺手"换参数，所有存量用户将无法登录。脚本只做搬运，不重新哈希。
 * 2. **会话键沿用原 hash**。KV 键 `auth:s:<sha256('session:'+token) 前32hex>`，
 *    迁移时把这个 hash 直接作为 Mongo `_id`，Node 端用同一算法算 key 即可命中 ——
 *    已登录用户不会被强制下线。
 *
 * 迁完逐条回读校验：用户的 hash/salt 必须与 KV 完全一致，会话的 userId 必须一致。
 * 任一不一致 → 退出码 1（**此时不要清理 KV**）。
 *
 * 用法：
 *   node tools/scripts/migrate-kv-auth.mjs --dry-run
 *   node tools/scripts/migrate-kv-auth.mjs
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

const wrangler = fs.readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8');
const nsMatch = /binding\s*=\s*"QTVQ_KV"[\s\S]{0,200}?id\s*=\s*"([a-f0-9]{32})"/.exec(wrangler);
if (!nsMatch) {
  console.error('✗ 无法解析 QTVQ_KV namespace id');
  process.exit(1);
}
const ns = nsMatch[1];

const base = arg('base', process.env.QTVQ_NODE_BASE || 'https://qtvq.cn').replace(/\/+$/, '');
const adminKey = arg('admin-key', process.env.QTVQ_NODE_ADMIN_KEY || '');
if (!DRY && !adminKey) {
  console.error('✗ 需要 --admin-key 或 QTVQ_NODE_ADMIN_KEY');
  process.exit(1);
}

const H = { Authorization: `Bearer ${token}` };
const API = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${ns}`;

async function listKeys(prefix) {
  const all = [];
  let cursor = '';
  for (;;) {
    const url = `${API}/keys?prefix=${encodeURIComponent(prefix)}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetch(url, { headers: H });
    const j = await res.json();
    if (!j.success) throw new Error(`列 KV 键失败(${prefix}): ${JSON.stringify(j.errors)}`);
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

async function post(pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${pathname} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json().catch(() => ({}));
}

async function getJson(pathname) {
  const res = await fetch(`${base}${pathname}`, { headers: { 'X-Admin-Key': adminKey } });
  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  return j?.data ?? null;
}

/* ---------------------------------------------------------------- 账号 */

const userKeys = await listKeys('auth:user:');
console.log(`读取 KV：账号 ${userKeys.length} 个`);
const users = [];
for (const { name } of userKeys) {
  const u = await getValue(name);
  if (!u) {
    console.warn(`  跳过（无法解析）：${name}`);
    continue;
  }
  users.push({
    userId: name.slice('auth:user:'.length),
    phone: u.phone || null,
    clientId: u.clientId || null,
    passwordHash: u.passwordHash || null,
    passwordSalt: u.passwordSalt || null,
    createdAt: u.createdAt || null,
    wechatMpOpenId: u.wechatMpOpenId || null,
    wechatOpenId: u.wechatOpenId || null,
    wechatUnionId: u.wechatUnionId || null,
    wechatWebOpenId: u.wechatWebOpenId || null,
  });
}
const withPwd = users.filter((u) => u.passwordHash && u.passwordSalt).length;
console.log(`可迁移账号：${users.length}（其中带密码 ${withPwd} 个 —— 哈希必须原样搬）`);

/* ---------------------------------------------------------------- 会话 */

const sessionKeys = await listKeys('auth:s:');
console.log(`读取 KV：会话 ${sessionKeys.length} 个`);
const sessions = [];
for (const { name } of sessionKeys) {
  const s = await getValue(name);
  if (!s || !s.userId) continue;
  sessions.push({
    hashId: name.slice('auth:s:'.length),
    userId: s.userId,
    clientId: s.clientId || null,
    expiresAt: s.expiresAt || null,
  });
}
console.log(`可迁移会话：${sessions.length}`);

if (DRY) {
  for (const u of users) {
    console.log(`  账号 ${u.userId.padEnd(24)} ${u.phone || '(无手机号)'} 密码=${u.passwordHash ? '有' : '无'}`);
  }
  for (const s of sessions) {
    console.log(`  会话 ${s.hashId.slice(0, 12)}… userId=${s.userId}`);
  }
  console.log('\n(--dry-run：未写入)');
  process.exit(0);
}

/* ---------------------------------------------------------------- 写入 */

const adminBase = '/v1/admin/auth-users';
let okUsers = 0;
const failed = [];
for (const u of users) {
  try {
    await post(adminBase, {
      userId: u.userId,
      phone: u.phone,
      clientId: u.clientId,
      passwordHash: u.passwordHash,
      passwordSalt: u.passwordSalt,
      createdAt: u.createdAt,
      // 微信身份字段沿用既有 admin 接口的命名
      wechatMpOpenId: u.wechatMpOpenId,
      wechatOpenId: u.wechatOpenId,
      wechatUnionId: u.wechatUnionId,
      wechatWebOpenId: u.wechatWebOpenId,
    });
    okUsers += 1;
  } catch (err) {
    failed.push(`账号 ${u.userId}: ${err.message}`);
  }
}

let okSessions = 0;
for (const s of sessions) {
  try {
    await post('/v1/admin/auth-sessions', s);
    okSessions += 1;
  } catch (err) {
    failed.push(`会话 ${s.hashId.slice(0, 12)}: ${err.message}`);
  }
}

console.log(`\n写入：账号 ${okUsers}/${users.length}，会话 ${okSessions}/${sessions.length}`);
if (failed.length) {
  console.error('失败明细：');
  for (const f of failed) console.error('  ' + f);
  process.exit(1);
}

/* ---------------------------------------------------------------- 回读校验 */

let mismatch = 0;
for (const u of users) {
  // 必须带 ?secrets=1：管理接口默认**不返回**密码哈希，否则这里读不到会误报"不一致"
  const got = await getJson(`${adminBase}/${encodeURIComponent(u.userId)}?secrets=1`);
  if (!got) {
    console.error(`  ✗ 回读不到账号 ${u.userId}`);
    mismatch += 1;
    continue;
  }
  if ((got.passwordHash || null) !== u.passwordHash || (got.passwordSalt || null) !== u.passwordSalt) {
    console.error(`  ✗ 账号 ${u.userId} 密码哈希不一致（登录会失败）`);
    mismatch += 1;
  }
}
for (const s of sessions) {
  const got = await getJson(`/v1/admin/auth-sessions/${encodeURIComponent(s.hashId)}`);
  if (!got || got.userId !== s.userId) {
    console.error(`  ✗ 会话 ${s.hashId.slice(0, 12)} 不一致`);
    mismatch += 1;
  }
}
if (mismatch) {
  console.error(`\n✗ 校验失败：${mismatch} 条不一致。**不要**清理 KV，先排查。`);
  process.exit(1);
}
console.log(`✅ 校验通过：${users.length} 个账号（含 ${withPwd} 个密码哈希）+ ${sessions.length} 个会话全部一致`);
console.log('   KV 记录**未删除**，保留作为回滚依据。');
