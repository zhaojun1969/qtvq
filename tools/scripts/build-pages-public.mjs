#!/usr/bin/env node
/**
 * 构建 Cloudflare Pages 白名单发布目录（本项目公网可见内容的唯一权威来源）
 *
 * 为什么需要它（2026-09-13 事件复盘）：
 *   部署脚本原本执行 `wrangler pages deploy .`，而 wrangler.toml 里 pages_build_output_dir = "."
 *   —— 整个仓库根目录被当作 Pages 站点发布，导致下列内容在 https://qtvq-api.pages.dev 上匿名可读：
 *     cf.env / obs.env            Cloudflare API Token、阿里云 OSS AK/SK
 *     .dev.vars、server/.env      ADMIN_KEY / SMTP_PASS / MONGO_URI / 模型密钥
 *     context/、tmp-chat.json     内部路线图与对话导出
 *     README.md / package.json / apps/** 源码
 *   注意 .assetsignore 在 wrangler 4.98 的 Pages 部署路径上**实测不生效**（连它自己都会被发布），
 *   所以这里不用排除法，只用显式白名单。
 *
 *   另注：Pages 对非 HTML 资源默认 `cache-control: public, s-maxage=604800`，
 *   文件即使从新部署中移除，边缘缓存仍可能继续供应最长 7 天 —— 所以密钥泄露必须轮换，
 *   只删文件只是止血。
 *
 * 用法：
 *   node tools/scripts/build-pages-public.mjs                 # 输出到 dist/pages-public
 *   node tools/scripts/build-pages-public.mjs --out <目录>
 *
 * 本文件是白名单的**唯一实现**；tools/scripts/build-pages-public.ps1 只是它的薄封装，
 * deploy-api.sh（Linux）直接调用本文件。改白名单只改这里。
 */
import { existsSync, mkdirSync, rmSync, cpSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
const ROOT = resolve(HERE, '..', '..');

// ---- 允许公开的根文件 ----
const ALLOW_ROOT_FILES = ['robots.txt', 'sitemap.xml', '_headers', '_redirects'];
// ---- 允许公开的根目录（functions/ 是 API 本体，必须发布）----
const ALLOW_DIRS = ['js', 'css', 'assets', 'logo', 'functions'];
// ---- tools/ 下允许公开的文件（工作人员核实页）----
const ALLOW_TOOLS = ['verify-payment.html'];

// ---- 发布前闸门：命中即中止，绝不把可疑文件推上公网 ----
const FORBIDDEN_NAME = /\.env$|\.env\.|^\.env|\.pem$|\.key$|\.p12$|\.pfx$|dev\.vars|secret|credential|\.tgz$|\.zip$|\.bak$/i;
// 私钥规则要求"头部 + 足够长的 base64 主体"，避免误伤 functions/lib/wechat-crypto.js 的解析字面量
const FORBIDDEN_CONTENT = /cfut_[A-Za-z0-9]{20}|LTAI[A-Za-z0-9]{12,}|gho_[A-Za-z0-9]{20}|ADMIN_KEY\s*=\s*\S|JWT_SECRET\s*=\s*\S|mongodb(\+srv)?:\/\/[^"\s]*:[^"\s]*@|-----BEGIN [A-Z ]*PRIVATE KEY-----[^\n]*[A-Za-z0-9+/=]{40,}/;

// ---- 关键文件必须在场：少一个都会让线上功能或安全配置坏掉 ----
const MUST_HAVE = [
  'functions/api/payment.js',
  'functions/lib/order-store.js',
  'functions/lib/wechat-crypto.js',
  '_headers',
  '_redirects',
  'index.html',
  'js/config.js',
  'css/styles.css',
  'tools/verify-payment.html',
];

function parseArgs(argv) {
  let out = join(ROOT, 'dist', 'pages-public');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) out = resolve(process.cwd(), argv[++i]);
  }
  return { out };
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

function main() {
  const { out } = parseArgs(process.argv.slice(2));

  if (existsSync(out)) rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  console.log('>> 复制白名单内容 -> ' + out);

  // 根目录下的 *.html
  for (const name of readdirSync(ROOT)) {
    if (!name.endsWith('.html')) continue;
    const src = join(ROOT, name);
    if (statSync(src).isFile()) cpSync(src, join(out, name));
  }
  for (const name of ALLOW_ROOT_FILES) {
    if (!existsSync(join(ROOT, name))) continue;
    cpSync(join(ROOT, name), join(out, name));
  }
  for (const dir of ALLOW_DIRS) {
    const src = join(ROOT, dir);
    if (!existsSync(src)) {
      console.error('缺少必要目录: ' + dir);
      process.exit(1);
    }
    cpSync(src, join(out, dir), { recursive: true });
  }
  mkdirSync(join(out, 'tools'), { recursive: true });
  for (const f of ALLOW_TOOLS) {
    const src = join(ROOT, 'tools', f);
    if (!existsSync(src)) {
      console.error('缺少必要文件: ' + relative(ROOT, src));
      process.exit(1);
    }
    cpSync(src, join(out, 'tools', f));
  }

  console.log('>> 发布前敏感检查');
  const files = walk(out);
  const bad = [];
  for (const f of files) {
    const name = f.split(sep).pop();
    if (FORBIDDEN_NAME.test(name)) bad.push('名称命中: ' + relative(ROOT, f));
    const text = readFileSync(f, 'utf8');
    if (text.includes('\u0000')) continue; // 二进制跳过内容检查
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (FORBIDDEN_CONTENT.test(line)) bad.push('内容命中: ' + relative(ROOT, f) + ':' + (i + 1));
    });
  }
  if (bad.length > 0) {
    console.error('拒绝发布 —— 命中敏感规则：');
    for (const b of bad) console.error('  ' + b);
    process.exit(1);
  }
  for (const m of MUST_HAVE) {
    if (!existsSync(join(out, m))) {
      console.error('关键文件缺失: ' + m);
      process.exit(1);
    }
  }

  console.log('   文件数 ' + files.length + '，敏感规则 0 命中');
  console.log('   输出目录 ' + out);
  console.log('   提示：/api/* 的 no-store 由 _headers 提供，务必保留该文件');
}

main();
