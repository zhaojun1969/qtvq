/**
 * 用「文档里记录的那把密钥」去试线上，判断服务器实际在用的是哪一把。
 * 目的：能不上服务器就不上（业务方终端粘贴容易出错）。
 * 不打印密钥内容，只打印尾部 4 位用于比对。
 */
import fs from 'node:fs';
import path from 'node:path';

function loadKeys() {
  const keys = [];
  const push = (label, value) => {
    const v = (value || '').trim();
    if (v && !keys.some((k) => k.value === v)) keys.push({ label, value: v });
  };

  // 1) 文档目录里记录的
  const docFile = path.join(process.env.USERPROFILE || '', 'Documents', 'qtvq文档', '本机管理员密钥', '密钥.txt');
  if (fs.existsSync(docFile)) {
    const t = fs.readFileSync(docFile, 'utf8');
    for (const line of t.split(/\r?\n/)) {
      const m = /^(PAYMENT_ADMIN_KEY|ADMIN_KEY)\s*=\s*(.+)$/.exec(line.trim());
      if (m) push(`文档记录 ${m[1]}`, m[2]);
    }
    if (keys.length === 0) {
      // 文件里可能只写了一串裸密钥
      const bare = t.split(/\r?\n/).map((l) => l.trim()).find((l) => /^[A-Z0-9_]{20,}$/.test(l));
      if (bare) push('文档记录（裸值）', bare);
    }
  }

  // 2) 本项目 .dev.vars
  const dev = fs.readFileSync('.dev.vars', 'utf8');
  const devLine = dev.split(/\r?\n/).find((l) => l.startsWith('PAYMENT_ADMIN_KEY='));
  if (devLine) push('.dev.vars PAYMENT_ADMIN_KEY', devLine.slice('PAYMENT_ADMIN_KEY='.length));

  // 3) server/.env（Node 服务的本地副本）
  if (fs.existsSync('server/.env')) {
    const se = fs.readFileSync('server/.env', 'utf8');
    const l = se.split(/\r?\n/).find((x) => x.startsWith('ADMIN_KEY='));
    if (l) push('server/.env ADMIN_KEY', l.slice('ADMIN_KEY='.length));
  }
  return keys;
}

const keys = loadKeys();
console.log(`共收集到 ${keys.length} 把候选密钥（只显示尾部 4 位）`);
for (const k of keys) console.log(`  · ${k.label.padEnd(28)} …${k.value.slice(-4)}  (长度 ${k.value.length})`);
console.log('');

console.log('=== 对 Node 服务 /v1/admin/overview 逐个试（404=服务端没配；401=不匹配；200=通过）===');
for (const k of keys) {
  try {
    const res = await fetch('https://qtvq.cn/v1/admin/overview', { headers: { 'X-Admin-Key': k.value } });
    const note = res.status === 200 ? '✅ 通过 —— 服务器用的就是这一把' : res.status === 404 ? '服务端未配置 ADMIN_KEY' : '不匹配';
    console.log(`  ${String(res.status).padEnd(4)} ……${k.value.slice(-4)}  ${k.label}  ${note}`);
    if (res.status === 200) {
      const t = await res.text();
      console.log(`       响应片段: ${t.slice(0, 200)}`);
    }
  } catch (e) {
    console.log(`  ERR  ${k.label} ${e.message}`);
  }
}

console.log('');
console.log('=== 对 Pages 运营接口试（判断哪一把是 Pages 在用的）===');
for (const k of keys) {
  try {
    const res = await fetch(`https://qtvq.cn/api/payment?list=orders&adminKey=${encodeURIComponent(k.value)}`);
    console.log(`  ${String(res.status).padEnd(4)} ……${k.value.slice(-4)}  ${k.label}  ${res.status === 200 ? '✅ 通过' : '不匹配'}`);
  } catch (e) {
    console.log(`  ERR  ${k.label} ${e.message}`);
  }
}
