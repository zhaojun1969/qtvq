/**
 * 交叉验证本地二维码实现：用第三方库把生成的图**反解回原文**。
 *
 * 为什么必须这样验：二维码"看起来像"没有意义，必须能被扫出来。
 * 这里用 qrcode 生成参照图、用 jsqr 解码**我们自己生成的图**，
 * 逐例比对文本是否完全一致。任何一处对不上都说明实现有 bug。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Windows 下动态 import 必须用 file:// URL，直接给绝对路径会报 ERR_UNSUPPORTED_ESM_URL_SCHEME
const u = (p) => pathToFileURL(path.resolve(p)).href;

const { default: QRCode } = await import(u('dist/_qrtest/node_modules/qrcode/lib/index.js'));
const jsQR = (await import(u('dist/_qrtest/node_modules/jsqr/dist/jsQR.js'))).default;
const pngjs = await import(u('dist/_qrtest/node_modules/pngjs/lib/png.js'));
const PNG = pngjs.PNG || pngjs.default?.PNG;

const { qrMatrix } = await import(u('js/qr-render.js'));

/** 把布尔矩阵画成 PNG（Node 侧无 canvas，用 pngjs 手动画） */
function matrixToPng(matrix, scale = 8, quiet = 4) {
  const count = matrix.length;
  const px = (count + quiet * 2) * scale;
  const png = new PNG({ width: px, height: px });
  png.data.fill(255);
  for (let r = 0; r < count; r += 1) {
    for (let c = 0; c < count; c += 1) {
      if (!matrix[r][c]) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const x = (c + quiet) * scale + dx;
          const y = (r + quiet) * scale + dy;
          const idx = (png.width * y + x) << 2;
          png.data[idx] = 0;
          png.data[idx + 1] = 0;
          png.data[idx + 2] = 0;
          png.data[idx + 3] = 255;
        }
      }
    }
  }
  return PNG.sync.write(png);
}

const cases = [
  'weixin://wxpay/bizpayurl?pr=5QQN6JTNPIovSIlh',
  'weixin://wxpay/bizpayurl?pr=5QQN7is48MW2rjN1',
  'https://qtvq.cn/account.html',
  '订单 ord_mu6idalp_e6sw12kb 应付 ¥29',
  'Q问',
  'A'.repeat(100),
  'https://qtvq.cn/wechat-callback.html?code=abcdefghijklmnopqrstuvwxyz0123456789&state=0123456789abcdef',
  // 允许从命令行追加真实内容（例如刚下单拿到的 codeUrl），
  // 这样"线上真实订单码能不能画出来"可以当场验，而不是只能信固定样例。
  ...process.argv.slice(2),
];

function decodePng(pngBuf, inversionAttempts) {
  const png = PNG.sync.read(pngBuf);
  const rgba = new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength);
  return jsQR(rgba, png.width, png.height, { inversionAttempts })?.data ?? null;
}

console.log('=== 用 jsQR 解码我们生成的二维码 ===（应全部通过；超长内容由实现主动报错，不画假码）===');
/*
 * 每条内容都按**两种模式**解码：
 *   dontInvert  —— 严格模式：只有标准朝向能解出。等价于微信扫一扫这类正规扫描器。
 *   attemptBoth —— jsQR 默认值，会把反色图也试一遍。
 *
 * 为什么必须加 dontInvert：只跑 attemptBoth 的话，"整个二维码是反色的"这种 bug
 * **照样能通过测试**，而真机上微信根本扫不出来（这正是本文件最早只有 7/7 却说明不了问题的原因）。
 * 2026-09-18 用这条口径实测：我们的矩阵 dontInvert 能解出、反色画法则解不出 → 朝向标准。
 */
let pass = 0;
for (const text of cases) {
  const matrix = qrMatrix(text);
  const pngBuf = matrixToPng(matrix);
  const strict = decodePng(pngBuf, 'dontInvert');
  const lenient = decodePng(pngBuf, 'attemptBoth');
  const ok = strict === text && lenient === text;
  if (ok) pass += 1;
  console.log(
    `  ${ok ? '✅' : '❌'} 尺寸 ${matrix.length}×${matrix.length}  ` +
      `严格=${strict === text ? '一致' : strict === null ? '(解不出)' : JSON.stringify(strict).slice(0, 40)}  ` +
      `宽松=${lenient === text ? '一致' : lenient === null ? '(解不出)' : '不一致'}  ← ${text.slice(0, 36)}`,
  );
}

console.log('');
console.log('=== 与第三方库的矩阵对比（同内容、同 ECL=M）===');
/*
 * 2026-09-18 修正一处**假阳性**：原来写的是
 *     if (ref.modules.get(r, c) !== mine[r][c]) diff += 1;
 * 而 node-qrcode 的 BitMatrix.get() 返回的是 **数字 1/0**，我的是**布尔 true/false**，
 * 严格不等号跨类型必然为真 → 于是每一格都算"不同"，33×33 报 1089、29×29 报 841，
 * 看起来像"整个二维码都是错的"。实际用 jsQR 的 dontInvert（严格模式）解码完全正确。
 * 修法：两边都归一化成布尔再比。这与本项目反复出现的"把工具自身的实现差异当成对方的缺陷"是同一类错误。
 *
 * 注意：即使归一到布尔，矩阵也**不要求**逐格相同 —— 掩码选择由各实现按惩罚分自行决定
 * （本实现遍历 8 种掩码取最优，平局取序号小的），不同实现选到不同掩码是完全合法的，
 * 只要格式信息与掩码号自洽、能被解码。故这里只把"差异比例"作为参考信息，不作为失败条件。
 */
for (const text of cases.slice(0, 3)) {
  const mine = qrMatrix(text);
  const ref = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const refSize = ref.modules.size;
  let diff = 0;
  if (refSize === mine.length) {
    for (let r = 0; r < refSize; r += 1) {
      for (let c = 0; c < refSize; c += 1) {
        if (!!ref.modules.get(r, c) !== !!mine[r][c]) diff += 1;
      }
    }
  } else {
    diff = -1;
  }
  const total = refSize * refSize;
  console.log(
    diff === -1
      ? `  ❌ 尺寸不同（我这 ${mine.length} / 参照 ${refSize}）  ← ${text.slice(0, 30)}`
      : `  ${diff === 0 ? '✅ 完全一致' : `ℹ️ ${diff}/${total} 个模块不同（掩码选择不同，双方均合法且可解码）`}  ← ${text.slice(0, 30)}`,
  );
}

console.log('');
console.log(pass === cases.length ? `✅ 全部 ${cases.length} 例可被 jsQR 正确解码` : `❌ 仅 ${pass}/${cases.length} 例可解码`);
process.exit(pass === cases.length ? 0 : 1);
