#!/usr/bin/env node
/**
 * 各端发布记录覆盖度（统一升级的"台账"检查）
 *
 * 为什么要有
 * ----------
 * 2026-10-28 排查"各端能否统一升级"时发现的真实状况：
 *   `server/src/lib/app-release-core.js` 里声明了 **14 个渠道**，
 *   而 `app-releases.json` 只登记了 **3 个**（windows / wechat / web）。
 *   剩下 11 个渠道走兜底 `DEFAULT_RELEASE = 1.0.0`，于是线上 `GET /api/app/bootstrap?channel=kuaishou`
 *   对客户端真实的 1.0.6 回了一句 `latest: "1.0.0"`、`reason: "no_release"`。
 *
 * 这个兜底"看起来安全"（needsUpdate=false，不打扰用户），但语义是错的：
 *   · 端侧任何按 `latest > current` 判断更新的实现，都会因为 1.0.0 < 1.0.6 **永久**判为不必更新；
 *   · 运营想给快手端推 1.0.7 时，改 app-releases.json 才会生效 —— 可如果没人记得补，
 *     这次"发版"对这些端等于没发。
 * 也就是说：**升级通道是通的，但通的是空管道**。这类问题不会报错，只会让发版悄悄失效。
 *
 * 断言（4 条）
 * -----------
 *   1. 渠道名必须都在 APP_CHANNELS 里（防手滑写成 `kuaisho`，那种记录永远匹配不上）
 *   2. APP_CHANNELS 里每个渠道：**要么有记录，要么在 `_未发布渠道` 里显式豁免**
 *      —— 新增渠道忘了登记，这条会红
 *   3. 有记录的渠道，version 必须等于它**自己的**版本源：
 *      小程序/H5 类 → `apps/qtvq-uni/src/manifest.json` 的 versionName
 *      windows（Electron）→ `desktop/package.json` 的 version
 *      （一次发版，同一类产物版本一起走；某端落后就是"发了一半"。
 *        桌面端不跟 manifest 走：它是独立打包、独立更新链路的另一个产物）
 *   4. 安装包类渠道（app/desktop）必须有 downloadUrl —— 否则客户端提示有新版却点不动，
 *      那就是一个假更新；小程序/web 允许为空（版本包由平台/静态站托管）
 *
 * 豁免必须是"写下来的理由"：`_未发布渠道` 里每一项要以渠道名开头，`check` 时才放行。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const problems = [];
const notes = [];

const releasesPath = path.join(ROOT, 'app-releases.json');
const manifestPath = path.join(ROOT, 'apps', 'qtvq-uni', 'src', 'manifest.json');

let raw;
try {
  raw = JSON.parse(fs.readFileSync(releasesPath, 'utf8'));
} catch (err) {
  console.error(`[check-app-releases-coverage] ❌ app-releases.json 不是合法 JSON：${err.message}`);
  process.exit(1);
}

const { APP_CHANNELS, APP_CHANNEL_KIND } = await import(
  new URL('../../server/src/lib/app-release-core.js', import.meta.url)
);

const exemptText = Array.isArray(raw._未发布渠道) ? raw._未发布渠道 : [];
const exempt = new Set();
for (const line of exemptText) {
  const m = /^\s*([a-z0-9]+)\s*[—\-–:]/.exec(String(line));
  if (m && APP_CHANNELS.includes(m[1])) exempt.add(m[1]);
}

const records = {};
for (const [key, value] of Object.entries(raw)) {
  if (key.startsWith('_')) continue;
  records[key] = value;
}

// ① 渠道名合法性
for (const key of Object.keys(records)) {
  if (!APP_CHANNELS.includes(key)) {
    problems.push(`app-releases.json 里的 "${key}" 不是已知渠道（允许：${APP_CHANNELS.join(', ')}）`);
  }
}

// ② 覆盖度
const missing = [];
for (const channel of APP_CHANNELS) {
  if (records[channel]) continue;
  if (exempt.has(channel)) {
    notes.push(`${channel}：无记录（已豁免，见 _未发布渠道）`);
    continue;
  }
  missing.push(channel);
}
if (missing.length) {
  problems.push(
    `以下渠道既没有发布记录、也没有豁免说明：${missing.join(', ')} —— ` +
      '端侧拿到的 latest 会退回 1.0.0，发版时这些端等于没发',
  );
}

// ③ 版本号统一
//
// 例外：**windows（Electron 桌面端）有自己的版本源 desktop/package.json**。
// 桌面壳是独立打包、独立更新链路的产物，与小程序/H5 共用的 manifest.versionName
// 不是同一个东西。硬要求同号会逼出"为了发桌面去改小程序版本号"这种假统一 ——
// 小程序根本没有对应版本的包，改了反而制造新的不一致。
// 所以：小程序与 H5 类渠道对 manifest，桌面端对 desktop/package.json。
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const appVersion = String(manifest.versionName || '').trim();
const desktopPkgPath = path.join(ROOT, 'desktop', 'package.json');
const desktopVersion = fs.existsSync(desktopPkgPath)
  ? String(JSON.parse(fs.readFileSync(desktopPkgPath, 'utf8')).version || '').trim()
  : '';

if (!appVersion) {
  problems.push('apps/qtvq-uni/src/manifest.json 缺少 versionName');
} else {
  for (const [channel, rec] of Object.entries(records)) {
    if (!APP_CHANNELS.includes(channel)) continue;
    const v = String(rec.version || '').trim();
    if (!/^\d+(\.\d+){0,3}$/.test(v)) {
      problems.push(`${channel}.version 非法（"${v}"），应为 1~4 段纯数字`);
      continue;
    }
    const isDesktop = channel === 'windows';
    const expected = isDesktop && desktopVersion ? desktopVersion : appVersion;
    const source = isDesktop && desktopVersion ? 'desktop/package.json' : 'manifest.versionName';
    if (desktopVersion === '' && isDesktop) {
      problems.push('desktop/package.json 不存在或没有 version，无法核对桌面端版本号');
      continue;
    }
    if (v !== expected) {
      problems.push(
        `${channel}.version=${v} 与 ${source}=${expected} 不一致 —— ` +
          (isDesktop
            ? '桌面端必须与安装包版本同号，否则"清单说有新版、包却是旧的"'
            : '统一升级要求各端同一次发版用同一个版本号，落后就是"发了一半"'),
      );
    }
  }
}

// ④ 安装包类渠道必须有下载地址
for (const [channel, rec] of Object.entries(records)) {
  const kind = APP_CHANNEL_KIND[channel];
  if (kind !== 'app' && kind !== 'desktop') continue;
  const url = String(rec.downloadUrl || '').trim();
  if (!url) {
    problems.push(`${channel} 属于安装包渠道（${kind}），但没有 downloadUrl —— 客户端会提示有新版却点不动`);
    continue;
  }
  if (!/^https:\/\//.test(url)) problems.push(`${channel}.downloadUrl 必须是 https 绝对地址："${url}"`);
}

// 5（附加）两侧生成副本必须与源一致，否则 Pages 与 Node 会各说一套
const genPaths = [
  'functions/data/app-releases.generated.js',
  'server/src/data/app-releases.generated.js',
];
for (const rel of genPaths) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) {
    problems.push(`缺少生成副本 ${rel}（请运行 node tools/scripts/write-app-releases.mjs）`);
    continue;
  }
  const text = fs.readFileSync(p, 'utf8');
  for (const [channel, rec] of Object.entries(records)) {
    if (!text.includes(`"${channel}"`)) {
      problems.push(`${rel} 里没有渠道 "${channel}" —— 生成副本已过期，请重跑生成脚本`);
    }
    if (rec.version && !text.includes(`"${rec.version}"`)) {
      problems.push(`${rel} 里没有版本号 ${rec.version} —— 生成副本已过期`);
    }
  }
}

if (problems.length === 0) {
  const covered = Object.keys(records).filter((k) => APP_CHANNELS.includes(k)).length;
  console.log(
    `[check-app-releases-coverage] ✅ ${covered}/${APP_CHANNELS.length} 渠道有记录，` +
      `小程序/H5 统一 ${appVersion}` +
        (desktopVersion ? ` · 桌面端 ${desktopVersion}` : '') +
        '，安装包渠道均有真实地址',
  );
  for (const n of notes) console.log('  · ' + n);
  process.exit(0);
}

console.error(`[check-app-releases-coverage] ❌ ${problems.length} 处不符合：`);
for (const p of problems) console.error('  ' + p);
process.exit(1);
