/**
 * 二维码生成（小程序端 · 纯本地，零外部依赖）
 *
 * ⚠️ 2026-09-18 修正：本文件原来把订单码交给境外服务 `quickchart.io` 换图片 ——
 *    两个后果都很致命：① 国内加载不出来，付款二维码**永远是空白**；
 *    ② 小程序对境外域名有额外限制，业务上也不该把订单码交给第三方。
 *
 * 与 Web 端 js/qr-render.js 使用**同一套编码算法**（字节模式 / ECL M / 版本 1-6，
 * 已用 jsQR 反解验证 7/7）。差别只在于"画到哪里"：
 *   · Web 用 <canvas> + toDataURL
 *   · 小程序没有 DOM canvas，必须由页面用 uni canvas 上下文来画 → 见 drawQrToCanvas()
 */

const ECL_M = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
};

const ALIGN_CENTERS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
};

const FORMAT_INFO_M = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];

const EXP = new Array(512);
const LOG = new Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= gfMul(poly[j], 1);
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGeneratorPoly(ecLen);
  const res = new Array(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < ecLen; i += 1) res[i] ^= gfMul(gen[i + 1], factor);
  }
  return res;
}

function toUtf8Bytes(text) {
  // 小程序环境用 unescape/encodeURIComponent 兼容方式取 UTF-8 字节
  const encoded = encodeURIComponent(text);
  const bytes = [];
  for (let i = 0; i < encoded.length; i += 1) {
    if (encoded[i] === '%') {
      bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(encoded.charCodeAt(i));
    }
  }
  return bytes;
}

function pickVersion(byteLen) {
  for (let v = 1; v <= 6; v += 1) {
    const [, g1, d1, g2, d2] = ECL_M[v];
    if (g1 * d1 + g2 * d2 >= byteLen + 2) return v;
  }
  return 0;
}

function isFunctionModule(r, c, size, version) {
  if (r <= 8 && c <= 8) return true;
  if (r <= 8 && c >= size - 8) return true;
  if (r >= size - 8 && c <= 8) return true;
  if (r === 6 || c === 6) return true;
  for (const ar of ALIGN_CENTERS[version]) {
    for (const ac of ALIGN_CENTERS[version]) {
      if ((ar <= 8 && ac <= 8) || (ar <= 8 && ac >= size - 9) || (ar >= size - 9 && ac <= 8)) continue;
      if (Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2) return true;
    }
  }
  return false;
}

