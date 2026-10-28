/**
 * 生成 `js/download-config.js`（静态站下载页的数据源）
 *
 * 为什么生成而不是手写：下载地址会随上架变化，而且**经常是最后一步才拿到**
 * （应用商店审核过了才有链接）。手写的后果本项目已经踩到：6 个入口全是
 * `href: ''`，页面看上去"有下载"，点下去一律"即将上线" —— 对客户就是死胡同。
 *
 * 现在唯一来源是仓库根的 `release-links.json`（地址）+ uni-app 的 manifest（小程序端清单），
 * 本脚本把它们合成下载页配置；`tools/scripts/write-release-manifest.mjs` 读**同一个**
 * release-links.json 生成 App 自动更新的清单 —— 两处不会分叉。
 *
 * 用法：node tools/scripts/write-download-config.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

/**
 * 解析 JSON 文件。
 *
 * 这里刻意把"文件不存在"与"文件存在但坏了"分开处理：
 * 2026-09-20 实际踩到 —— release-links.json 我一开始写成了**带注释的 JSONC**（不合法），
 * 而当时的 `readJson(p, {})` 把解析异常一并吞掉，于是脚本"成功"生成了一个**全部地址为空**的
 * 下载页配置：页面看起来正常，实际 12 个端全是"即将上线"。
 * 静默降级把"配置写坏了"伪装成"本来就没配置"。所以现在：坏了就大声失败。
 */
function readJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  const raw = fs.readFileSync(p, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${path.relative(ROOT, p)} 不是合法 JSON（${err.message}）。\n` +
        '  提示：JSON 不能带注释；说明文字请写进 "_说明" 字段。',
    );
  }
}

const links = readJson(path.join(ROOT, 'release-links.json'), {});
const uniManifest = readJson(path.join(ROOT, 'apps', 'qtvq-uni', 'src', 'manifest.json'), {});
const versionName = uniManifest.versionName || '1.0.0';

/** 小程序矩阵：key 与 download.html / release 清单保持一致 */
const MINI_PROGRAMS = [
  ['weixin', '微信小程序', '微', '微信内搜索「我心永恒 Q问」，或扫右侧小程序码'],
  ['alipay', '支付宝小程序', '支', '支付宝扫一扫或搜索「Q问」'],
  ['douyin', '抖音小程序', '抖', '抖音内搜索「Q问」'],
  ['xhs', '小红书小程序', '书', '小红书内搜索「Q问」'],
  ['qq', 'QQ 小程序', 'Q', 'QQ 内搜索「Q问」'],
  ['baidu', '百度智能小程序', '百', '百度 App 内搜索「Q问」'],
  ['kuaishou', '快手小程序', '快', '快手内搜索「Q问」'],
  ['jd', '京东小程序', '京', '京东 App 内搜索「Q问」'],
];

const cfg = {};

// 桌面端：Windows 桌面应用（Electron 壳，见 desktop/）
cfg.windows = {
  kind: 'app',
  label: 'Windows 桌面版',
  href: links.windows?.url || '',
  note: links.windows?.url ? 'Windows 10/11 · 下载后双击安装' : '安装包构建中，可先用网页版',
  icon: '🖥️',
};

cfg.android = {
  kind: 'app',
  label: 'Android 下载',
  href: links.android?.url || '',
  store: links.android?.store || '',
  note: links.android?.url ? 'APK 直装（需允许未知来源）' : '待上架：应用宝 / 华为 / 小米 / OPPO / vivo',
  icon: '🤖',
};

cfg.ios = {
  kind: 'app',
  label: 'App Store',
  href: links.ios?.url || '',
  note: links.ios?.url ? 'App Store 下载' : '需 Apple 开发者账号 + 审核通过',
  icon: '🍎',
};

cfg.harmony = {
  kind: 'app',
  label: '鸿蒙版',
  href: links.harmony?.url || '',
  note: links.harmony?.url ? '华为应用市场下载' : '需华为开发者账号；鸿蒙 NEXT 需 uni-app x 工程',
  icon: '🔷',
};

for (const [key, label, iconChar, desc] of MINI_PROGRAMS) {
  const mpManifestKey = key === 'douyin' ? 'mp-toutiao' : key === 'weixin' ? 'mp-weixin' : key === 'xhs' ? 'mp-xhs' : `mp-${key}`;
  const appid = uniManifest[mpManifestKey]?.appid || '';
  cfg[key] = {
    kind: 'miniprogram',
    label,
    icon: iconChar,
    desc,
    href: links[key]?.href || '',
    qrcode: links[key]?.qrcode || '',
    // appid 只用于运营自查是否已申请（页面不展示）
    appid,
    note: appid ? (links[key]?.qrcode ? '' : '已创建小程序，上传二维码后此处显示') : '待申请小程序账号',
  };
}

cfg.h5 = {
  kind: 'web',
  label: '手机网页版（App 同界面）',
  // uni-app 的 H5 构建（与小程序/App 同一套源码），部署在 /h5/ 下。
  // 注意与 qtvq.cn 主站区分：主站是宣传+工具的静态站，这里是应用界面。
  href: links.h5?.href || 'https://qtvq.cn/h5/',
  note: '无需安装 · 已上线 · 可添加到主屏幕',
  icon: '🌐',
  active: true,
};

cfg.site = {
  kind: 'web',
  label: '官方网站',
  href: 'https://qtvq.cn',
  note: '介绍、避坑大全、帮助与下载页',
  icon: '🏠',
};

/** 页面的分区（顺序即展示顺序） */
const sections = [
  { title: '桌面端', keys: ['windows'] },
  { title: '手机 App', keys: ['android', 'ios', 'harmony'] },
  { title: '小程序 · 轻应用', keys: MINI_PROGRAMS.map(([k]) => k) },
  { title: '网页版', keys: ['h5', 'site'] },
];

const header = `/**
 * 各端下载配置 —— **本文件由 tools/scripts/write-download-config.mjs 生成，请勿手改**。
 *
 * 要改下载地址/小程序码：改仓库根的 release-links.json，然后运行
 *   node tools/scripts/write-download-config.mjs && node tools/scripts/write-release-manifest.mjs
 * 这两个脚本读同一份 release-links.json，下载页与 App 自动更新不会分叉。
 *
 * 生成时间: ${new Date().toISOString()}
 * App 版本: ${versionName}
 * 留空的入口在页面上显示「即将上线」，但**不再是一个点了没反应的死链**：
 * js/download.js 会把它们渲染成不可点状态并写明原因。
 */`;

const body = `${header}

export const DOWNLOAD_LINKS = ${JSON.stringify(cfg, null, 2)};

export const DOWNLOAD_SECTIONS = ${JSON.stringify(sections, null, 2)};
`;

const out = path.join(ROOT, 'js', 'download-config.js');
fs.writeFileSync(out, body, 'utf8');

const ready = Object.entries(cfg).filter(([, v]) => v.href || v.active).map(([k]) => k);
const pending = Object.entries(cfg)
  .filter(([, v]) => !v.href && !v.active)
  .map(([k]) => k);
console.log(`>> 已生成 ${path.relative(ROOT, out)}`);
console.log(`   可用入口（${ready.length}）: ${ready.join(', ')}`);
console.log(`   待上线（${pending.length}）: ${pending.join(', ')}`);
