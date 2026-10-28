#!/usr/bin/env node
/**
 * 账号记录拆分：`auth:user:` 的可识别字段迁到境内（G1 最后一批）
 *
 * 背景
 * ----
 * `auth:user:<id>` 的值里有 `phone` 与三个 openid/unionid（个人信息），
 * 也带着 `passwordHash`/`passwordSalt`（每次带登录态的请求都要读）。
 * 代码侧已改为「KV 存脱敏副本 + 境内 Mongo 存可识别字段」，本脚本处理历史存量：
 *   ① 把 phone / 各 openid 投递到境内 `/v1/admin/auth-users`；
 *   ② 回读确认后，把 KV 的值**覆盖为脱敏副本**（去掉 phone 与 openid）。
 *
 * 为什么保留 passwordHash：`resolveSession` 在每一次带登录态的请求上都要读用户记录，
 * 把它搬到 Mongo 等于给热路径加一次公网往返。摘要不可逆、不加盐也无法还原明文，
 * 且与任何可识别字段分离后不再构成"个人信息"——真正需要出境管控的是 phone/openid。
 *
 * 安全设计
 * --------
 *   1. 默认 dry-run；
 *   2. 先投递境内、回读确认，**再**覆盖 KV；任一条失败则整批不动 KV；
 *   3. 幂等：境内按 userId upsert，脚本可反复重跑。
 *
 * 用法
 * ----
 *   node tools/scripts/migrate-auth-user-values.mjs            # 预演
 *   node tools/scripts/migrate-auth-user-values.mjs --apply    # 真正迁移
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeUserForKv } from '../../functions/lib/auth-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const APPLY = process.argv.includes('--apply');
const KV_NS = process.env.QTVQ_KV_NAMESPACE_ID || '4ec5d9cc8b3e4210bd29112073a6c502';
const BASE = (process.env.NODE_API_BASE || 'https://qtvq.cn').replace(/\/+$/, '');
const USER_PREFIX = 'auth:user:';

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

const NODE_H = {
  'Content-Type': 'application/json',
  'X-Admin-Key': ADMIN_KEY,
  'User-Agent': 'qtvq-migrate-auth-user/1.0 (+https://qtvq.cn)',
};

async function postIdentity(user) {
  const r = await fetch(`${BASE}/v1/admin/auth-users`, {
    method: 'POST',
    headers: NODE_H,
    body: JSON.stringify({
      userId: user.id,
      clientId: user.clientId || null,
      createdAt: user.createdAt || Date.now(),
      phone: user.phone || null,
      wechatOpenId: user.wechatOpenId || null,
      wechatWebOpenId: user.wechatWebOpenId || null,
      wechatMpOpenId: user.wechatMpOpenId || null,
      wechatUnionId: user.wechatUnionId || null,
    }),
  });
  return { ok: r.ok, status: r.status };
}

async function getIdentity(userId) {
  const r = await fetch(`${BASE}/v1/admin/auth-users/${encodeURIComponent(userId)}`, {
    headers: { 'X-Admin-Key': ADMIN_KEY, 'User-Agent': NODE_H['User-Agent'] },
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j?.data || null;
}

const main = async () => {
  console.log(`模式: ${APPLY ? 'APPLY（投递境内并覆盖 KV 为脱敏副本）' : 'DRY-RUN（只报告）'}`);
  const keys = await kvList(USER_PREFIX);
  console.log(`KV 命中 ${USER_PREFIX}* 键：${keys.length} 个`);
  if (!keys.length) return;

  const prepared = [];
  const failed = [];
  for (const { name } of keys) {
    const raw = await kvGet(name);
    if (raw == null) {
      failed.push({ key: name, why: '读取失败' });
      continue;
    }
    let user;
    try {
      user = JSON.parse(raw);
    } catch {
      failed.push({ key: name, why: '值不是 JSON' });
      continue;
    }
    prepared.push({ key: name, user, sanitized: JSON.stringify(sanitizeUserForKv(user)) });
  }

  const withPii = prepared.filter((p) =>
    ['phone', 'wechatOpenId', 'wechatWebOpenId', 'wechatMpOpenId', 'wechatUnionId'].some((f) => p.user[f]),
  );
  console.log(`含可识别字段的账号：${withPii.length} 个（其余 ${prepared.length - withPii.length} 个本来就没有）`);

  if (!APPLY) {
    for (const p of withPii) {
      const fields = ['phone', 'wechatOpenId', 'wechatWebOpenId', 'wechatMpOpenId', 'wechatUnionId'].filter(
        (f) => p.user[f],
      );
      console.log(`  ${p.user.id} → 将迁出 [${fields.join(', ')}]`);
    }
    console.log('\nDRY-RUN 结束（未写入）。执行：node tools/scripts/migrate-auth-user-values.mjs --apply');
    if (failed.length) {
      failed.forEach((f) => console.log(`  ! ${f.key}: ${f.why}`));
      process.exitCode = 1;
    }
    return;
  }

  for (const p of prepared) {
    const res = await postIdentity(p.user);
    if (!res.ok) {
      failed.push({ key: p.key, why: `投递失败 HTTP ${res.status}` });
      continue;
    }
    const back = await getIdentity(p.user.id);
    if (!back) {
      failed.push({ key: p.key, why: '回读境内记录失败' });
      continue;
    }
    // 关键字段必须真的落库，否则不允许覆盖 KV（覆盖后 KV 就没有了）
    for (const f of ['phone', 'wechatOpenId', 'wechatWebOpenId', 'wechatMpOpenId', 'wechatUnionId']) {
      if (p.user[f] && back[f] !== p.user[f]) {
        failed.push({ key: p.key, why: `回读字段不一致：${f}` });
        break;
      }
    }
  }

  if (failed.length) {
    console.log('\n有失败项，**不覆盖任何 KV**：');
    failed.forEach((f) => console.log(`  - ${f.key}: ${f.why}`));
    process.exitCode = 1;
    return;
  }

  let done = 0;
  for (const p of prepared) {
    if (await kvPut(p.key, p.sanitized)) done += 1;
  }
  console.log(`KV 已覆盖为脱敏副本：${done}/${prepared.length}`);

  // 抽查：KV 里不应再有 phone/openid
  let dirty = 0;
  for (const p of prepared) {
    const raw = await kvGet(p.key);
    if (raw == null) continue;
    if (/"phone"|"wechat(OpenId|WebOpenId|MpOpenId|UnionId)"/.test(raw)) {
      dirty += 1;
      console.log(`  ⚠ 仍含可识别字段：${p.key}`);
    }
  }
  console.log(dirty === 0 ? '\n✅ 抽查通过：KV 账号记录已无可识别字段' : `\n❌ ${dirty} 个键仍含可识别字段`);
  if (dirty) process.exitCode = 1;
};

main().catch((e) => {
  console.error('迁移失败:', e.message);
  process.exitCode = 1;
});
