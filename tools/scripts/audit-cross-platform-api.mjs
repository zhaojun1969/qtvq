/**
 * 跨端 API 连接审计（E.83）
 *
 * 覆盖：服务端 API 面（Node /v1 + CF Functions /api）↔ 七类消费端
 *   ① Web 主站（js/*.js + *.html 内联）          ② 桌面（desktop/src，加载主站）
 *   ③ 鸿蒙 uni-app x（apps/qtvq-uniappx *.uts/.uvue）
 *   ④ 小程序 8 端 + H5 + App（apps/qtvq-uni/src *.js/.vue —— 同一份代码多端编译）
 *   ⑤ Android/iOS/Capacitor 类壳 = ④ 同包（app-plus webview，基址 qtvq.cn）
 *
 * 三项检查：
 *   A. 客户端引用端点 ↔ 服务端路由 交叉比对（找调用不存在接口的端）
 *   B. CORS：跨域直接调用面（qtvq.cn 页面 → Pages 域 /api/*）实测响应头
 *   C. 连通性：按端基址实测关键端点（匿名约定：401/400=活着，200=开放，404=死）
 *
 * 用法：node tools/scripts/audit-cross-platform-api.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

process.chdir(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..'));

const P = (s) => console.log(s);
let problems = 0;
const bad = (m) => { problems += 1; P('  ❌ ' + m); };
const ok = (m) => P('  ✅ ' + m);
const note = (m) => P('  ℹ️  ' + m);

const tracked = (exts, dirs) => execSync('git ls-files', { encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter(Boolean)
  .filter((f) => dirs.some((d) => f.startsWith(d)) && exts.some((e) => f.endsWith(e)));

/* ---------- A1. 服务端路由面 ---------- */
const nodeRoutes = new Set();
// app.js：import 变量名 ↔ 路由文件、app.use(前缀, 变量名) ↔ 挂载前缀，正确配对（E.83）
const appJs = fs.readFileSync('server/src/app.js', 'utf8');
const varToFile = new Map();
for (const m of appJs.matchAll(/import\s+(\w+)\s+from\s+['"]\.\/routes\/([\w-]+)\.js['"]/g)) {
  varToFile.set(m[1], m[2]);
}
const varToPrefix = new Map();
for (const m of appJs.matchAll(/app\.use\(\s*['"`]([^'"`]+)['"`]\s*,\s*(\w+)\s*\)/g)) {
  if (varToFile.has(m[2])) varToPrefix.set(m[2], m[1].replace(/\/$/, ''));
}
const routeFiles = tracked(['.js'], ['server/src/routes/']);
for (const f of routeFiles) {
  const name = path.basename(f, '.js');
  const src = fs.readFileSync(f, 'utf8');
  const vn = [...varToFile.entries()].find(([, file]) => file === name)?.[0];
  const prefix = (vn && varToPrefix.get(vn)) || `/v1/${name}`;
  for (const m of src.matchAll(/router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g)) {
    let sub = m[2] === '/' ? '' : m[2];
    sub = sub.replace(/:([A-Za-z]+)/g, ':param');
    nodeRoutes.add(`${m[1].toUpperCase()} ${prefix}${sub}`);
  }
}
// functions/api/** → /api/**（文件树即路由；auth.js 上的 action 子路由另在 auth/ 目录）
const fnRoutes = new Set();
for (const f of tracked(['.js'], ['functions/api/'])) {
  const p = f.replace(/^functions\/api\//, '').replace(/\.js$/, '').replace(/\/index$/, '');
  fnRoutes.add('POST /api/' + p);
  fnRoutes.add('GET /api/' + p);
}

/* ---------- A2. 各端客户端端点提取 ---------- */
function extractPaths(files, label) {
  const paths = new Map(); // path → file
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/['"`](\/(?:v1|api)\/[A-Za-z0-9/_:.$\-*{}][^'"`\s]*)['"`]/g)) {
      const norm = m[1].replace(/\$\{[^}]*\}/g, ':param').replace(/\/:param\/?$/, '/:param').replace(/\?.*$/, '');
      if (!paths.has(norm)) paths.set(norm, f);
    }
  }
  return { paths, label };
}

const webFiles = tracked(['.js', '.html'], ['js/', 'server/public/']).filter((f) => !f.includes('config.js'));
const miniFiles = tracked(['.js', '.vue'], ['apps/qtvq-uni/src/']);
const harmonyFiles = tracked(['.uts', '.uvue'], ['apps/qtvq-uniappx/']);
const desktopFiles = tracked(['.js'], ['desktop/src/']);

const groups = [
  extractPaths(webFiles, 'Web 主站'),
  extractPaths(miniFiles, '小程序8端/H5/App'),
  extractPaths(harmonyFiles, '鸿蒙 uniappx'),
  extractPaths(desktopFiles, '桌面壳'),
];

function routeMatches(set, method, p) {
  const segs = p.split('/').map((s) => (s.startsWith(':') ? ':param' : s));
  for (const r of set) {
    const [rm, rp] = r.split(' ');
    const rsegs = rp.split('/').map((s) => (s.startsWith(':') ? ':param' : s));
    if (rsegs.length !== segs.length) continue;
    if (segs.every((s, i) => s === ':param' || rsegs[i] === s || rsegs[i].startsWith(':'))) return { route: r, method: rm };
  }
  // 前缀型（/api/payment/wechat/auth 多段文件树）
  for (const r of set) {
    const rp = r.split(' ')[1];
    if (p.startsWith(rp + '/') || rp.startsWith(p + '/')) return { route: r, method: r.split(' ')[0] };
  }
  return null;
}

P('=== A. 客户端端点 ↔ 服务端路由 交叉比对 ===');
let totalRefs = 0, missing = 0;
for (const { paths, label } of groups) {
  P(`\n[${label}] ${paths.size} 条引用`);
  for (const [p, file] of [...paths].sort()) {
    totalRefs += 1;
    // 该路径应由哪个面服务：/v1→Node；/api→Functions（qtvq.cn 同源/nginx 均反代）
    const surface = p.startsWith('/v1') ? nodeRoutes : fnRoutes;
    const hit = routeMatches(surface, 'GET', p);
    if (!hit) {
      // /api/* 在 Node 侧也有镜像（nginx /api→Pages，但部分 /api 亦在 Node routes）
      const hit2 = routeMatches(nodeRoutes, 'GET', p);
      if (!hit2) {
        missing += 1;
        bad(`${label} 调用无服务端路由：${p}  (${path.basename(file)})`);
        continue;
      }
    }
    P(`  · ${p} ✓`);
  }
}
if (missing === 0) ok(`\n交叉比对：${totalRefs} 条引用全部有服务端路由`);

/* ---------- B. CORS 实测（跨域直连面） ---------- */
P('\n=== B. CORS 实测（Origin: qtvq.cn → Pages 域 /api） ===');
const corsTargets = [
  'https://api.qtvq.cn/api/health',
  'https://qtvq-api.pages.dev/api/health',
];
for (const url of corsTargets) {
  try {
    const res = await fetch(url, { headers: { Origin: 'https://qtvq.cn' }, signal: AbortSignal.timeout(8000) });
    const acao = res.headers.get('access-control-Allow-origin');
    const acam = res.headers.get('access-control-allow-methods');
    P(`  · ${new URL(url).host} → HTTP ${res.status}  ACAO=${acao || '无'} ${acam ? 'ACAM=' + acam.slice(0, 30) : ''}`);
    if (!acao) bad(`CORS 缺失：${url} 无 Access-Control-Allow-Origin（直连模式浏览器会拒收）`);
  } catch (e) { bad(`CORS 探测失败 ${url}: ${String(e.message).slice(0, 60)}`); }
}
// 同源 /v1 不需要 CORS（现在强制同源），但 nginx 反代响应头确认不误伤
try {
  const res = await fetch('https://qtvq.cn/v1/wallet', { headers: { Origin: 'https://evil.example' }, signal: AbortSignal.timeout(8000) });
  const acao = res.headers.get('access-control-allow-origin');
  P(`  · qtvq.cn /v1（恶意 Origin）→ HTTP ${res.status} ACAO=${acao || '无'}`);
  if (acao && acao.includes('evil')) bad('/v1 对任意 Origin 放行 CORS');
  else ok('/v1 不对陌生 Origin 发放 CORS（同源策略兜底）');
} catch (e) { note('/v1 CORS 反向探测网络失败：' + String(e.message).slice(0, 50)); }

/* ---------- C. 连通性实测（按消费端基址） ---------- */
P('\n=== C. 连通性实测（匿名约定：401/400=活着 200=开放 404=死路由） ===');
const bases = {
  'Web同源(qtvq.cn)': 'https://qtvq.cn',
  'Web直连(pages.dev)': 'https://qtvq-api.pages.dev',
  '小程序/鸿蒙/App(qtvq.cn)': 'https://qtvq.cn',
};
const probes = [
  ['GET', '/api/health', 200],
  ['GET', '/api/auth/me', 401],
  ['GET', '/v1/health', 200],
  ['GET', '/v1/wallet', 401],
  ['POST', '/v1/contact/reveal', 401],
  ['GET', '/v1/report/skus', 401], // requireAuth+requireAdult，匿名 401 正确
];
const seenBase = new Set();
for (const [baseName, base] of Object.entries(bases)) {
  for (const [method, p, expect] of probes) {
    // pages.dev 没有 /v1（本审计 A 已确认这是设计）——只探 /api
    if (baseName.includes('pages.dev') && p.startsWith('/v1')) continue;
    seenBase.add(baseName + p);
    try {
      const res = await fetch(base + p, {
        method,
        headers: { 'Content-Type': 'application/json', Origin: 'https://qtvq.cn' },
        body: method === 'POST' ? '{}' : undefined,
        signal: AbortSignal.timeout(8000),
      });
      const mark = res.status === expect ? '✅' : (res.status === 405 ? '⚠️' : '❌');
      if (mark === '❌') bad(`${baseName} ${p} → HTTP ${res.status}（期望 ${expect}）`);
      else P(`  ${mark} ${baseName} ${p} → ${res.status}`);
    } catch (e) { bad(`${baseName} ${p} → 网络 ${String(e.message).slice(0, 50)}`); }
  }
}

P(`\n=== 结论：交叉比对 ${totalRefs} 条 / 缺失 ${missing}；CORS 与连通性见上（❌ 计 ${problems} 条） ===`);
process.exit(problems === 0 ? 0 : 1);
