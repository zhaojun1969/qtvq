import fs from 'node:fs';
import path from 'node:path';

const TARGET = process.env.QTVQ_AUDIT_AK_ID;
if (!TARGET) { console.error('缺环境变量 QTVQ_AUDIT_AK_ID（审计目标 AccessKey ID，从 env 注入，不写入源码）'); process.exit(1); }

const files = [
  '.dev.vars',
  'obs.env',
  'cf.env',
  'server/.env',
  'server/.env.example',
  '.secrets/wechat/README.md',
  'context/CONTEXT-SNAPSHOT.md',
];

console.log(`目标 AK: ${TARGET}`);
console.log('（只比对 AK ID —— AK ID 不是密码，单独拿到无法调用接口；Secret 一律不打印）');
console.log('');

const found = new Map();
const akRe = /LTAI[A-Za-z0-9]{5,30}/g;

function scan(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const ids = line.match(akRe);
    if (!ids) continue;
    const keyName = (line.split(/[=:：]/)[0] || '').trim().slice(0, 40);
    for (const id of ids) {
      if (!found.has(id)) found.set(id, []);
      found.get(id).push(`${file}  ← ${keyName}`);
    }
  }
}
for (const f of files) scan(f);

// 顺带扫一遍 server 目录下的 .env* 与 tools 脚本里硬编码的 AK
const walk = (dir, depth = 0) => {
  if (depth > 2 || !fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (/\.(env|vars|example|md|json)$/i.test(e.name) && fs.statSync(p).size < 200000) scan(p);
  }
};
walk('server');
walk('tools');
walk('context');

console.log('=== 本地配置里出现过的所有 AK ID ===');
for (const [id, where] of found) {
  const mark = id === TARGET ? '  ★ 就是它在用' : '';
  console.log(`  ${id}  (${id.length} 位)${mark}`);
  for (const w of [...new Set(where)].slice(0, 6)) console.log(`      ${w}`);
}
if (![...found.keys()].includes(TARGET)) {
  console.log('  （目标 AK 未出现在这些本地配置里 —— 说明它的 OSS/ECS 调用来自别处：服务器上的脚本、旧项目、或第三方工具）');
}
