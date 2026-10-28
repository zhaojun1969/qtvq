/**
 * 生成各端自动更新用的版本清单：`dist/pages-public/release/version.json`
 *
 * 为什么需要：小程序的更新由平台托管，但 **App 与 H5/桌面端必须自己知道"最新版本是多少"**。
 * 没有这个文件，"自动更新"就无从判断。清单同时充当**发布记录**：哪一端发了什么版本、
 * 下载地址是什么，一眼可查，不必翻聊天记录。
 *
 * 清单结构（字段与 `apps/qtvq-uni/src/utils/update.js` 的读取逻辑一一对应）：
 * {
 *   "generatedAt": "...",
 *   "web":  { "build": "<静态站 BUILD_SHA>", "version": "1.0.<n>" },   // H5/桌面轮询用
 *   "app":  {                                                          // App 用
 *     "android": { "version": "1.0.6", "versionCode": 106, "url": "...", "wgtCompatible": true, "note": "..." },
 *     "ios":     { ... },
 *     "harmony": { ... }
 *   },
 *   "miniProgram": { "mp-weixin": {...}, ... }                          // 仅作发布记录，平台自己管更新
 * }
 *
 * 数据来源：apps/qtvq-uni/src/manifest.json（versionName/versionCode）、js/version.js（静态站指纹）、
 * release-links.json（各端下载地址，由发布脚本写入或人工维护）。
 *
 * 用法：node tools/scripts/write-release-manifest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'dist', 'pages-public', 'release');
const LINKS_FILE = path.join(ROOT, 'release-links.json');

/** 解析 JSON：区分"不存在"（用默认值）与"存在但坏了"（大声失败）。
 *  静默吞掉解析错误会把"配置写坏了"伪装成"还没配置"（2026-09-20 release-links.json 踩过）。 */
function readJson(p, fallback = null) {
  if (!fs.existsSync(p)) return fallback;
  const raw = fs.readFileSync(p, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${path.relative(ROOT, p)} 不是合法 JSON（${err.message}）。JSON 不能带注释，说明请写进 "_说明" 字段。`,
    );
  }
}

const manifest = readJson(path.join(ROOT, 'apps', 'qtvq-uni', 'src', 'manifest.json'), {});
const versionName = manifest.versionName || '1.0.0';
const versionCode = Number(manifest.versionCode || 0) || 1;

// 静态站指纹（js/version.js 由 write-version.ps1 生成）
const versionJs = fs.existsSync(path.join(ROOT, 'js', 'version.js'))
  ? fs.readFileSync(path.join(ROOT, 'js', 'version.js'), 'utf8')
  : '';
const buildSha = (versionJs.match(/BUILD_SHA\s*=\s*'([^']+)'/) || [])[1] || 'unknown';

// 各端下载地址（人工/脚本维护；缺省时清单里 url 为空，update.js 会安静跳过）
const links = readJson(LINKS_FILE, {});

/*
 * 版本来源：仓库根 `app-releases.json` —— 与 `/api/app/bootstrap`（各端专用端口）
 * 是**同一份数据**。原来这里用的是 release-links.json 的版本字段，等于同一个事实存两处，
 * 迟早分叉（本项目已因"同一事实两处各自演进"踩过 ADMIN_KEY、LLM_PROVIDER 两次）。
 * 现在 release-links.json 只负责"非版本类"的链接（小程序码、应用商店页）。
 */
const releases = readJson(path.join(ROOT, 'app-releases.json'), {});
for (const key of Object.keys(releases)) {
  if (key.startsWith('_')) delete releases[key];
}

/** 取某端的发布记录（没有就说明该端还没发布） */
function rel(channel) {
  const r = releases[channel] || {};
  return {
    version: r.version || null,
    minVersion: r.minVersion || null,
    mode: r.mode || 'prompt',
    notes: r.notes || '',
    downloadUrl: r.downloadUrl || links[channel]?.url || '',
  };
}

const miniProgramIds = [
  'mp-weixin',
  'mp-alipay',
  'mp-toutiao',
  'mp-xhs',
  'mp-qq',
  'mp-baidu',
  'mp-kuaishou',
  'mp-jd',
];

const payload = {
  generatedAt: new Date().toISOString(),
  versionName,
  versionCode,
  web: {
    build: buildSha,
    version: versionName,
  },
  app: {
    // 版本/最低版本/更新方式/下载地址全部来自 app-releases.json（与 bootstrap 端点同源）。
    // 只有"应用商店页"这类非版本链接才回退到 release-links.json。
    android: {
      version: rel('android').version || versionName,
      minVersion: rel('android').minVersion,
      mode: rel('android').mode,
      versionCode,
      url: rel('android').downloadUrl || links.android?.store || '',
      wgtCompatible: links.android?.wgtCompatible !== false,
      note: rel('android').notes || links.android?.note || '',
    },
    ios: {
      version: rel('ios').version || versionName,
      minVersion: rel('ios').minVersion,
      mode: rel('ios').mode,
      versionCode,
      url: rel('ios').downloadUrl || links.ios?.url || '',
      // iOS 对热更新限制更严，一律不做热更新
      wgtCompatible: false,
      note: rel('ios').notes || links.ios?.note || '',
    },
    harmony: {
      version: rel('harmony').version || versionName,
      minVersion: rel('harmony').minVersion,
      mode: rel('harmony').mode,
      versionCode,
      url: rel('harmony').downloadUrl || links.harmony?.url || '',
      wgtCompatible: links.harmony?.wgtCompatible !== false,
      note: rel('harmony').notes || links.harmony?.note || '',
    },
    windows: {
      version: rel('windows').version || versionName,
      minVersion: rel('windows').minVersion,
      mode: rel('windows').mode,
      url: rel('windows').downloadUrl || links.windows?.url || '',
      note: rel('windows').notes || links.windows?.note || '',
    },
  },
  // 小程序：平台托管更新，这里只记录"已构建了哪些端"供运营/开发核对
  miniProgram: Object.fromEntries(
    miniProgramIds.map((id) => [
      id,
      {
        version: versionName,
        built: fs.existsSync(path.join(ROOT, 'apps', 'qtvq-uni', 'dist', 'build', id)),
      },
    ]),
  ),
};

fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, 'version.json');
fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

console.log(`>> 已生成版本清单: ${path.relative(ROOT, outFile)}`);
console.log(`   静态站指纹 web.build = ${buildSha}`);
console.log(`   App 版本 ${versionName} (${versionCode})`);
const missing = Object.entries(payload.app).filter(([, v]) => !v.url).map(([k]) => k);
if (missing.length) {
  console.log(`   ⚠️ 这些端还没有下载地址（update.js 会安静跳过，不会报错）：${missing.join(', ')}`);
  console.log('      填 release-links.json 后重新运行本脚本即可。');
}
