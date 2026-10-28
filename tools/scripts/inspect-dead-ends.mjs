import fs from 'node:fs';

const p = fs.readFileSync('profile.html', 'utf8');
console.log('=== profile.html 的 id 锚点 ===');
console.log('  ' + ([...p.matchAll(/id="([^"]+)"/g)].map((m) => m[1]).join(', ') || '(无)'));

console.log('\n=== help.html 里指向 profile.html 的链接 ===');
const h = fs.readFileSync('help.html', 'utf8');
for (const m of h.matchAll(/href="profile\.html[^"]*"/g)) {
  const i = h.indexOf(m[0]);
  const ctx = h.slice(Math.max(0, i - 90), i).split(/\r?\n/).pop().trim();
  console.log(`  ${m[0]}    ← ${ctx.slice(-50)}`);
}

console.log('\n=== index.html 的 feature-qask ===');
const idx = fs.readFileSync('index.html', 'utf8');
const j = idx.indexOf('feature-qask');
console.log('  ' + idx.slice(Math.max(0, j - 110), j + 110).replace(/\s+/g, ' '));

console.log('\n=== download.html 的 dl-* ===');
const d = fs.readFileSync('download.html', 'utf8');
const k = d.indexOf('dl-android');
console.log('  ' + d.slice(Math.max(0, k - 150), k + 130).replace(/\s+/g, ' '));
console.log('  dl-* 出现次数:', (d.match(/dl-(android|ios|harmony)/g) || []).length);

console.log('\n=== wechat-callback.html 的内联脚本是否引用了 cb-copy / cb-retry ===');
const cb = fs.readFileSync('wechat-callback.html', 'utf8');
console.log('  含 cb-copy 引用:', cb.includes("getElementById('cb-copy')"));
console.log('  含 cb-retry 引用:', cb.includes("getElementById('cb-retry')"));
