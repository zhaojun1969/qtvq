#!/usr/bin/env node
/**
 * 把微信小程序码接入下载页（一条命令，避免手改三个文件）
 *
 * 用法：
 *   node tools/scripts/apply-mp-qrcode.mjs "D:/下载/小程序码.png"
 *   node tools/scripts/apply-mp-qrcode.mjs "D:/下载/小程序码.png" --platform weixin
 *
 * 它会：
 *   1. 校验是 PNG、尺寸够大（微信小程序码建议 430×430 以上，太小扫码会糊）；
 *   2. 复制到 assets/download/<platform>-mp.png；
 *   3. 写进 release-links.json（qrcode 字段）；
 *   4. 重新生成 js/download-config.js。
 *
 * 为什么必须走脚本：qrcode 有四处要一致（release-links.json → 生成脚本 →
 * download-config.js → 页面 img src），而 js/download-config.js 是生成文件，
 * 手改会在下次生成时被覆盖 —— 这类"改了没生效"在这个项目里已经出过好几次。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith('--'));
const platformIdx = args.indexOf('--platform');
const platform = platformIdx > -1 ? args[platformIdx + 1] : 'weixin';

const PLATFORMS = {
  weixin: { label: '微信', min: 430 },
  alipay: { label: '支付宝', min: 300 },
  douyin: { label: '抖音', min: 300 },
  xhs: { label: '小红书', min: 300 },
  qq: { label: 'QQ', min: 300 },
  baidu: { label: '百度', min: 300 },
  kuaishou: { label: '快手', min: 300 },
  jd: { label: '京东', min: 300 },
};

if (!src) {
  console.error('用法：node tools/scripts/apply-mp-qrcode.mjs <图片路径> [--platform weixin]');
  process.exit(1);
}
if (!PLATFORMS[platform]) {
  console.error(`未知平台：${platform}（可选：${Object.keys(PLATFORMS).join(', ')}）`);
  process.exit(1);
}
if (!fs.existsSync(src)) {
  console.error(`文件不存在：${src}`);
  process.exit(1);
}

const buf = fs.readFileSync(src);
if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') {
  console.error('不是 PNG 文件。微信开发者工具导出的小程序码请选 PNG（JPEG 会有压缩噪点，影响识别）。');
  process.exit(1);
}
const width = buf.readUInt32BE(16);
const height = buf.readUInt32BE(20);
const need = PLATFORMS[platform].min;
if (width < need || height < need) {
  console.error(
    `图片只有 ${width}×${height}，${PLATFORMS[platform].label}小程序码建议 ≥ ${need}×${need}（否则扫码识别率低）。`,
  );
  process.exit(1);
}

const dir = path.join(ROOT, 'assets', 'download');
fs.mkdirSync(dir, { recursive: true });
const fileName = `${platform}-mp.png`;
const dest = path.join(dir, fileName);
fs.copyFileSync(src, dest);
console.log(`✓ 已复制到 assets/download/${fileName}（${width}×${height}，${(buf.length / 1024).toFixed(1)}KB）`);

const linksPath = path.join(ROOT, 'release-links.json');
const links = JSON.parse(fs.readFileSync(linksPath, 'utf8'));
links[platform] = links[platform] || {};
links[platform].qrcode = `assets/download/${fileName}`;
fs.writeFileSync(linksPath, JSON.stringify(links, null, 2) + '\n', 'utf8');
console.log(`✓ release-links.json 已更新：${platform}.qrcode = ${links[platform].qrcode}`);

const gen = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'scripts', 'write-download-config.mjs')], {
  stdio: 'inherit',
  cwd: ROOT,
});
if (gen.status !== 0) {
  console.error('✗ 生成 download-config.js 失败，请手动运行 write-download-config.mjs 查看报错');
  process.exit(gen.status || 1);
}

console.log('\n下一步：');
console.log('  1. node tools/scripts/check-download-page.mjs   # 校验下载页链路');
console.log('  2. 部署静态站（npm run deploy 或 sync-static-from-windows.ps1）后刷新下载页确认');
console.log(`  3. node tools/scripts/check-mp-materials.mjs    # 小程序码一项应变 ✅`);
