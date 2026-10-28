/**
 * uni-app x（鸿蒙原生工程）检查
 *
 * 这个工程与 `apps/qtvq-uni` 是**两套编译器**，有些错误只有真正编译才会暴露。
 * 下面这些规则全部来自 2026-09-22 的实测编译（不是文档推测）：
 *   · uvue **只支持 class 选择器** —— 写 `page { … }` 报
 *     "Selector `page` is not supported. uvue only support classname selector"；
 *   · `min-height` **只接受 number | pixel** —— 写 `100%` 报错；
 *   · 清掉这两类后 `cli launch app-harmony --compile true` 无 ERROR，并产出 .hap。
 *
 * 另外还有几条"两处必须一致"的漂移检查（本项目已因同类问题踩过坑）：
 *   · `pages.json` 的路由 ↔ 实际 `.uvue` 文件必须一一对应；
 *   · `utils/update.uts` 里的版本常量 ↔ `manifest.json` 的 versionName；
 *   · API 基址必须是自有备案域名（境外域名会被鸿蒙/小程序直接拦）。
 *
 * 用法：node tools/scripts/check-uniappx.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const APP = path.join(ROOT, 'apps', 'qtvq-uniappx');

let fail = 0;
const bad = (m) => {
  console.log(`  ❌ ${m}`);
  fail += 1;
};
const good = (m) => console.log(`  ✅ ${m}`);

if (!fs.existsSync(APP)) {
  console.log('⏭️  跳过：没有 apps/qtvq-uniappx 工程');
  process.exit(0);
}

/** pages.json 允许 // 注释（uni-app 的 jsonc 风格） */
function readJsonc(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(
    raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, ''),
  );
}

const manifest = readJsonc(path.join(APP, 'manifest.json'));
const pagesJson = readJsonc(path.join(APP, 'pages.json'));

/* ───────────────── ① 工程识别与平台配置 ───────────────── */
console.log('=== ① 工程类型与鸿蒙配置 ===');
if (manifest['uni-app-x']) good('manifest.json 含 "uni-app-x" 节点（HBuilderX 据此识别为 uni-app x 工程）');
else bad('manifest.json 缺少 "uni-app-x" 节点 —— HBuilderX 会把它当成老的 uni-app 工程');

if (manifest['app-harmony']) good('manifest.json 含 "app-harmony" 配置');
else bad('manifest.json 缺少 "app-harmony" 配置');

const bundleFile = path.join(APP, 'harmony-configs', 'AppScope', 'app.json5');
if (fs.existsSync(bundleFile)) {
  const txt = fs.readFileSync(bundleFile, 'utf8');
  const m = txt.match(/"bundleName"\s*:\s*"([^"]+)"/);
  if (m && !m[1].includes('dcloud')) good(`鸿蒙包名通过 harmony-configs 覆盖：${m[1]}`);
  else bad(`harmony-configs/AppScope/app.json5 里的 bundleName 仍是默认值或缺失（当前 ${m ? m[1] : '无'}）`);
} else {
  bad('缺少 harmony-configs/AppScope/app.json5 —— manifest 里的 bundleName 不会生效（实测被框架覆盖为 io.dcloud.uniappx）');
}

/* ───────────────── ② 路由与页面文件一一对应 ───────────────── */
console.log('');
console.log('=== ② 路由 ↔ 页面文件 ===');
const declared = (pagesJson.pages || []).map((p) => p.path);
const onDisk = [];
const walk = (dir, base = APP) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base);
    else if (e.name.endsWith('.uvue') && !p.includes('unpackage')) {
      onDisk.push(path.relative(base, p).replace(/\\/g, '/').replace(/\.uvue$/, ''));
    }
  }
};
walk(path.join(APP, 'pages'));
for (const p of declared) {
  if (!onDisk.includes(p)) bad(`pages.json 注册了 ${p}，但没有对应文件`);
}
for (const f of onDisk) {
  if (!declared.includes(f)) bad(`${f}.uvue 存在但未在 pages.json 注册（用户打不开）`);
}
if (fail === 0) good(`${declared.length} 个页面路由与文件一一对应`);

