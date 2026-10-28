import fs from 'node:fs';
import path from 'node:path';

/** 提取每个路由文件的 "挂载前缀 + 路径"，用于生成准确的小程序 API 封装 */
const dir = 'server/src/routes';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));

// app.js 里的挂载前缀
const app = fs.readFileSync('server/src/app.js', 'utf8');
const mounts = [...app.matchAll(/app\.use\(\s*'([^']+)'\s*,\s*(\w+)/g)].map((m) => [m[2], m[1]]);
console.log('=== app.js 中的挂载 ===');
for (const [mod, prefix] of mounts) console.log(`  ${mod} → ${prefix}`);

const mountOf = (file) => {
  const base = path.basename(file, '.js');
  const hit = mounts.find(([mod]) => mod.toLowerCase().includes(base) || base.includes(mod.toLowerCase()));
  return hit ? hit[1] : `(未知前缀:${base})`;
};

console.log('\n=== 各路由的实际路径 ===');
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  const prefix = mountOf(f);
  const paths = [...src.matchAll(/router\.(get|post)\(\s*\n?\s*'([^']+)'/g)].map((m) => `${m[1].toUpperCase()} ${prefix}${m[2] === '/' ? '' : m[2]}`);
  if (paths.length) {
    console.log(`  ${f}:`);
    for (const p of paths) console.log(`      ${p}`);
  }
}
