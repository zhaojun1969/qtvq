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
/*
 * 产物可能在两个位置：
 *   · desktop/release          —— electron-builder 默认输出
 *   · dist/desktop-release     —— build.directories.output 指到这里的配置（当前采用）
 * 之所以后者更实用：dist/desktop-release 就是上传脚本读的目录，省一次拷贝；
 * 另外 desktop/release 曾出现过 app.asar 被句柄锁住、连删都删不掉的情况。
 */
const LEGACY = path.join(ROOT, 'desktop', 'release');
const OUT = path.join(ROOT, 'dist', 'desktop-release');
const SRC = fs.existsSync(path.join(LEGACY, 'latest.yml')) ? LEGACY : OUT;
const DEST = OUT;
const SAME_DIR = path.resolve(SRC) === path.resolve(DEST);

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

if (!SAME_DIR) fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });

// 只搬发布需要的：排除 win-unpacked（几百 MB 目录树）、builder-debug.yml（含本机路径，不该公开）
const KEEP = /\.(exe|yml|blockmap)$/i;
const SKIP = /^builder-debug\.yml$/i;
const moved = [];
for (const name of fs.readdirSync(SRC)) {
  const src = path.join(SRC, name);
  if (!fs.statSync(src).isFile()) continue;
  if (!KEEP.test(name) || SKIP.test(name)) continue;
  if (!SAME_DIR) fs.copyFileSync(src, path.join(DEST, name));
  moved.push({ name, size: fs.statSync(src).size });
}

/*
 * builder-debug.yml 含本机绝对路径（D:\qtvq\desktop\...）与构建机信息，
 * 不该出现在公网下载目录。2026-10-30 就因为这个文件被一起上传，
 * https://qtvq.cn/release/desktop/builder-debug.yml 一度可以匿名下载。
 * SAME_DIR 模式下没有走"清空 DEST"，所以这里要单独兜一次。
 */
for (const junk of ['builder-debug.yml']) {
  const p = path.join(DEST, junk);
  if (fs.existsSync(p)) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* 删不掉就报警，但不阻断发布 */
      console.warn(`WARN: 无法删除 ${junk}，上传前请手动移除（否则本机路径会公开）`);
    }
  }
}

const total = moved.reduce((s, m) => s + m.size, 0);console.log(`>> 待上传目录：${path.relative(ROOT, DEST)}（合计 ${(total / 1024 / 1024).toFixed(1)} MB）`);
for (const m of moved) console.log(`   ${m.name}  ${(m.size / 1024 / 1024).toFixed(2)} MB`);
console.log('');
console.log('   客户端自动更新地址：https://qtvq.cn/release/desktop/latest.yml');
console.log('   下一步：npm run desktop:upload');
