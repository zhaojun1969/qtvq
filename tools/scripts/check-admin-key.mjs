import fs from 'node:fs';

const env = fs.readFileSync('server/.env', 'utf8');
const get = (k) => {
  const line = env.split(/\r?\n/).find((l) => l.startsWith(`${k}=`));
  return line ? line.slice(k.length + 1).trim() : '';
};
const localKey = get('ADMIN_KEY');
const pagesKey = (() => {
  const t = fs.readFileSync('.dev.vars', 'utf8');
  const line = t.split(/\r?\n/).find((l) => l.startsWith('PAYMENT_ADMIN_KEY='));
  return line ? line.slice('PAYMENT_ADMIN_KEY='.length).trim() : '';
})();

const BASE = 'https://qtvq.cn/v1/admin';
const targets = [
  ['本地 server/.env 的 ADMIN_KEY', localKey],
  ['Pages 的 PAYMENT_ADMIN_KEY', pagesKey],
  ['故意错的密钥', 'wrong-key-for-test'],
  ['不带密钥', ''],
];

console.log('=== 运营台鉴权实测（/v1/admin/overview）===');
console.log('判读依据：404 = 服务端没配 ADMIN_KEY（整组隐藏）；401 = 配了但密钥不匹配；200 = 通过');
console.log('');

for (const [label, key] of targets) {
  try {
    const headers = key ? { 'X-Admin-Key': key } : {};
    const res = await fetch(`${BASE}/overview`, { headers });
    const text = await res.text();
    let note = '';
    if (res.status === 404) note = '← 服务端未配置 ADMIN_KEY（整组按 404 隐藏）';
    else if (res.status === 401) note = '← 服务端有 ADMIN_KEY，但不是这一把';
    else if (res.status === 200) note = '← ✅ 通过';
    console.log(`${String(res.status).padEnd(4)} ${label.padEnd(28)} ${note}`);
    if (res.status === 200) console.log(`     响应片段: ${text.slice(0, 160)}`);
  } catch (e) {
    console.log(`ERR  ${label.padEnd(28)} ${e.message}`);
  }
}

console.log('');
console.log('=== 运营台页面（无需鉴权）===');
try {
  const res = await fetch(`${BASE}/console`);
  console.log(`  GET /v1/admin/console → HTTP ${res.status} ${res.status === 200 ? '（页面存在）' : '（不存在）'}`);
} catch (e) {
  console.log(`  ERR ${e.message}`);
}

console.log('');
console.log('=== 对照：Pages 侧的运营接口 ===');
try {
  const res = await fetch(`https://qtvq.cn/api/payment?list=orders&adminKey=${encodeURIComponent(pagesKey)}`);
  console.log(`  /api/payment?list=orders → HTTP ${res.status}（${res.status === 200 ? 'Pages 密钥可用' : '不可用'}）`);
} catch (e) {
  console.log(`  ERR ${e.message}`);
}