/** 文本 → 布尔矩阵（true = 深色）。算法与 Web 端完全一致。 */
export function qrMatrix(text) {
  const bytes = toUtf8Bytes(String(text || ''));
  const version = pickVersion(bytes.length);
  if (!version) throw new Error(`二维码内容过长（${bytes.length} 字节），本地实现仅支持 ≤108 字节`);

  const [ecLen, g1, d1, g2, d2] = ECL_M[version];
  const totalData = g1 * d1 + g2 * d2;

  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i -= 1) bits.push((val >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  for (let i = 0; i < 4 && bits.length < totalData * 8; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j += 1) v = (v << 1) | bits[i + j];
    data.push(v);
  }
  const pads = [0xec, 0x11];
  let pi = 0;
  while (data.length < totalData) {
    data.push(pads[pi % 2]);
    pi += 1;
  }

  const blocks = [];
  let offset = 0;
  for (let i = 0; i < g1; i += 1) {
    const chunk = data.slice(offset, offset + d1);
    offset += d1;
    blocks.push({ data: chunk, ec: rsEncode(chunk, ecLen) });
  }
  for (let i = 0; i < g2; i += 1) {
    const chunk = data.slice(offset, offset + d2);
    offset += d2;
    blocks.push({ data: chunk, ec: rsEncode(chunk, ecLen) });
  }
  const codewords = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i += 1) for (const b of blocks) if (i < b.data.length) codewords.push(b.data[i]);
  for (let i = 0; i < ecLen; i += 1) for (const b of blocks) codewords.push(b.ec[i]);

  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));

  const setFinder = (r, c) => {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        m[rr][cc] = inRing && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
      }
    }
  };
  setFinder(0, 0);
  setFinder(0, size - 7);
  setFinder(size - 7, 0);
  for (let i = 8; i < size - 8; i += 1) {
    m[6][i] = i % 2 === 0;
    m[i][6] = i % 2 === 0;
  }
  for (const ar of ALIGN_CENTERS[version]) {
    for (const ac of ALIGN_CENTERS[version]) {
      if ((ar <= 8 && ac <= 8) || (ar <= 8 && ac >= size - 9) || (ar >= size - 9 && ac <= 8)) continue;
      for (let dr = -2; dr <= 2; dr += 1)
        for (let dc = -2; dc <= 2; dc += 1) m[ar + dr][ac + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
    }
  }
  for (let i = 0; i < 9; i += 1) {
    if (m[8][i] === null) m[8][i] = false;
    if (m[i][8] === null) m[i][8] = false;
  }
  for (let i = 0; i < 8; i += 1) {
    if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = false;
    if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = false;
  }
  m[size - 8][8] = true;

  const dataBits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i -= 1) dataBits.push(((cw >> i) & 1) === 1);
  let bitIdx = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let i = 0; i < size; i += 1) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (m[row][c] !== null) continue;
        m[row][c] = bitIdx < dataBits.length ? dataBits[bitIdx] : false;
        bitIdx += 1;
      }
    }
    upward = !upward;
  }

  const penalty = (mat) => {
    let score = 0;
    for (let r = 0; r < size; r += 1) {
      let run = 1;
      for (let c = 1; c < size; c += 1) {
        if (mat[r][c] === mat[r][c - 1]) run += 1;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (let c = 0; c < size; c += 1) {
      let run = 1;
      for (let r = 1; r < size; r += 1) {
        if (mat[r][c] === mat[r - 1][c]) run += 1;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (let r = 0; r < size - 1; r += 1)
      for (let c = 0; c < size - 1; c += 1) {
        const v = mat[r][c];
        if (v === mat[r][c + 1] && v === mat[r + 1][c] && v === mat[r + 1][c + 1]) score += 3;
      }
    let dark = 0;
    for (const row of mat) for (const v of row) if (v) dark += 1;
    score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
    return score;
  };

  const writeFormat = (mat, mask) => {
    const fi = FORMAT_INFO_M[mask];
    const arr = [];
    for (let i = 14; i >= 0; i -= 1) arr.push(((fi >> i) & 1) === 1);
    const coords = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
    coords.forEach(([r, c], i) => {
      mat[r][c] = arr[i];
    });
    for (let i = 0; i < 8; i += 1) mat[8][size - 1 - i] = arr[i];
    for (let i = 8; i < 15; i += 1) mat[size - 15 + i][8] = arr[i];
    mat[size - 8][8] = true;
  };

  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const mat = m.map((row) => row.slice());
    for (let r = 0; r < size; r += 1)
      for (let c = 0; c < size; c += 1) {
        if (isFunctionModule(r, c, size, version)) continue;
        let invert = false;
        switch (mask) {
          case 0: invert = (r + c) % 2 === 0; break;
          case 1: invert = r % 2 === 0; break;
          case 2: invert = c % 3 === 0; break;
          case 3: invert = (r + c) % 3 === 0; break;
          case 4: invert = (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; break;
          case 5: invert = ((r * c) % 2) + ((r * c) % 3) === 0; break;
          case 6: invert = (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; break;
          case 7: invert = (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; break;
          default: break;
        }
        if (invert) mat[r][c] = !mat[r][c];
      }
    writeFormat(mat, mask);
    const p = penalty(mat);
    if (!best || p < best.p) best = { p, mat };
  }
  return best.mat;
}

/**
 * 把二维码矩阵画到小程序 canvas 上。
 * 用法（页面里）：
 *   const ctx = uni.createCanvasContext('payQr', this)
 *   drawQrToCanvas(ctx, qrMatrix(codeUrl), 260)
 *   ctx.draw()
 */
export function drawQrToCanvas(ctx, matrix, size = 260, quiet = 4) {
  const count = matrix.length;
  const unit = size / (count + quiet * 2);
  ctx.setFillStyle('#ffffff');
  ctx.fillRect(0, 0, size, size);
  ctx.setFillStyle('#000000');
  for (let r = 0; r < count; r += 1) {
    for (let c = 0; c < count; c += 1) {
      if (!matrix[r][c]) continue;
      ctx.fillRect((c + quiet) * unit, (r + quiet) * unit, unit, unit);
    }
  }
  return size;
}

/**
 * @deprecated 小程序里没有 DOM canvas，无法直接产出图片 URL。
 * 请改用 `qrMatrix()` + `drawQrToCanvas()` 在页面 canvas 上绘制。
 * 保留此函数只为兼容旧调用：调用即抛出明确错误，而不是像以前那样
 * 悄悄返回一个境外服务的 URL（国内加载不出来 → 付款码空白）。
 */
export function qrCodeImageUrl() {
  throw new Error('小程序请改用 qrMatrix() + drawQrToCanvas() 绘制二维码（本函数已废弃）');
}
