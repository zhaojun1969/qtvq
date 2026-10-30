#!/usr/bin/env node
/**
 * 桌面壳（Electron）静态检查
 *
 * 为什么要有：桌面端的坑全是"代码在、但没生效"这一类，肉眼看不出来 ——
 *   · 托盘代码写了，图标却指向 build/ 目录，而 build/ 不在 electron-builder 的
 *     files 白名单里 → 打包后托盘**从来没出现过**，`setupTray()` 静默 return；
 *   · preload 用 process.env 传版本号，sandbox 下拿不到 → 菜单里版本号是空的；
 *   · 导航校验用 startsWith('https://qtvq.cn')，`https://qtvq.cn.evil.com` 能过。
 * 这些都不会报错、不会崩，只会"功能悄悄不存在"。所以必须靠断言盯住。
 *
 * 用法：
 *   node tools/scripts/check-desktop-shell.mjs            # 检查仓库里的 desktop/
 *   node tools/scripts/check-desktop-shell.mjs --root X   # 检查副本（用于负向测试）
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const rootArg = argv.indexOf('--root');
const ROOT = rootArg > -1 ? path.resolve(argv[rootArg + 1]) : process.cwd();
const DESKTOP = path.join(ROOT, 'desktop');

let pass = 0;
const fails = [];
function ok(msg) {
  pass++;
  console.log(`  ✓ ${msg}`);
}
function bad(msg) {
  fails.push(msg);
  console.log(`  ✗ ${msg}`);
}
function assert(cond, msg) {
  cond ? ok(msg) : bad(msg);
}

const read = (rel) => {
  const p = path.join(DESKTOP, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
};

/** 剥掉注释：注释里写 "nodeIntegration: false" 不能算数 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

console.log('[check-desktop-shell] 桌面壳静态检查');

/* ── 0. 基本结构 ── */
assert(fs.existsSync(path.join(DESKTOP, 'package.json')), 'desktop/package.json 存在');
const pkgRaw = read('package.json');
let pkg = null;
try {
  pkg = JSON.parse(pkgRaw);
  ok('desktop/package.json 可解析');
} catch (e) {
  bad(`desktop/package.json 解析失败：${e.message}`);
}
const mainSrc = stripComments(read('src/main.js'));
const preloadSrc = stripComments(read('preload/index.js'));
assert(mainSrc.length > 2000, 'src/main.js 存在且非空');
assert(preloadSrc.length > 200, 'preload/index.js 存在且非空');

