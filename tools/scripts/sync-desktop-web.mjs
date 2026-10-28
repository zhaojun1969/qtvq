/**
 * 把 uni-app 的 H5 产物同步进桌面壳：`apps/qtvq-uni/dist/build/h5` → `desktop/web`
 *
 * 为什么桌面壳里要**内置**一份网页：直连 https://qtvq.cn 的壳一断网就白屏。
 * 内置一份本地副本后，断网时至少还能打开界面（数据接口不可用时给出提示），
 * 联网时以主站为准（见 desktop/src/main.js 的加载顺序）。
 *
 * 注意：H5 必须用**相对路径**引用 assets（apps/qtvq-uni/vite.config.js 里的 `base: './'`），
 * 否则 file:// 加载时 `/assets/...` 会解析到磁盘根目录，界面全白。
 * 本脚本会检查这一点，不通过就报错——这个坑踩过一次（见该注释与那份配置）。
 *
 * 用法：node tools/scripts/sync-desktop-web.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'apps', 'qtvq-uni', 'dist', 'build', 'h5');
const DEST = path.join(ROOT, 'desktop', 'web');

if (!fs.existsSync(SRC)) {
  console.error(`ERROR: 找不到 H5 产物 ${path.relative(ROOT, SRC)}`);
  console.error('  先构建：cd apps/qtvq-uni && npm run build:h5');
  process.exit(1);
}

const indexHtml = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
if (!/src="\.\/assets\//.test(indexHtml) && !/href="\.\/assets\//.test(indexHtml)) {
  console.error('ERROR: H5 产物用的是绝对路径（/assets/...），file:// 加载会白屏。');
  console.error("  检查 apps/qtvq-uni/vite.config.js 里是否有 base: './'，然后重新构建 H5。");
  process.exit(1);
}

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });
fs.cpSync(SRC, DEST, { recursive: true });

const count = (dir) => {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? count(path.join(dir, e.name)) : 1;
  }
  return n;
};

console.log(`>> 已同步 H5 到桌面壳：${path.relative(ROOT, SRC)} → ${path.relative(ROOT, DEST)}`);
console.log(`   文件数 ${count(DEST)}；assets 引用为相对路径 ✅（file:// 可加载）`);
console.log('   下一步：cd desktop && npm run dist   （产出 NSIS 安装包与免安装版）');
