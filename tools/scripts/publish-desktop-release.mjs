/**
 * 把桌面客户端的发布产物**整理到一个待上传目录**：`dist/desktop-release/`
 *
 * 为什么不是放进静态站包里：安装包 ~79MB，静态站每次发布都要重新打个大包、传一遍，
 * 而且浏览器访问静态站并不需要这个 exe。所以拆开：
 *   · `release/version.json`（几百字节）→ 随静态站走，供各端判断版本；
 *   · 安装包 + latest.yml（几十 MB）→ 由 tools/scripts/upload-desktop-ssh.ps1 单独传到
 *     服务器的 `/var/www/qtvq/release/desktop/`，下载地址即 `https://qtvq.cn/release/desktop/...`
 *     （OSS 桶是私有的、匿名 403，不能直接当下载源；自家已备案域名最省事也最可信）。
 *
 * 产物构成：
 *   latest.yml                     ← electron-updater 的版本清单（含 sha512，客户端据此校验完整性）
 *   Q问-Setup-<ver>.exe            ← 安装版
 *   Q问-Setup-<ver>.exe.blockmap   ← 差分更新用（有它才不用整包重下）
 *   Q问-Portable-<ver>.exe         ← 免安装版
 *
 * 用法：node tools/scripts/publish-desktop-release.mjs
 *   之后：npm run desktop:upload（或 tools/scripts/upload-desktop-ssh.ps1）
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'desktop', 'release');
const DEST = path.join(ROOT, 'dist', 'desktop-release');

if (!fs.existsSync(SRC)) {
  console.error(`ERROR: 找不到桌面端产物目录 ${path.relative(ROOT, SRC)}`);
  console.error('  先构建：cd desktop && npm run dist');
  process.exit(1);
}

const latest = path.join(SRC, 'latest.yml');
if (!fs.existsSync(latest)) {
  console.error('ERROR: 缺少 latest.yml —— electron-updater 的自动更新清单，没有它客户端无法判断新版本。');
  console.error('  检查 desktop/package.json 是否配置了 publish（generic + https://qtvq.cn/release/desktop/）。');
  process.exit(1);
}

/* latest.yml 里含 sha512 与文件大小，客户端据此校验下载完整性。
 * 顺手校验"清单里提到的文件是否真的存在"：否则会发布一个指向不存在文件的清单，
 * 客户端只会一直更新失败，而服务端看不出任何异常。 */
const yml = fs.readFileSync(latest, 'utf8');
const files = [...yml.matchAll(/^\s*(?:path|url):\s*(.+)$/gm)].map((m) => m[1].trim());
const missing = files.filter((f) => f && !fs.existsSync(path.join(SRC, f)));
if (missing.length) {
  console.error(`ERROR: latest.yml 引用了不存在的文件：${missing.join(', ')}`);
  process.exit(1);
}

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });

// 只搬发布需要的：排除 win-unpacked（几百 MB 目录树）、builder-debug.yml（含本机路径，不该公开）
const KEEP = /\.(exe|yml|blockmap)$/i;
const SKIP = /^builder-debug\.yml$/i;
const moved = [];
for (const name of fs.readdirSync(SRC)) {
  const src = path.join(SRC, name);
  if (!fs.statSync(src).isFile()) continue;
  if (!KEEP.test(name) || SKIP.test(name)) continue;
  fs.copyFileSync(src, path.join(DEST, name));
  moved.push({ name, size: fs.statSync(src).size });
}

const total = moved.reduce((s, m) => s + m.size, 0);
console.log(`>> 待上传目录：${path.relative(ROOT, DEST)}（合计 ${(total / 1024 / 1024).toFixed(1)} MB）`);
for (const m of moved) console.log(`   ${m.name}  ${(m.size / 1024 / 1024).toFixed(2)} MB`);
console.log('');
console.log('   客户端自动更新地址：https://qtvq.cn/release/desktop/latest.yml');
console.log('   下一步：npm run desktop:upload');