/* ───────────────── ③ uvue 样式限制（实测编译报错的两类） ───────────────── */
console.log('');
console.log('=== ③ uvue 样式限制（编译期实测）===');
const uvues = [];
const walkVue = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['unpackage', 'node_modules', 'harmony-configs'].includes(e.name)) continue;
      walkVue(p);
    } else if (e.name.endsWith('.uvue')) uvues.push(p);
  }
};
walkVue(APP);

let styleIssues = 0;
for (const f of uvues) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(APP, f).replace(/\\/g, '/');
  // ① page 选择器不被支持（只支持 class）
  if (/^\s*page\s*\{/m.test(src)) {
    bad(`${rel}: 使用了 page 选择器 —— uvue 只支持 class 选择器，请把底色交给 pages.json 的 globalStyle`);
    styleIssues += 1;
  }
  // ② min-height 不接受百分比
  const mh = src.match(/min-height\s*:\s*([^;]+);/g) || [];
  for (const decl of mh) {
    if (decl.includes('%')) {
      bad(`${rel}: ${decl.trim()} —— uvue 的 min-height 只接受 number | pixel`);
      styleIssues += 1;
    }
  }
}
if (styleIssues === 0) good(`${uvues.length} 个 .uvue 文件未使用 uvue 不支持的样式写法`);

/* ───────────────── ④ 两处必须一致的值 ───────────────── */
console.log('');
console.log('=== ④ 防漂移（同一事实两处）===');
const updateUts = path.join(APP, 'utils', 'update.uts');
if (fs.existsSync(updateUts)) {
  const txt = fs.readFileSync(updateUts, 'utf8');
  const m = txt.match(/return\s+'(\d+\.\d+\.\d+)'/);
  const ver = m ? m[1] : null;
  if (ver && ver === manifest.versionName) good(`版本号一致：manifest=${manifest.versionName} / update.uts=${ver}`);
  else bad(`版本号不一致：manifest=${manifest.versionName} / update.uts=${ver || '未找到'}（改版本必须同时改两处）`);
} else {
  bad('缺少 utils/update.uts（各端专用端口的解析实现）');
}

const apiUts = fs.existsSync(path.join(APP, 'utils', 'api.uts'))
  ? fs.readFileSync(path.join(APP, 'utils', 'api.uts'), 'utf8')
  : '';
const baseMatch = apiUts.match(/API_BASE\s*:\s*string\s*=\s*'([^']+)'/);
if (baseMatch && baseMatch[1] === 'https://qtvq.cn') good('API 基址是自有备案域名 https://qtvq.cn');
else if (baseMatch) bad(`API 基址是 ${baseMatch[1]} —— 鸿蒙/小程序的网络请求要求已备案域名，境外域名会被拦`);
else bad('utils/api.uts 里找不到 API_BASE');

/* ───────────────── ⑤ 编译产物 ───────────────── */
console.log('');
console.log('=== ⑤ 构建产物（可选，存在则报告）===');
const hapDir = path.join(APP, 'unpackage', 'dist', 'dev', 'app-harmony');
if (fs.existsSync(hapDir)) {
  const haps = [];
  const findHap = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) findHap(p);
      else if (e.name.endsWith('.hap')) haps.push(p);
    }
  };
  try {
    findHap(hapDir);
  } catch {
    /* oh_modules 里可能有坏链接，忽略 */
  }
  if (haps.length) {
    for (const h of haps) {
      const mb = (fs.statSync(h).size / 1024 / 1024).toFixed(2);
      good(`已产出 ${path.basename(h)}（${mb} MB，未签名 —— 正式签名需华为开发者证书）`);
    }
  } else {
    console.log('  ℹ️ 尚无 .hap（跑一次编译命令即可生成，见 docs 第六节）');
  }
} else {
  console.log('  ℹ️ 尚未编译过（unpackage 不存在）');
}

console.log('');
console.log(fail === 0 ? '✅ uni-app x 工程检查通过' : `❌ 共 ${fail} 处问题`);
process.exit(fail ? 1 : 0);
