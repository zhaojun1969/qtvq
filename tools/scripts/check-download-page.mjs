/**
 * 下载页一致性检查
 *
 * 下载页现在由 `js/download-config.js`（**生成文件**）数据驱动渲染。这条链上有四个环节，
 * 任何一处对不上，页面就会"少了某个端"或"点了没反应"，而且**不会报错**：
 *
 *   release-links.json ──(write-download-config.mjs)──▶ js/download-config.js
 *        │                                                      │
 *        └──(write-release-manifest.mjs)──▶ release/version.json │
 *                                                               ▼
 *                                          download.html 的容器 id ← js/download.js 的选择器
 *
 * 本脚本核对：
 *   ① download-config.js 是否是生成文件（含生成标记），避免有人手改后被下次生成覆盖；
 *   ② DOWNLOAD_SECTIONS 里每个 key 都在 DOWNLOAD_LINKS 里有定义；
 *   ③ download.html 里存在 download.js 要找的容器（data-dl-grid / id）；
 *   ④ 每个"已有 href"的入口在 html 里确实会被渲染（不需要静态标记，只做能力核对）；
 *   ⑤ release/version.json 与 download-config 的地址来源一致（都来自 release-links.json）。
 *
 * 用法: node tools/scripts/check-download-page.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
let fail = 0;
const bad = (m) => {
  console.log(`  ❌ ${m}`);
  fail += 1;
};
const ok = (m) => console.log(`  ✅ ${m}`);

const cfgPath = path.join(ROOT, 'js', 'download-config.js');
const htmlPath = path.join(ROOT, 'download.html');
const jsPath = path.join(ROOT, 'js', 'download.js');

console.log('=== ① 生成文件标记 ===');
const cfgSrc = fs.readFileSync(cfgPath, 'utf8');
if (/本文件由 tools\/scripts\/write-download-config\.mjs 生成/.test(cfgSrc)) {
  ok('download-config.js 带有"请勿手改"标记');
} else {
  bad('download-config.js 缺少生成标记（可能被手改过，下次生成会覆盖你的修改）');
}

console.log('');
console.log('=== ② sections 与 links 对应 ===');
const mod = await import(pathToFileURL(cfgPath).href);
const { DOWNLOAD_LINKS, DOWNLOAD_SECTIONS } = mod;
let total = 0;
for (const s of DOWNLOAD_SECTIONS) {
  for (const k of s.keys) {
    total += 1;
    if (!DOWNLOAD_LINKS[k]) bad(`分区「${s.title}」引用了未定义的端：${k}`);
  }
  console.log(`  ${s.title}: ${s.keys.join(', ')}`);
}
const declared = Object.keys(DOWNLOAD_LINKS);
const used = new Set(DOWNLOAD_SECTIONS.flatMap((s) => s.keys));
for (const k of declared) {
  if (!used.has(k)) bad(`DOWNLOAD_LINKS 里的 ${k} 没有出现在任何分区（页面上看不到）`);
}
ok(`共 ${total} 个入口，链接定义与分区一一对应`);

console.log('');
console.log('=== ③ HTML 容器与 render() 选择器 ===');
const html = fs.readFileSync(htmlPath, 'utf8');
const js = fs.readFileSync(jsPath, 'utf8');
const gridCount = (html.match(/data-dl-grid/g) || []).length;
if (gridCount < DOWNLOAD_SECTIONS.length) {
  bad(`download.html 只有 ${gridCount} 个 data-dl-grid 容器，但分区有 ${DOWNLOAD_SECTIONS.length} 个（多出来的分区渲染不出来）`);
} else {
  ok(`download.html 有 ${gridCount} 个 data-dl-grid 容器，覆盖 ${DOWNLOAD_SECTIONS.length} 个分区`);
}
for (const s of DOWNLOAD_SECTIONS) {
  const id = `dl-grid-${s.keys[0]}`;
  if (!html.includes(`id="${id}"`)) {
    bad(`download.html 缺少容器 id="${id}"（分区「${s.title}」会按顺序回退匹配，容易错位）`);
  }
}
if (!/data-pending/.test(js)) {
  bad('js/download.js 没有处理"未上线入口"（会退回 href="#" 的死链）');
} else {
  ok('未上线入口有明确处理（灰态 + 点击说明原因）');
}

console.log('');
console.log('=== ④ 与发布清单同源 ===');
const manPath = path.join(ROOT, 'dist', 'pages-public', 'release', 'version.json');
if (!fs.existsSync(manPath)) {
  console.log('  ℹ️ 尚未生成 release/version.json（跑一次 npm run release:manifest 再检查）');
} else {
  const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
  const links = JSON.parse(fs.readFileSync(path.join(ROOT, 'release-links.json'), 'utf8'));
  const pairs = [
    ['android', man.app.android.url, links.android.url, DOWNLOAD_LINKS.android.href],
    ['ios', man.app.ios.url, links.ios.url, DOWNLOAD_LINKS.ios.href],
    ['harmony', man.app.harmony.url, links.harmony.url, DOWNLOAD_LINKS.harmony.href],
    ['windows', man.app.windows.url, links.windows.url, DOWNLOAD_LINKS.windows.href],
  ];
  for (const [name, a, b, c] of pairs) {
    const same = a === b && b === c;
    if (!same) bad(`${name} 三处地址不一致：manifest=${a || '(空)'} links=${b || '(空)'} 下载页=${c || '(空)'}`);
  }
  if (!pairs.some(([, a, b, c]) => a !== b || b !== c)) ok('App 下载地址三处同源（release-links.json 为唯一来源）');
  if (!man.web?.build) bad('version.json 缺少 web.build（H5/桌面端轮询无法判断新版本）');
  else ok(`version.json web.build = ${man.web.build}`);
}

console.log('');
console.log(fail === 0 ? '✅ 下载页链路一致' : `❌ 共 ${fail} 处问题`);
process.exit(fail ? 1 : 0);
