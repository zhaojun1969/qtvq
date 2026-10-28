/**
 * 把二维码矩阵写成 PNG（**零依赖**，只用 node:zlib）
 *
 * 为什么不用现成库：
 *   · 服务器上既没有 `canvas`，也没有 `pngjs`、`sharp`（实测 `pd` 都没装），
 *     为"生成一张二维码图"去装原生模块不划算；
 *   · PNG 的最小可用子集（8-bit 灰度 + 单个 IDAT）用 zlib + CRC32 就能写完，
 *     40 行代码、没有供应链风险，也不涉及任何境外服务。
 *
 * 灰度 0 = 黑、255 = 白；每行首字节是 filter 类型（0 = None）。
 */
import zlib from 'node:zlib';

/** CRC32（PNG 每个 chunk 都要） */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** 一个 PNG chunk：长度 + 类型 + 数据 + CRC（**不含文件签名**） */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * @param {boolean[][]} matrix qrMatrix() 的结果：true = 黑
 * @param {{scale?: number, quiet?: number}} [opts] scale = 每个模块多少像素；quiet = 静区模块数（≥4）
 * @returns {Buffer} PNG 字节
 */
export function qrPngBuffer(matrix, { scale = 10, quiet = 4 } = {}) {
  const count = matrix.length;
  const size = count + quiet * 2;
  const px = size * scale;

  // 每行 1 字节 filter + px 字节像素，先全填白
  const raw = Buffer.alloc((px + 1) * px, 0xff);
  for (let y = 0; y < px; y += 1) raw[y * (px + 1)] = 0;

  for (let r = 0; r < count; r += 1) {
    for (let c = 0; c < count; c += 1) {
      if (!matrix[r][c]) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const x = (c + quiet) * scale + dx;
          const y = (r + quiet) * scale + dy;
          raw[y * (px + 1) + 1 + x] = 0x00;
        }
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(px, 0);
  ihdr.writeUInt32BE(px, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type 0 = grayscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
