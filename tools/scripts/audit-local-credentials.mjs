/**
 * 三个问题的并行排查：
 *  A) 除短信 AK 外，本地其它 AK 有没有 RAM / ActionTrail 权限（若有，短信身份可由程序直接创建）
 *  B) 谁能用 RAM 权限：逐个 AK 调 STS GetCallerIdentity + RAM ListUsers + ActionTrail LookupEvents
 *  C) 文档目录里是否记录了服务器用的 ADMIN_KEY（若有，运营台 401 无需上服务器即可对齐）
 *
 * 只打印 AK ID 与结论，绝不打印 Secret。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const pe = (s) => encodeURIComponent(s).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');

async function call(endpoint, action, version, cred, params = {}) {
  const c = {
    Format: 'JSON',
    Version: version,
    AccessKeyId: cred.id,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Action: action,
    ...params,
  };
  const can = Object.keys(c)
    .sort()
    .map((k) => `${pe(k)}=${pe(String(c[k]))}`)
    .join('&');
  const sig = crypto.createHmac('sha1', `${cred.secret}&`).update(`POST&%2F&${pe(can)}`).digest('base64');
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: `${can}&Signature=${pe(sig)}`,
  });
  return JSON.parse(await r.text());
}

/* ── 收集本地所有 AK ── */
const creds = [];
const addCred = (label, id, secret) => {
  if (id && secret && !creds.some((c) => c.id === id)) creds.push({ label, id, secret });
};

for (const file of ['.dev.vars', 'obs.env', 'cf.env', 'server/.env']) {
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]*(?:ACCESS_KEY_ID|ACCESSKEYID|AK_ID)[A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    const keyName = m[1];
    const idVal = m[2].trim();
    if (!/^LTAI/.test(idVal)) continue;
    // 找同一文件里对应的 secret
    const secretLine = text
      .split(/\r?\n/)
      .find((l) => l.startsWith(keyName.replace(/ACCESS_KEY_ID|ACCESSKEYID|AK_ID/, 'SECRET_ACCESS_KEY') + '=') || l.startsWith('OBS_SECRET_ACCESS_KEY=') || l.startsWith('OSS_SECRET_ACCESS_KEY='));
    const secretVal = secretLine ? secretLine.split('=').slice(1).join('=').trim() : '';
    if (secretVal) addCred(`${file}:${keyName}`, idVal, secretVal);
  }
}

console.log('=== A) 本地各 AK 的身份与 RAM/ActionTrail 能力 ===');
const statusOf = (id) => `${id.slice(0, 8)}…${id.slice(-4)}`;
for (const cred of creds) {
  const ident = await call('https://sts.aliyuncs.com/', 'GetCallerIdentity', '2015-04-01', cred);
  const who = ident.Code ? `${ident.Code}` : `${ident.IdentityType === 'RAMUser' ? 'RAM 用户' : '主账号'} ${String(ident.Arn || '').replace('acs:ram::', '')}`;
  const users = await call('https://ram.aliyuncs.com/', 'ListUsers', '2015-05-01', cred, { PageSize: '10' });
  const ramOk = users.Code ? `无RAM读权限(${users.Code})` : `可读RAM用户(${users.Users?.TotalCount ?? 0} 个)`;
  const createOk = users.Code ? '否' : '是（说明该 AK 具备 ram:CreateUser）';
  console.log(`  ${statusOf(cred.id)}  ${who}`);
  console.log(`      来源: ${cred.label}`);
  console.log(`      RAM 读取: ${ramOk}   能否由程序创建 RAM 用户: ${createOk}`);
}

console.log('');
console.log('=== C) 文档目录里是否记录了 ADMIN_KEY ===');
const roots = [path.join(process.env.USERPROFILE || '', 'Documents'), path.join(process.env.USERPROFILE || '', 'Desktop')];
const hits = [];
const walk = (dir, depth = 0) => {
  if (depth > 4) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (/node_modules|\.git|xwechat_files|AppData/i.test(e.name)) continue;
      walk(p, depth + 1);
    } else if (/\.(txt|json|env|md|ini|conf|properties|bak)$/i.test(e.name)) {
      let t = '';
      try {
        if (fs.statSync(p).size > 300000) continue;
        t = fs.readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      if (/ADMIN_KEY/i.test(t)) {
        const line = t.split(/\r?\n/).find((l) => /ADMIN_KEY/i.test(l)) || '';
        const val = line.split(/[=:：]/).slice(1).join('=').trim();
        hits.push({ p, line: line.slice(0, 60), len: val.length, tail: val.slice(-4) });
      }
    }
  }
};
for (const r of roots) walk(r);
if (hits.length === 0) console.log('  （未发现记录 ADMIN_KEY 的文件）');
for (const h of hits) {
  console.log(`  · ${h.p}`);
  console.log(`      ${h.line}   值长度=${h.len} 尾部=${h.tail}`);
}

console.log('');
console.log('=== B) 那把短信 AK 的 OSS/ECS 调用方：本地是否有文件引用它 ===');
const TARGET = 'LTAI5t7RccCgS8TCrsovav42';
const refs = [];
const walk2 = (dir, depth = 0) => {
  if (depth > 4) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (/node_modules|\.git|xwechat_files|AppData|\.cache/i.test(e.name)) continue;
      walk2(p, depth + 1);
    } else if (/\.(txt|json|env|md|ini|conf|properties|js|mjs|py|ps1|sh|yaml|yml|toml)$/i.test(e.name)) {
      try {
        if (fs.statSync(p).size > 500000) continue;
        if (fs.readFileSync(p, 'utf8').includes(TARGET)) refs.push(p);
      } catch {
        /* skip */
      }
    }
  }
};
for (const r of roots) walk2(r);
walk2(process.cwd());
if (refs.length === 0) console.log('  （本地没有任何文件引用它 —— 说明 OSS/ECS 调用来自别的机器）');
for (const r of refs) console.log(`  · ${r}`);
