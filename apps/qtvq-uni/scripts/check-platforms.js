/**
 * 全端平台覆盖检查（小程序矩阵 / H5 / App / 鸿蒙）
 *
 * 为什么需要：加一个平台要同时改**四处**（package.json 脚本、manifest.json 段、
 * utils/platform.js 的 `#ifdef` 与标题、下载页 DOWNLOAD_LINKS），
 * 只改一处不会报错，而是静默降级成「未知平台」或"下载页上写着即将上线"。
 * 这个脚本把四处对齐关系一次性核出来，并给出每个平台**缺什么**。
 *
 * 用法：node apps/qtvq-uni/scripts/check-platforms.js
 *      （或在 apps/qtvq-uni 下 npm run check:platforms）
 *
 * 退出码：0 = 全部齐备；1 = 有缺失（会逐条列出）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const SRC = path.join(APP, 'src');
const SITE = path.resolve(APP, '..', '..'); // 仓库根（静态站）

/**
 * 平台矩阵 —— 这里是唯一权威清单。
 *
 * `pkg` 是 package.json 脚本后缀，`manifest` 是 manifest.json 的键，
 * `ifdef` 是条件编译宏，`label` 是 platformLabel() 里应出现的文案。
 *
 * 关于几个"想要但没有"的平台，见文件末尾 NOT_SUPPORTED 的说明。
 */
const PLATFORMS = [
  { id: 'mp-weixin', pkg: 'mp-weixin', manifest: 'mp-weixin', ifdef: 'MP-WEIXIN', label: '微信小程序' },
  { id: 'mp-alipay', pkg: 'mp-alipay', manifest: 'mp-alipay', ifdef: 'MP-ALIPAY', label: '支付宝小程序' },
  { id: 'mp-toutiao', pkg: 'mp-toutiao', manifest: 'mp-toutiao', ifdef: 'MP-TOUTIAO', label: '抖音小程序' },
  { id: 'mp-xhs', pkg: 'mp-xhs', manifest: 'mp-xhs', ifdef: 'MP-XHS', label: '小红书小程序' },
  { id: 'mp-qq', pkg: 'mp-qq', manifest: 'mp-qq', ifdef: 'MP-QQ', label: 'QQ 小程序' },
  { id: 'mp-baidu', pkg: 'mp-baidu', manifest: 'mp-baidu', ifdef: 'MP-BAIDU', label: '百度小程序' },
  { id: 'mp-kuaishou', pkg: 'mp-kuaishou', manifest: 'mp-kuaishou', ifdef: 'MP-KUAISHOU', label: '快手小程序' },
  { id: 'mp-jd', pkg: 'mp-jd', manifest: 'mp-jd', ifdef: 'MP-JD', label: '京东小程序' },
  { id: 'h5', pkg: 'h5', manifest: 'h5', ifdef: 'H5', label: 'H5' },
  { id: 'app', pkg: 'app', manifest: 'app-plus', ifdef: 'APP-PLUS', label: 'App' },
];

/** 明确"没有对应构建目标"的平台，以及原因（避免以后有人反复问） */
const NOT_SUPPORTED = [
  ['360 小程序', 'uni-app 无 `mp-360` 构建目标；360 小程序平台已基本停运，无官方开发框架与上架入口'],
  ['淘宝/天猫小程序', 'uni-app 无官方目标；淘宝小程序需用其自有 DSL（Rax/小程序框架）单独开发'],
  ['鸿蒙原生（HarmonyOS NEXT）', 'uni-app（Vue3 线）只有 alpha 版 `@dcloudio/uni-app-harmony`；官方推荐改用 uni-app x，属独立工程'],
];

let fail = 0;
const bad = (m) => {
  console.log(`  ❌ ${m}`);
  fail += 1;
};

const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const platformSrc = fs.readFileSync(path.join(SRC, 'utils', 'platform.js'), 'utf8');

