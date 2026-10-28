/**
 * 一次性构建**所有平台**（小程序矩阵 + H5 + App 资源）。
 *
 * 为什么要这个：`npm run build:mp-all` 原来是手写串起来的 4 个平台，加平台时总会漏。
 * 这里从 package.json 里**动态发现**所有 `build:mp-*` 脚本，逐个执行并汇总结果 ——
 * 以后再加平台只要加脚本，这个命令自动覆盖。
 *
 * 用法：node apps/qtvq-uni/scripts/build-all-platforms.js [--ci]
 *      --ci  任一平台失败立即以非 0 退出（默认：全部跑完再汇总，便于一次看清哪几个挂了）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));

const ciMode = process.argv.includes('--ci');

const targets = [
  ...Object.keys(pkg.scripts)
    .filter((s) => /^build:mp-/.test(s))
    .map((s) => s.replace(/^build:/, '')),
  'h5',
  'app',
];

console.log(`=== 全端构建：共 ${targets.length} 个目标 ===`);
console.log(targets.join(', '));
console.log('');

const results = [];
for (const t of targets) {
  const script = `build:${t}`;
  if (!pkg.scripts[script]) {
    console.log(`⏭️  跳过 ${t}（package.json 无 ${script}）`);
    results.push({ t, ok: null });
    continue;
  }
  const t0 = Date.now();
  console.log(`▶️  构建 ${t} ...`);
  const r = spawnSync('npm', ['run', script], {
    cwd: APP,
    stdio: 'inherit',
    shell: true,
  });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  results.push({ t, ok, ms });
  console.log(`${ok ? '✅' : '❌'} ${t} 完成（${(ms / 1000).toFixed(1)}s）`);
  console.log('');
  if (!ok && ciMode) {
    console.log(`--ci 模式：${t} 失败，立即退出`);
    process.exit(1);
  }
}

console.log('=== 汇总 ===');
let failed = 0;
for (const r of results) {
  const mark = r.ok === null ? '⏭️ ' : r.ok ? '✅' : '❌';
  if (r.ok === false) failed += 1;
  console.log(`  ${mark} ${r.t.padEnd(14)} ${r.ms ? `${(r.ms / 1000).toFixed(1)}s` : ''}`);
}
console.log('');
if (failed) {
  console.log(`❌ ${failed} 个平台构建失败`);
  process.exit(1);
}
console.log('✅ 全部平台构建成功。产物在 apps/qtvq-uni/dist/build/<平台>/');
console.log('   各平台上传方式见 docs/全端交付能力盘点.md');
