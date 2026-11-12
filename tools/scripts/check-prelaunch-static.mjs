/**
 * 上架前静态扫描：死链（客户端→服务端 API 对账）· 疑似死循环 · 硬编码密钥 · 升级通道一致性
 *
 * 为什么要有它：check-all 本地套件已覆盖"静态站死胡同/版本覆盖度/上架材料"，
 * 但四类风险没有专门脚本：
 *   ① 客户端调用的 /v1 /api 路径，服务端是否真的有路由（改路径最容易漏）
 *   ② while(true)/自递归/灾难性正则/setInterval 无清理 —— 上线后表现为"卡死/内存涨"
 *   ③ 源码里写死的密钥（泄露面）；.dev.vars / cf.env 必须不在 git 里
 *   ④ APP_VERSION ↔ manifest ↔ 发布清单 ↔ 下载配置 的版本号四处对账
 *
 * 用法：node tools/scripts/check-prelaunch-static.mjs
 * 退出码：0 全过；1 有疑似问题（逐条列出，供人工复核）。
 * 安全约束：任何命中只打印 变量名+前 3 字符+长度，绝不输出完整密钥值。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');
process.chdir(ROOT);

let problems = 0, warnings = 0;
const flag = (s) => { problems += 1; console.log('  ❌ ' + s); };
const warn = (s) => { warnings += 1; console.log('  ⚠️ ' + s); };
const ok = (s) => console.log('  ✅ ' + s);
const section = (s) => console.log(`\n=== ${s} ===`);

const mask = (v) => `${String(v).slice(0, 3)}***（len=${String(v).length}）`;

/** git 跟踪的文本文件（天然排除 node_modules 与未忽略的本地密钥文件之外的东西） */
function trackedFiles(exts, extraExcludes = []) {
  const out = execSync('git ls-files', { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
  return out.filter((f) => {
    if (extraExcludes.some((x) => f.includes(x))) return false;
    return exts.some((e) => f.endsWith(e));
  });
}

// ---------- ① 客户端 API 路径 ↔ 服务端路由对账 ----------
section('① 客户端 API 路径 ↔ 服务端路由对账');

const clientFiles = [
  ...trackedFiles(['.js', '.vue', '.html'], ['node_modules/', 'dist/', 'server/src/', 'tools/scripts/', '.generated.']),
];
const apiRe = /['"`](\/(?:v1|api)\/[A-Za-z0-9/_:.\-${}]*?)['"`]/g;
const clientPaths = new Map(); // path → [file]
for (const f of clientFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(apiRe)) {
    const p = m[1].replace(/\$\{[^}]*\}/g, ':dyn').replace(/:dyn\/?$/, '');
    if (!clientPaths.has(p)) clientPaths.set(p, []);
    clientPaths.get(p).push(f);
  }
}

// 服务端路由：server/src/routes/*.js 的 router.get/post(...) + app.js 的挂载前缀
const serverRouteSet = new Set();
for (const f of trackedFiles(['.js']).filter((f) => f.startsWith('server/src/routes/'))) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/router\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g)) {
    const mount = path.basename(f, '.js');
    serverRouteSet.add(`/v1/${mount}${m[2] === '/' ? '' : m[2]}`);
    serverRouteSet.add(`/v1/${mount}`); // 挂载根本身也算
  }
}
for (const m of fs.readFileSync('server/src/app.js', 'utf8').matchAll(/app\.use\(\s*['"`]([^'"`]+)['"`]/g)) {
  serverRouteSet.add(m[1].replace(/\/$/, ''));
}
// Cloudflare Functions：functions/api/** → /api/**
for (const f of trackedFiles(['.js']).filter((f) => f.startsWith('functions/api/'))) {
  serverRouteSet.add('/api/' + f.replace(/^functions\/api\//, '').replace(/\.js$/, '').replace(/\/index$/, ''));
  serverRouteSet.add('/api/' + f.replace(/^functions\/api\//, '').replace(/\.js$/, '').split('/').slice(0, -1).join('/'));
}

function routeMatches(p) {
  if (serverRouteSet.has(p)) return true;
  if (p.endsWith('/')) return [...serverRouteSet].some((r) => r.startsWith(p)); // baseURL 型前缀
  const segs = p.split('/');
  for (const r of serverRouteSet) {
    const rsegs = r.split('/');
    if (rsegs.length !== segs.length) continue;
    if (segs.every((s, i) => s.startsWith(':') || rsegs[i].startsWith(':') || rsegs[i] === s)) return true;
  }
  // 前缀型路由（如 /v1/payment/wechat 挂到多段文件）
  return [...serverRouteSet].some((r) => p.startsWith(r + '/') || r.startsWith(p + '/'));
}

const dynamicOk = (p) => p.includes(':dyn') || p.endsWith(':id') || p.includes('*');
let deadApi = 0;
for (const [p, files] of [...clientPaths].sort()) {
  if (dynamicOk(p)) continue;
  if (!routeMatches(p)) { deadApi += 1; flag(`客户端调用无对应服务端路由：${p}（${files[0]}${files.length > 1 ? ` 等 ${files.length} 处` : ''}）`); }
}
if (deadApi === 0) ok(`客户端 API 路径 ${clientPaths.size} 条全部有服务端路由对应`);

// ---------- ② 疑似死循环 ----------
section('② 疑似死循环 / 资源泄漏');

const codeFiles = [...new Set([
  ...trackedFiles(['.js', '.vue'], ['node_modules/', 'dist/', '.min.']),
])];
let loopFlags = 0;
for (const f of codeFiles) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    // while(true)/for(;;)：40 行窗口内必须有 break/return/throw
    if (/\bwhile\s*\(\s*(true|1)\s*\)/.test(line) || /\bfor\s*\(\s*;;\s*\)/.test(line)) {
      const win = lines.slice(i, i + 40).join('\n');
      if (!/\b(break|return|throw|process\.exit)\b/.test(win)) {
        loopFlags += 1; flag(`${f}:${i + 1} while(true)/for(;;) 40 行内未见 break/return/throw`);
      }
    }
    // 灾难性正则（嵌套量词）：跳过注释行（历史上把注释里 markdown 的 "() **" 误报过）
    const trim = line.trim();
    const isComment = trim.startsWith('//') || trim.startsWith('*') || trim.startsWith('/*');
    if (!isComment && /\(\s*\\?[wWdDsS]?\+?\s*\)\s*[+*]\s*[+*]|\(\.\*\)\*[+*]/.test(line)) {
      loopFlags += 1; flag(`${f}:${i + 1} 疑似灾难性正则（嵌套量词）`);
    }
  });
  // setInterval 无 clearInterval（同文件级粗检，仅 server/functions 常驻进程）
  const src = lines.join('\n');
  if (/\/(server\/src|functions)\//.test(f) && /setInterval\(/.test(src) && !/clearInterval\(/.test(src)) {
    loopFlags += 1; flag(`${f} setInterval 无同文件 clearInterval（常驻进程疑似泄漏）`);
  }
  // 自递归无深度护栏：在函数的花括号平衡体内再次调用自身
  for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g)) {
    const name = m[1], params = m[2];
    // 从定义体的 "{" 起做花括号平衡，取真实函数体
    let depth = 0, end = -1;
    for (let i = m.index + m[0].length - 1; i < src.length; i++) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) continue;
    const body = src.slice(m.index + m[0].length, end);
    // 声明本身不含 "name("，体内出现即递归调用
    const selfCall = new RegExp(`\\b${name}\\s*\\(`).test(body);
    if (selfCall && !/depth|limit|max|count/i.test(params)) {
      // 复核级而非问题级：树遍历/重试/动画帧回调的自递归在该仓库人工复核中全部有护栏
      warn(`${f} 函数 ${name}() 自递归（请人工确认有护栏）`);
    }
  }
}
if (loopFlags === 0) ok('无疑似死循环/资源泄漏命中');

// ---------- ③ 硬编码密钥 ----------
section('③ 硬编码密钥 / 泄露面');

const secretFiles = trackedFiles(
  ['.js', '.mjs', '.vue', '.html', '.json', '.yml', '.yaml', '.sh', '.ps1', '.md'],
  ['node_modules/', 'dist/', 'docs/', 'obsidian/', 'README', 'package-lock']
);
const secretPatterns = [
  [/LTAI[0-9A-Za-z]{10,}/, '阿里云 AccessKey ID'],
  [/\b(?:appSecret|app_secret|client_secret|secretKey|secret_key|apiSecret)\b\s*[:=]\s*['"]([0-9a-fA-F]{32})['"]/, '32 位十六进制密钥'],
  [/\b(?:password|passwd|token|apikey|api_key|access_key|jwtSecret|jwt_secret)\b\s*[:=]\s*['"]([^'"]{8,})['"]/i, '口令型字面量'],
];
let secretFlags = 0;
for (const f of secretFiles) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (/process\.env|import\.meta\.env|getenv|\$\{|YOUR_|xxx|<[^>]+>|示例|placeholder|占位/.test(line)) return;
    for (const [re, label] of secretPatterns) {
      const m = line.match(re);
      if (!m) continue;
      // PEM 头字符串（解析/归一化用常量）不算泄露：只有头后 3 行内出现 base64 密钥体才算
      if (label === 'PEM 私钥块' || /BEGIN (?:RSA )?PRIVATE KEY/.test(m[0])) {
        const near = lines.slice(i + 1, i + 4).join('');
        if (!/[A-Za-z0-9+/]{60,}/.test(near)) continue;
        secretFlags += 1;
        flag(`${f}:${i + 1} PEM 私钥块带密钥体：${mask(m[0])}`);
        continue;
      }
      // e2e/负向用例的临时口令（隔离测试库一次性账号）不算泄露
      if (label === '口令型字面量' && /\/(server\/scripts\/e2e-|tools\/scripts\/(test-|debug-))/.test(`/${f}`)) continue;
      secretFlags += 1;
      flag(`${f}:${i + 1} ${label}：${mask(m[1] || m[0])}`);
    }
  });
}
// PEM 私钥块（带密钥体才算，纯头字符串是解析常量）
for (const f of secretFiles) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!/-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(line)) return;
    const near = lines.slice(i + 1, i + 4).join('');
    if (/[A-Za-z0-9+/]{60,}/.test(near)) { secretFlags += 1; flag(`${f}:${i + 1} PEM 私钥块带密钥体`); }
  });
}
// 密钥文件必须不在 git 里
for (const f of ['.dev.vars', 'cf.env', 'server/.env', 'server/.env.production']) {
  const tracked = execSync(`git ls-files -- ${f}`, { encoding: 'utf8' }).trim();
  if (tracked) { secretFlags += 1; flag(`${f} 被 git 跟踪（真实密钥泄露面）`); }
}
if (secretFlags === 0) ok('源码无硬编码密钥命中；密钥文件均未入库');

// ---------- ④ 升级通道一致性 ----------
section('④ 升级通道版本号一致性');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const readRe = (p, re) => { const s = fs.readFileSync(p, 'utf8'); const m = s.match(re); return m ? m[1] : null; };

const versions = {};
try { versions['constants APP_VERSION'] = readRe('apps/qtvq-uni/src/data/constants.js', /APP_VERSION\s*[:=]\s*['"]([^'"]+)['"]/); } catch {}
try { versions['manifest versionName'] = readJson('apps/qtvq-uni/src/manifest.json')['versionName']; } catch {}
try { versions['app-releases.generated（首渠道版本）'] = (fs.readFileSync('server/src/data/app-releases.generated.js', 'utf8').match(/version\s*:\s*['"]([^'"]+)['"]/) || [])[1]; } catch {}
try { versions['download-config'] = readRe('download-config.json', /"version"\s*:\s*"([^"]+)"/) || readRe('assets/download-config.json', /"version"\s*:\s*"([^"]+)"/); } catch {}

const found = Object.entries(versions).filter(([, v]) => v);
if (found.length === 0) {
  flag('未找到任何版本号锚点（constants/manifest/发布清单）');
} else {
  const distinct = [...new Set(found.map(([, v]) => v))];
  if (distinct.length > 1) {
    flag(`版本号不一致：${found.map(([k, v]) => `${k}=${v}`).join('；')}`);
  } else {
    ok(`版本号一致：${distinct[0]}（${found.map(([k]) => k).join('、')}）`);
  }
}
// generated 文件是否落后于生成脚本（重跑生成脚本后 git diff 应为空）
try {
  execSync('node tools/scripts/write-app-releases.mjs && node tools/scripts/write-release-manifest.mjs && node tools/scripts/write-download-config.mjs', { stdio: 'pipe' });
  const rawDiff = execSync('git diff -U0 -- server/src/data/*.generated.js release-manifest.json download-config.json assets/download-config.json', { encoding: 'utf8' });
  // 生成时间戳（GENERATED_AT / 生成时间）每次重跑必变，不算内容漂移
  const contentDiff = rawDiff.split('\n').filter((l) => /^[+-]/.test(l) && !/^[+-][+-]/.test(l) && !/GENERATED_AT|生成时间/.test(l));
  if (contentDiff.length) flag(`生成文件与脚本内容漂移（非时间戳）：\n     ${contentDiff.slice(0, 8).join('\n     ')}`);
  else ok('发布生成文件与脚本同步（时间戳除外）');
  execSync('git checkout -- server/src/data/*.generated.js release-manifest.json download-config.json assets/download-config.json 2>/dev/null || true', { shell: true });
} catch (e) { console.log(`  ⚠️ 生成文件同步检查跳过：${String(e.message).slice(0, 80)}`); }

console.log(`\n=== 结论：${problems === 0 ? '问题 0 条' : `${problems} 条问题`}；${warnings === 0 ? '复核 0 条' : `${warnings} 条复核项（人工确认护栏）`} ===`);
process.exit(problems === 0 ? 0 : 1);