console.log('=== ① 平台矩阵四处一致性 ===');
console.log('平台'.padEnd(14) + '构建脚本  manifest  条件编译  平台文案  构建产物');
console.log('-'.repeat(78));
for (const p of PLATFORMS) {
  const hasBuild = !!pkg.scripts[`build:${p.pkg}`];
  const hasManifest = Object.prototype.hasOwnProperty.call(manifest, p.manifest);
  const hasIfdef = platformSrc.includes(`#ifdef ${p.ifdef}`) || platformSrc.includes(`|| ${p.ifdef}`);
  const hasLabel = platformSrc.includes(p.label);
  const outDir = path.join(APP, 'dist', 'build', p.id);
  const built = fs.existsSync(outDir);
  const mark = (ok) => (ok ? '   ✅   ' : '   ❌   ');
  console.log(
    p.id.padEnd(14) + mark(hasBuild) + mark(hasManifest) + mark(hasIfdef) + mark(hasLabel) + mark(built),
  );
  if (!hasBuild) bad(`${p.id}: package.json 缺少 build:${p.pkg} 脚本`);
  if (!hasManifest) bad(`${p.id}: manifest.json 缺少 "${p.manifest}" 段`);
  if (!hasIfdef) bad(`${p.id}: utils/platform.js 缺少 #ifdef ${p.ifdef} 分支（该平台会显示「未知」）`);
  if (!hasLabel) bad(`${p.id}: utils/platform.js 的 platformLabel() 缺少「${p.label}」`);
}

console.log('');
console.log('=== ② 各小程序平台 appid 配置状态（留空=还不能上传，需业务方到各平台申请）===');
for (const p of PLATFORMS) {
  if (!p.id.startsWith('mp-')) continue;
  const section = manifest[p.manifest] || {};
  const appid = section.appid || '';
  console.log(`  ${p.id.padEnd(14)} ${appid ? `✅ ${appid}` : '❌ 未填写 appid'}`);
}

console.log('');
console.log('=== ③ 自动更新能力 ===');
const updateNeedles = [
  ['小程序热更新（uni.getUpdateManager）', /getUpdateManager/],
  ['App 版本检查（plus.runtime / 版本接口）', /plus\.runtime|checkAppUpdate|checkUpdate/],
  ['H5 版本轮询', /checkH5Update|version\.json/],
];
const allSrc = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f);
    else if (/\.(js|vue|json)$/.test(e.name)) allSrc.push(fs.readFileSync(f, 'utf8'));
  }
};
walk(SRC);
const blob = allSrc.join('\n');
for (const [name, re] of updateNeedles) {
  const ok = re.test(blob);
  console.log(`  ${ok ? '✅' : '❌'} ${name}`);
  if (!ok) bad(`缺少自动更新能力：${name}`);
}

console.log('');
console.log('=== ④ 下载页清单（js/download-config.js）===');
const dlPath = path.join(SITE, 'js', 'download-config.js');
if (!fs.existsSync(dlPath)) {
  bad(`找不到 ${path.relative(SITE, dlPath)}`);
} else {
  const dl = fs.readFileSync(dlPath, 'utf8');
  for (const p of PLATFORMS) {
    if (!dl.includes(`${p.pkg}:`) && !dl.includes(`${p.id}:`)) {
      // 小程序矩阵在下载页里通常按渠道聚合成 weixin/alipay/douyin…，这里只做提示不算失败
      console.log(`  ℹ️ 下载页未单独列出 ${p.id}（小程序矩阵通常合并展示）`);
    }
  }
  for (const m of dl.matchAll(/(\w+):\s*\{[^}]*href:\s*'([^']*)'/g)) {
    console.log(`  ${m[2] ? '✅' : '⚠️ 空'} ${m[1]}  ${m[2] || '(尚未填写上线链接)'}`);
  }
}

console.log('');
console.log('=== ⑤ 明确不支持的平台（写在这里，避免反复问）===');
for (const [name, why] of NOT_SUPPORTED) console.log(`  · ${name} —— ${why}`);

console.log('');
console.log(fail === 0 ? '✅ 平台矩阵检查通过' : `❌ 共 ${fail} 处需要补齐`);
process.exit(fail ? 1 : 0);
