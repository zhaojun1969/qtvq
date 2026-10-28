/**
 * 把微信 `code_url` 渲染成可扫码的 PNG（零依赖：Node 内置 zlib + 自写 CRC32）。
 *
 * 为什么自己写 PNG：项目要求不引新依赖，而"给业务方扫一个码"必须是一张能被手机相机
 * 直接识别的图片。二维码矩阵复用项目里已验证过的 `js/qr-render.js`（byte 模式 / ECL M，
 * 用 jsQR 严格+宽松双模验过 7/7）。
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { qrMatrix } from '../../js/qr-render.js';

const text = process.argv[2];
const out = process.argv[3] || 'dist/qr.png';
const scale = Number(process.argv[4] || 10); // 每个模块放大倍数
const quiet = 4; // 静区（二维码规范要求 ≥4 模块，缺了会扫不出来）

if (!text) {
  console.error('用法: node tools/scripts/make-qr-png.mjs "<内容>" [输出路径] [放大倍数]');
  process.exit(2);
}

const m = qrMatrix(text); // 二维布尔数组
const n = m.length;
const size = (n + quiet * 2) * scale;

// 灰度（colorType 0）：0 = 黑，255 = 白
const raw = Buffer.alloc((size + 1) * size, 0xff);
for (let y = 0; y < size; y++) {
  raw[y * (size + 1)] = 0; // 每行开头的 filter 字节
  for (let x = 0; x < size; x++) {
    const mx = Math.floor(x / scale) - quiet;
    const my = Math.floor(y / scale) - quiet;
    const dark = mx >= 0 && my >= 0 && mx < n && my < n && m[my][mx];
    raw[y * (size + 1) + 1 + x] = dark ? 0x00 : 0xff;
  }
}

// ── 最小 PNG 封装 ──
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0);
ihdr.writeUInt32BE(size, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 0; // grayscale
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.mkdirSync(out.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
fs.writeFileSync(out, png);
console.log(`✅ 已生成 ${out}  ${size}×${size} 像素（${n}×${n} 模块，放大 ${scale}，静区 ${quiet}）`);
