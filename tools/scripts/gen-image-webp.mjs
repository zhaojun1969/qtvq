#!/usr/bin/env node
/**
 * 生成 WebP 变体（C2 性能优化 · 图片）
 *
 * 原则：**只做无损**。二维码是"扫错一位就付错人"的东西，任何有损编码都是在拿钱冒险。
 *      无损 WebP 产出的像素与 PNG 完全一致，因此扫码行为不变 —— 这一点由本脚本自己验证。
 *
 * 为什么不是"一律转 WebP"：实测（2026-10-26）无损 WebP 并非处处更小：
 *
 *   qr-wechat.png        272.1 KB → 136.0 KB  （-50%，值得转）
 *   qr-aggregate.png      66.7 KB →  33.9 KB  （-49%，值得转）
 *   qr-alipay-scan.png    97.0 KB → 204.6 KB  （**更大**，不转）
 *   qr-unionpay-icbc.png  95.0 KB → 316.6 KB  （**更大**，不转）
 *
 * 后两张是照片类截图，无损压缩对它们不友好；要用有损才降得下来，
 * 但对二维码做有损就等于赌扫码器能纠错 —— 不值得，所以保留 PNG。
 * 脚本对"转换后更大"的输入直接跳过，避免把页面越优化越慢。
 *
 * 用法
 * ----
 *   node tools/scripts/gen-image-webp.mjs            # 生成/更新，打印体积对比
 *   node tools/scripts/gen-image-webp.mjs --check    # 只校验现有 .webp 是否仍小于源图（CI 用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CHECK = process.argv.includes('--check');

/**
 * 需要生成 WebP 的源图。刻意列白名单而不是全目录扫描：
 * 这个项目里 90% 的 PNG 是各端图标/截图，不在网页关键路径上，
 * 全量转换只会增加构建时间与仓库体积，用户一个字节都省不到。
 */
const SOURCES = ['assets/payment/qr-wechat.png', 'assets/payment/qr-aggregate.png'];

/** 最小收益门槛：小于 10% 的收益不值得多一个文件 */
const MIN_GAIN = 0.1;

async function pixelIdentical(a, b) {
  const ra = await sharp(a).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rb = await sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (ra.info.width !== rb.info.width || ra.info.height !== rb.info.height) return false;
  return ra.data.equals(rb.data);
}

const rows = [];
let failed = 0;

for (const rel of SOURCES) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) {
    console.log(`  ! 跳过（源图不存在）：${rel}`);
    continue;
  }
  const outRel = rel.replace(/\.png$/i, '.webp');
  const out = path.join(ROOT, outRel);
  const srcBuf = fs.readFileSync(src);

  if (CHECK) {
    if (!fs.existsSync(out)) {
      console.error(`  ✗ ${outRel} 不存在（源图 ${rel} 需要 WebP 变体）`);
      failed += 1;
      continue;
    }
    const outSize = fs.statSync(out).size;
    if (outSize >= srcBuf.length) {
      console.error(`  ✗ ${outRel} 比源图还大（${outSize} ≥ ${srcBuf.length}）—— 不该上线`);
      failed += 1;
      continue;
    }
    const same = await pixelIdentical(srcBuf, fs.readFileSync(out));
    if (!same) {
      console.error(`  ✗ ${outRel} 与源图像素不一致（无损编码不应改变像素）`);
      failed += 1;
      continue;
    }
    rows.push([rel, srcBuf.length, outSize]);
    continue;
  }

  const buf = await sharp(srcBuf).webp({ lossless: true, effort: 6 }).toBuffer();
  const gain = 1 - buf.length / srcBuf.length;
  if (gain < MIN_GAIN) {
    console.log(`  - ${rel}: 收益 ${(gain * 100).toFixed(1)}% < ${MIN_GAIN * 100}%，跳过`);
    continue;
  }
  // 无损必须逐像素一致；不一致说明编码参数不是真无损，宁可不上线
  const same = await pixelIdentical(srcBuf, buf);
  if (!same) {
    console.error(`  ✗ ${rel}: WebP 与源图像素不一致，拒绝写入（无损编码不应改变像素）`);
    failed += 1;
    continue;
  }
  fs.writeFileSync(out, buf);
  rows.push([rel, srcBuf.length, buf.length]);
}

if (CHECK) {
  if (failed) {
    console.error(`[gen-image-webp] ❌ ${failed} 处不合格`);
    process.exit(1);
  }
  const totalSrc = rows.reduce((a, r) => a + r[1], 0);
  const totalOut = rows.reduce((a, r) => a + r[2], 0);
  console.log(
    `[gen-image-webp] ✅ ${rows.length} 个 WebP 变体均小于源图且像素一致；` +
      `合计 ${(totalSrc / 1024).toFixed(1)} KB → ${(totalOut / 1024).toFixed(1)} KB（-${((1 - totalOut / totalSrc) * 100).toFixed(1)}%）`,
  );
  process.exit(0);
}

if (failed) {
  console.error(`[gen-image-webp] ❌ ${failed} 处失败`);
  process.exit(1);
}

console.log('  源图                          PNG         WebP       节省');
let srcSum = 0;
let outSum = 0;
for (const [rel, s, o] of rows) {
  srcSum += s;
  outSum += o;
  console.log(
    `  ${rel.padEnd(28)} ${(s / 1024).toFixed(1).padStart(7)} KB ${(o / 1024).toFixed(1).padStart(8)} KB ${(((s - o) / 1024).toFixed(1) + ' KB').padStart(9)}`,
  );
}
if (rows.length) {
  console.log(
    `  合计 ${(srcSum / 1024).toFixed(1)} KB → ${(outSum / 1024).toFixed(1)} KB，` +
      `下降 ${((1 - outSum / srcSum) * 100).toFixed(1)}%`,
  );
}
