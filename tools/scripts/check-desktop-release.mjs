#!/usr/bin/env node
/**
 * 桌面端发布包自洽检查（latest.yml ↔ 安装包 ↔ 下载页）
 *
 * 为什么要有
 * ----------
 * 2026-10-28 线上实测发现：
 *   · `https://qtvq.cn/release/desktop/latest.yml` 里写的是 `Q问-Setup-1.0.6.exe`，公网 **404**
 *   · 真正在服务器上的是 `qtvq-desktop-Setup-1.0.6.exe`（200，82788547 字节）
 *   · 而且清单里的 size（82788539）与真实包（82788547）差 8 字节，sha512 也对不上
 * → 桌面客户端的 **自动更新从上线起就不可能成功**（读清单 → 下 404）；
 *   但下载页手动下载是好的（页面读的是 download-config.js），所以没人报障。
 *
 * 根因是"同一份事实存在两处"：
 *   ① `dist/desktop-release/latest.yml`（electron-builder 产物，本地这份其实是**对的**）
 *   ② 服务器上那份（更早一次构建的残留，某次上传只覆盖了 exe 没覆盖 yml）
 * 所以断言必须覆盖"三者指向同一个文件"：清单 → 包 → 下载页。
 *
 * 断言
 * ----
 *   1. latest.yml 可解析，含 version / url / size / sha512
 *   2. url 指向的文件在本地发布目录里存在
 *   3. 该文件 size 与 sha512 与清单一致（否则客户端校验失败，白下载几十 MB）
 *   4. app-releases.json 的 windows.downloadUrl 文件名与清单 url 一致
 *      （不一致就意味着"下载页给一个包、自动更新给另一个包"，版本一升必错）
 *   5. latest.yml 的 version 与包名里的版本号一致（防"改了版本号忘重新打包"）
 *
 * 发布目录不存在时**跳过**（不判失败）：CI 上不一定有几十 MB 的安装包，
 * 但只要有，就必须自洽。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const problems = [];
const DIRS = [path.join(ROOT, 'dist', 'desktop-release'), path.join(ROOT, 'desktop', 'release')];

const dir = DIRS.find((d) => fs.existsSync(path.join(d, 'latest.yml')));
if (!dir) {
  console.log('[check-desktop-release] ⏭️  没有 desktop/latest.yml（未打包桌面端），跳过');
  process.exit(0);
}

const ymlPath = path.join(dir, 'latest.yml');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const yml = fs.readFileSync(ymlPath, 'utf8');

const pick = (re) => {
  const m = re.exec(yml);
  return m ? m[1].trim() : '';
};

const version = pick(/^version:\s*(\S+)/m);
const url = pick(/^\s*-?\s*url:\s*(\S+)/m);
const size = Number(pick(/^\s*size:\s*(\d+)/m));
const sha512 = pick(/^\s*sha512:\s*(\S+)/m);

if (!version) problems.push(`${rel(ymlPath)} 缺少 version`);
if (!url) problems.push(`${rel(ymlPath)} 缺少 url（electron-updater 无法定位安装包）`);
if (!size) problems.push(`${rel(ymlPath)} 缺少 size`);
if (!sha512) problems.push(`${rel(ymlPath)} 缺少 sha512`);

let pkgPath = '';
if (url) {
  pkgPath = path.join(dir, decodeURIComponent(url));
  if (!fs.existsSync(pkgPath)) {
    problems.push(
      `${rel(ymlPath)} 指向 "${url}"，但 ${rel(dir)} 里没有这个文件 —— ` +
        '客户端会读到清单却下载 404（这正是线上正在发生的事）',
    );
    pkgPath = '';
  }
}

if (pkgPath) {
  const buf = fs.readFileSync(pkgPath);
  if (size && buf.length !== size) {
    problems.push(`${path.basename(pkgPath)} 实际 ${buf.length} 字节，清单写 ${size} —— 客户端校验会失败`);
  }
  if (sha512) {
    const actual = crypto.createHash('sha512').update(buf).digest('base64');
    if (actual !== sha512) {
      problems.push(
        `${path.basename(pkgPath)} 的 sha512 与清单不一致（实际 ${actual.slice(0, 16)}…，清单 ${sha512.slice(0, 16)}…）`,
      );
    }
  }
  // ⑤ 包名里的版本号与清单 version 必须一致
  const verInName = /(\d+\.\d+\.\d+)/.exec(path.basename(pkgPath));
  if (verInName && version && verInName[1] !== version) {
    problems.push(`包名里的版本 ${verInName[1]} 与 latest.yml 的 ${version} 不一致（改版本号后忘了重新打包？）`);
  }
}

// ④ 下载页（app-releases.json）与清单必须指向同一个文件名
const releasesPath = path.join(ROOT, 'app-releases.json');
if (fs.existsSync(releasesPath) && url) {
  try {
    const releases = JSON.parse(fs.readFileSync(releasesPath, 'utf8'));
    const winUrl = String(releases.windows?.downloadUrl || '');
    if (winUrl) {
      const winName = decodeURIComponent(winUrl.split('/').pop() || '');
      if (winName !== url) {
        problems.push(
          `下载页给的是 "${winName}"，自动更新清单给的是 "${url}" —— ` +
            '两个包不一致，用户手动下载与自动更新的将是不同文件',
        );
      }
    }
  } catch {
    /* JSON 坏掉由别的检查器负责，这里不重复报 */
  }
}

if (problems.length === 0) {
  console.log(`[check-desktop-release] ✅ ${rel(dir)}：latest.yml ↔ ${url} ↔ 下载页 三者一致（v${version}）`);
  process.exit(0);
}

console.error(`[check-desktop-release] ❌ ${problems.length} 处不符合：`);
for (const p of problems) console.error('  ' + p);
process.exit(1);