/* ── 1. 不再内嵌 H5 快照 ── */
assert(!/loadFile\s*\(/.test(mainSrc), '主进程不加载本地文件（界面即线上站，避免出现第三份 UI）');
const filesList = pkg?.build?.files || [];
assert(
  !filesList.some((f) => /(^|\/)web(\/|$)/.test(f)),
  'electron-builder files 不包含 web/（防止旧 H5 快照被当成主路径打回包里）',
);

/* ── 2. 渲染进程沙箱 ── */
assert(/contextIsolation:\s*true/.test(mainSrc), 'contextIsolation: true');
assert(/nodeIntegration:\s*false/.test(mainSrc), 'nodeIntegration: false');
assert(/sandbox:\s*true/.test(mainSrc), 'sandbox: true');
assert(!/webSecurity:\s*false/.test(mainSrc), '没有关闭 webSecurity');
assert(!/allowRunningInsecureContent:\s*true/.test(mainSrc), '没有 allowRunningInsecureContent');

/* ── 3. preload 暴露面 ── */
const bridgeBody = preloadSrc.slice(preloadSrc.indexOf('exposeInMainWorld'));
const exposedKeys = [...bridgeBody.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1]);
const ALLOWED_KEYS = new Set([
  'isDesktop',
  'platform',
  'shellVersion',
  'isPortable',
  'openExternal',
  'checkForUpdates',
]);
const extra = exposedKeys.filter((k) => !ALLOWED_KEYS.has(k));
assert(extra.length === 0, `preload 暴露面只在白名单内${extra.length ? `（越界：${extra.join(',')}）` : ''}`);
assert(
  !/exposeInMainWorld\([^)]*ipcRenderer\s*\)/.test(preloadSrc),
  '没有把 ipcRenderer 原始对象交给页面',
);
assert(
  !/\brequire\s*:\s*\(/.test(preloadSrc),
  '没有向页面转发 require（那等于把 Node 还回去）',
);

/* ── 4. 版本号通道 ── */
assert(/ipcMain\.on\('qtvq:get-info'/.test(mainSrc), '主进程注册了 qtvq:get-info');
assert(/sendSync\('qtvq:get-info'\)/.test(preloadSrc), 'preload 用 sendSync 取版本（不依赖 process.env）');
assert(
  /readShellVersion|SHELL_VERSION/.test(mainSrc),
  '壳版本有 package.json 兜底（app.getVersion 在非 `electron .` 入口会返回 Electron 版本）',
);

/* ── 5. Windows 系统集成 ── */
assert(/setAppUserModelId/.test(mainSrc), '设置了 AppUserModelId（否则通知不出、任务栏双图标）');
assert(/requestSingleInstanceLock/.test(mainSrc), '单实例锁');
assert(/render-process-gone/.test(mainSrc), '渲染进程崩溃有恢复处理');
assert(/unresponsive/.test(mainSrc), '界面无响应有提示');

/* ── 6. 托盘图标必须真能被打进包 ── */
const trayCandidates = ['src/assets/tray.png', 'src/assets/tray.ico'];
const trayFound = trayCandidates.find((f) => fs.existsSync(path.join(DESKTOP, f)));
assert(Boolean(trayFound), `托盘图标在 src/assets/ 下且真实存在（找到：${trayFound || '无'}）`);
assert(
  filesList.some((f) => /src\/\*\*/.test(f)),
  'electron-builder files 包含 src/**（托盘图标随它一起打包；放 build/ 是打不进去的）',
);
assert(
  !/join\(__dirname,\s*'\.\.',\s*'build'/.test(mainSrc),
  '没有从 build/ 读运行时资源（build/ 只在编译期用，不进包）',
);

/* ── 7. 导航校验必须按主机名精确匹配 ── */
assert(
  !/(will-navigate|setWindowOpenHandler)[\s\S]{0,400}startsWith\(/.test(mainSrc),
  '导航判定不用 startsWith（前缀匹配会被 qtvq.cn.evil.com 绕过）',
);
assert(/new URL\(/.test(mainSrc) && /TRUSTED_HOSTS/.test(mainSrc), '导航用 URL 解析 + 主机名白名单');

/* ── 8. 权限白名单 ── */
assert(/setPermissionRequestHandler/.test(mainSrc), '设置了权限请求处理');
assert(/setPermissionCheckHandler/.test(mainSrc), '设置了权限查询处理（只设 request 会留下哑状态）');
assert(
  !/ALLOWED[^\n]*'geolocation'/.test(mainSrc),
  '权限白名单不含 geolocation（本产品不需要定位）',
);

/* ── 9. 免安装版与更新 ── */
assert(/PORTABLE_EXECUTABLE_DIR/.test(mainSrc), '识别免安装版（portable 无法被 NSIS 更新流程覆盖）');
assert(
  /IS_PORTABLE\)\s*\{[\s\S]{0,200}return/.test(mainSrc),
  '免安装版直接跳过 electron-updater',
);
assert(/autoUpdater/.test(mainSrc), '接了 electron-updater');
assert(
  pkg?.dependencies?.['electron-updater'] && !pkg?.devDependencies?.['electron-updater'],
  'electron-updater 在 dependencies（devDependencies 不会被打进包）',
);
assert(
  Boolean(pkg?.devDependencies?.electron) && Boolean(pkg?.devDependencies?.['electron-builder']),
  'electron / electron-builder 在 devDependencies',
);

/* ── 10. 打包图标 ── */
const iconRel = pkg?.build?.win?.icon || '';
const iconAbs = iconRel ? path.join(DESKTOP, iconRel) : '';
assert(Boolean(iconRel) && fs.existsSync(iconAbs), `win.icon 指向真实文件（${iconRel || '未配置'}）`);

/* ── 11. 冒烟测试可跑 ── */
assert(fs.existsSync(path.join(DESKTOP, 'scripts/smoke.js')), '有运行时冒烟脚本 scripts/smoke.js');
assert(Boolean(pkg?.scripts?.smoke), 'package.json 注册了 smoke 脚本');

/* ── 12. 冒烟脚本本身别写成"永远通过" ── */
const smokeSrc = read('scripts/smoke.js');
assert(/CORS_OR_NETWORK|apiStatus/.test(smokeSrc), '冒烟脚本真的探测了接口');
assert(/app\.exit\(5\)|finish\(5/.test(smokeSrc), '冒烟失败会返回非零退出码');

console.log('');
if (fails.length) {
  console.log(`[check-desktop-shell] ❌ ${fails.length} 项未通过（通过 ${pass} 项）`);
  for (const f of fails) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`[check-desktop-shell] ✅ 全部通过（${pass} 项）`);
