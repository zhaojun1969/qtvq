/**
 * 配对报告分享长图（Canvas 合成）
 *
 * 与现站「直线行动卡」(`js/action-card.js`) 同一套思路：纯前端 Canvas 出图、直接下载，
 * 不需要后端 native 模块 —— 计划书原来要 node-canvas，而 Cloudflare/无 native 环境跑不了。
 *
 * 二维码：复用 `js/qr-render.js`（quickchart.io）。刻意设置 `crossOrigin='anonymous'`：
 *   - 对方返回 CORS 头 → 图片可画，canvas 不被污染；
 *   - 对方没有 CORS 头 → 触发 onerror，我们直接跳过二维码、改画链接文字，
 *     **不会**污染 canvas（否则 toDataURL 会抛 SecurityError，分享图直接失败）。
 * 加载设了超时，避免二维码服务慢的时候把整个分享流程卡住。
 */
import { qrCodeImageUrl } from './qr-render.js';

const W = 750;
const PAD = 48;

const COLORS = {
  pink: '#ff6b81',
  purple: '#6c5ce7',
  bg: '#0f0e17',
  card: '#1a1928',
  elevated: '#242338',
  text: '#f5f5f7',
  muted: '#a0a0b0',
};

const FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * 中文按字断行；同时尊重已有的 \n。
 *
 * 被 `maxLines` 截断时**必须在末行补省略号**：不补的话，句子会停在半句上
 * （实测避坑卡的长结论停在“把他的失约解释成”，看起来像渲染坏了，
 * 用户会以为报告本身写崩了，而不是“这里还有更多”）。
 */
function wrapText(ctx, text, maxWidth, maxLines = Infinity) {
  const out = [];
  let truncated = false;
  for (const paragraph of String(text || '').split('\n')) {
    if (out.length >= maxLines) {
      truncated = true;
      break;
    }
    if (!paragraph) {
      out.push('');
      continue;
    }
    let line = '';
    for (const ch of paragraph) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxWidth && line) {
        out.push(line);
        line = ch;
        if (out.length >= maxLines) {
          truncated = true;
          break;
        }
      } else {
        line = test;
      }
    }
    if (line) {
      if (out.length < maxLines) out.push(line);
      else truncated = true;
    }
  }

  if (truncated && out.length) {
    let last = out.length - 1;
    while (last >= 0 && !out[last]) last -= 1; // 跳过段落之间的空行
    if (last >= 0) {
      let s = out[last];
      // 逐字回退，保证加上省略号后仍不超宽（宁可再少一个字，也不能出界）
      while (s && ctx.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
      out[last] = `${s}…`;
    }
  }
  return out;
}

/** 圆形头像；没有图/加载失败时退回「昵称首字」色块，绝不画空圈 */
async function loadImage(src, timeoutMs = 5000) {
  if (!src) return null;
  if (typeof Image === 'undefined') return null;
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve(null), timeoutMs);
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    img.src = src;
  });
}

function drawAvatar(ctx, { img, name, x, y, r, ring }) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (img) {
    ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
  } else {
    const grad = ctx.createLinearGradient(x - r, y - r, x + r, y + r);
    grad.addColorStop(0, COLORS.pink);
    grad.addColorStop(1, COLORS.purple);
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = `bold ${Math.round(r * 0.9)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(name || '?').trim().charAt(0) || '?', x, y + 2);
  }
  ctx.restore();

  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.lineWidth = 4;
  ctx.strokeStyle = ring || COLORS.pink;
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function pct(v) {
  return `${Math.round((Number(v) || 0) * 100)}%`;
}

/**
 * 渲染分享长图
 * @param {object} report 后端返回的报告对象（含 overall/scores/labels/basis/content/pitfalls/me/target/tierZh）
 * @param {{shareUrl?:string, brand?:string}} [opts]
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function renderReportCard(report, opts = {}) {
  const brand = opts.brand || '我心永恒 · Q问';
  const shareUrl = opts.shareUrl || 'https://qtvq.cn';

  const me = report?.me || {};
  const target = report?.target || {};
  const dims = Object.keys(report?.scores || {});
  const labels = report?.labels || {};
  const pitfalls = Array.isArray(report?.pitfalls) ? report.pitfalls.slice(0, 3) : [];

  // ---- 先量后画：用临时 canvas 计算换行与总高度 ----
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = `16px ${FONT}`;
  const contentLines = wrapText(probe, report?.content || '', W - PAD * 2 - 8, 26);
  const targetName = String(target.nickname || 'TA');
  const meName = String(me.nickname || '我');

  const HEADER_H = 168;
  const PAIR_H = 250;
  const DIM_H = dims.length ? dims.length * 62 + 20 : 0;
  const CONTENT_H = contentLines.length * 32 + 56;
  const PITFALL_H = pitfalls.length ? pitfalls.length * 34 + 52 : 0;
  const FOOTER_H = 210;
  const H = HEADER_H + PAIR_H + DIM_H + CONTENT_H + PITFALL_H + FOOTER_H + PAD;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // 背景
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  // ---- 头部渐变 ----
  const headGrad = ctx.createLinearGradient(0, 0, W, HEADER_H);
  headGrad.addColorStop(0, COLORS.pink);
  headGrad.addColorStop(1, COLORS.purple);
  ctx.fillStyle = headGrad;
  ctx.fillRect(0, 0, W, HEADER_H);

  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.font = `bold 34px ${FONT}`;
  ctx.fillText('配对报告', PAD, 78);
  ctx.font = `20px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.fillText(`${report?.tierZh || ''} · ${brand}`, PAD, 116);
  ctx.font = `18px ${FONT}`;
  ctx.fillText('转一圈，遇见TA · qtvq.cn', PAD, 146);

  // ---- 双方 + 契合度 ----
  let y = HEADER_H + 40;
  const [imgMe, imgTa] = await Promise.all([loadImage(me.avatar), loadImage(target.avatar)]);
  const avatarR = 58;
  drawAvatar(ctx, { img: imgMe, name: meName, x: W / 2 - 130, y: y + avatarR, r: avatarR });
  drawAvatar(ctx, { img: imgTa, name: targetName, x: W / 2 + 130, y: y + avatarR, r: avatarR, ring: COLORS.purple });

  ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.text;
  ctx.font = `bold 44px ${FONT}`;
  ctx.fillText(pct(report?.overall), W / 2, y + avatarR + 8);
  ctx.font = `16px ${FONT}`;
  ctx.fillStyle = COLORS.muted;
  ctx.fillText('综合契合度', W / 2, y + avatarR + 38);
  ctx.textAlign = 'left';

  ctx.font = `18px ${FONT}`;
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'center';
  ctx.fillText(meName.slice(0, 8), W / 2 - 130, y + avatarR * 2 + 30);
  ctx.fillText(targetName.slice(0, 8), W / 2 + 130, y + avatarR * 2 + 30);
  ctx.textAlign = 'left';

  y += PAIR_H;

  // ---- 三维度 ----
  if (dims.length) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = `18px ${FONT}`;
    ctx.fillText('契合度维度', PAD, y);
    y += 26;

    for (const key of dims) {
      const label = labels[key] || key;
      const v = Math.max(0, Math.min(1, Number(report.scores[key]) || 0));

      ctx.fillStyle = COLORS.text;
      ctx.font = `17px ${FONT}`;
      ctx.fillText(label, PAD, y + 22);
      ctx.fillStyle = COLORS.pink;
      ctx.textAlign = 'right';
      ctx.fillText(pct(v), W - PAD, y + 22);
      ctx.textAlign = 'left';

      const barX = PAD;
      const barY = y + 36;
      const barW = W - PAD * 2;
      ctx.fillStyle = COLORS.elevated;
      roundRect(ctx, barX, barY, barW, 12, 6);
      ctx.fill();
      if (v > 0) {
        const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
        grad.addColorStop(0, COLORS.pink);
        grad.addColorStop(1, COLORS.purple);
        ctx.fillStyle = grad;
        roundRect(ctx, barX, barY, Math.max(12, barW * v), 12, 6);
        ctx.fill();
      }
      y += 62;
    }
    y += 20;
  }

  // ---- 正文 ----
  {
    ctx.fillStyle = COLORS.card;
    roundRect(ctx, PAD - 8, y, W - (PAD - 8) * 2, contentLines.length * 32 + 40, 16);
    ctx.fill();

    ctx.fillStyle = COLORS.text;
    ctx.font = `16px ${FONT}`;
    let ty = y + 36;
    for (const line of contentLines) {
      ctx.fillText(line, PAD, ty);
      ty += 32;
    }
    if (report?.content && contentLines.length >= 26) {
      ctx.fillStyle = COLORS.muted;
      ctx.fillText('……完整报告请打开链接查看', PAD, ty);
    }
    y += CONTENT_H;
  }

  // ---- 避坑案例 ----
  if (pitfalls.length) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = `18px ${FONT}`;
    ctx.fillText('涉及的避坑案例', PAD, y + 8);
    let py = y + 44;
    ctx.font = `16px ${FONT}`;
    for (const p of pitfalls) {
      ctx.fillStyle = COLORS.pink;
      ctx.fillText('·', PAD, py);
      ctx.fillStyle = COLORS.text;
      const t = `${p.title || ''}${p.category ? `（${p.category}）` : ''}`;
      ctx.fillText(t.length > 26 ? `${t.slice(0, 26)}…` : t, PAD + 16, py);
      py += 34;
    }
    y += PITFALL_H;
  }

  // ---- 页脚 + 二维码 ----
  ctx.fillStyle = COLORS.elevated;
  ctx.fillRect(0, H - FOOTER_H, W, FOOTER_H);

  const qrSize = 132;
  const qrX = W - PAD - qrSize;
  const qrY = H - FOOTER_H + 38;
  // 静区同样要 ≥ 4 个模块：132px 画 29×29 模块时单模块 ≈ 4.55px，19px ≈ 4.2 个模块
  const qrPad = 19;

  let qrDrawn = false;
  /*
   * 小程序码优先（2026-10-29 · T2.4）：scene 里带 8 位短码，扫码直接进小程序并归因。
   * 地址由调用方通过 options.miniCodeUrl 传入（形如 /v1/report/minicode/card.png?ch=xhs01）。
   * 拿不到（接口 503 / 图加载失败 / 未登录）一律退回 H5 短链二维码 —— 分享卡不能因为
   * 小程序码挂掉而整体出不了图。
   */
  let drawnMiniCode = false;
  // 注意：本文件有两套入口（renderAdviceCard 用 options、renderReportCard 用 opts），
  // 直接写 typeof options?.x 在 opts 那条路上会抛 ReferenceError（2026-10-29 走查抓到 pair 画不出图）。
  const miniCodeUrl = typeof options !== 'undefined' && typeof options?.miniCodeUrl === 'string' ? options.miniCodeUrl : '';
  if (miniCodeUrl) {
    const full = /^https?:\/\//.test(options.miniCodeUrl) ? options.miniCodeUrl : `${location.origin}${options.miniCodeUrl}`;
    const miniImg = await loadImage(full, 6000);
    if (miniImg) {
      try {
        ctx.fillStyle = '#ffffff';
        roundRect(ctx, qrX - qrPad, qrY - qrPad, qrSize + qrPad * 2, qrSize + qrPad * 2, 10);
        ctx.fill();
        // 小程序码是方图 JPEG，按短边居中绘制，避免被拉伸
        const side = Math.min(miniImg.width, miniImg.height);
        const sx = (miniImg.width - side) / 2;
        const sy = (miniImg.height - side) / 2;
        ctx.drawImage(miniImg, sx, sy, side, side, qrX, qrY, qrSize, qrSize);
        qrDrawn = true;
        drawnMiniCode = true;
      } catch {
        qrDrawn = false;
      }
    }
  }
  if (!qrDrawn && /^https?:\/\//.test(shareUrl)) {
    const qrImg = await loadImage(qrCodeImageUrl(shareUrl, 300), 6000);
    if (qrImg) {
      try {
        ctx.fillStyle = '#ffffff';
        roundRect(ctx, qrX - qrPad, qrY - qrPad, qrSize + qrPad * 2, qrSize + qrPad * 2, 10);
        ctx.fill();
        ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);
        qrDrawn = true;
      } catch {
        qrDrawn = false;
      }
    }
  }

  const textW = qrDrawn ? W - PAD * 2 - qrSize - 24 : W - PAD * 2;
  ctx.fillStyle = COLORS.text;
  ctx.font = `bold 20px ${FONT}`;
  ctx.fillText('扫码看完整报告', PAD, H - FOOTER_H + 66);

  ctx.fillStyle = COLORS.muted;
  ctx.font = `14px ${FONT}`;
  const urlLines = wrapText(ctx, shareUrl, textW, 3);
  let uy = H - FOOTER_H + 96;
  for (const l of urlLines) {
    ctx.fillText(l, PAD, uy);
    uy += 22;
  }

  ctx.fillStyle = COLORS.muted;
  ctx.font = `13px ${FONT}`;
  ctx.fillText('本报告由算法打分 + AI 生成，仅供沟通参考，不构成任何承诺。', PAD, H - 26);

  return canvas;
}

/**
 * 生成并下载分享长图
 * @returns {Promise<{ok:true, filename:string}|{ok:false, error:string}>}
 */
export async function downloadReportCard(report, opts = {}) {
  if (typeof document === 'undefined') return { ok: false, error: '当前环境不支持出图' };
  try {
    const canvas = await renderReportCard(report, opts);
    const dataUrl = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.download = `Q问配对报告-${(report?.target?.nickname || 'TA').slice(0, 8)}.png`;
    a.href = dataUrl;
    a.click();
    return { ok: true, filename: a.download };
  } catch (err) {
    return { ok: false, error: err?.message || '生成分享图失败' };
  }
}

// ---------------------------------------------------------------- 避坑/复盘卡

/**
 * 避坑卡 / 复盘卡（T2.4）
 *
 * 为什么是**浏览器端 canvas**、而不是实施书原本写的「服务端 resvg + OSS」：
 *   · 服务器 `fc-list` 里**一个中文字体都没有**，resvg/sharp 渲染中文会全变方框；
 *     补字体要么上传几十 MB 字体文件、要么改系统包，代价远大于收益；
 *   · 二维码本来就由 `js/qr-render.js` 在浏览器端算（纯 JS、零依赖、已有反解校验）；
 *   · 出图不需要服务端存储：用户点「保存」直接下载到相册，没有 OSS 费用与清理问题。
 * 代价是「分享卡」只能在浏览器里生成，无法在服务端批量预热 —— 本场景不需要。
 *
 * 版式固定 750×1334（9:16，微信/小红书通用），内容按槽位截断，宁可少一行也不出界。
 */
const ADVICE_META = {
  diagnose: { title: '避坑诊断', sub: '你的处境 → 风险点 · 对照案例 · 行动清单' },
  retro: { title: '关系复盘', sub: '双方视角 → 时间线 · 冲突模式 · 挽救或止损' },
  pair: { title: '配对报告', sub: '资料语义 + 真实避坑案例' },
};

export async function renderAdviceCard(report, opts = {}) {
  if (typeof document === 'undefined') throw new Error('当前环境不支持出图');
  const CW = 750;
  const CH = 1334;
  const canvas = document.createElement('canvas');
  canvas.width = CW;
  canvas.height = CH;
  const ctx = canvas.getContext('2d');
  const meta = ADVICE_META[report?.kind] || ADVICE_META.diagnose;

  const sec = report?.sections || {};
  const summary = String(sec.summary || report?.content || '').split('\n')[0].trim() || '先把自己从这段关系里抽出来看一眼。';
  const risks = (Array.isArray(sec.risks) ? sec.risks : []).slice(0, 3);
  const actions = (Array.isArray(sec.actions) ? sec.actions : []).slice(0, 3);
  const cases = (Array.isArray(sec.cases) ? sec.cases : []).slice(0, 2);

  // 背景
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, CW, CH);

  // 顶部品牌渐变
  const HEAD = 196;
  {
    const g = ctx.createLinearGradient(0, 0, CW, HEAD);
    g.addColorStop(0, COLORS.pink);
    g.addColorStop(1, COLORS.purple);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CW, HEAD);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = `20px ${FONT}`;
    ctx.fillText('Q问 · 我心永恒', PAD, 56);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 46px ${FONT}`;
    ctx.fillText(meta.title, PAD, 116);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = `18px ${FONT}`;
    ctx.fillText(meta.sub, PAD, 158);
  }

  let y = HEAD + 44;

  // 核心结论：最多 4 行、行高 42
  {
    ctx.fillStyle = COLORS.card;
    roundRect(ctx, PAD - 12, y - 34, CW - (PAD - 12) * 2, 232, 20);
    ctx.fill();
    ctx.fillStyle = COLORS.pink;
    ctx.font = `bold 16px ${FONT}`;
    ctx.fillText('核心结论', PAD, y - 6);
    ctx.fillStyle = COLORS.text;
    ctx.font = `bold 27px ${FONT}`;
    const lines = wrapText(ctx, summary, CW - PAD * 2, 4);
    let cy = y + 34;
    for (const line of lines) {
      ctx.fillText(line, PAD, cy);
      cy += 42;
    }
    y += 232;
  }

  // 风险点（最多 3 条）
  y += 30;
  if (risks.length) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = `18px ${FONT}`;
    ctx.fillText('风险点', PAD, y);
    y += 34;
    ctx.font = `20px ${FONT}`;
    for (const r of risks) {
      const lines = wrapText(ctx, r, CW - PAD * 2 - 28, 2);
      ctx.fillStyle = COLORS.pink;
      ctx.fillText('·', PAD, y);
      ctx.fillStyle = COLORS.text;
      for (const [i, line] of lines.entries()) {
        ctx.fillText(line, PAD + 20, y + i * 30);
      }
      y += lines.length * 30 + 10;
    }
    y += 16;
  }

  // 行动清单（最多 3 条，编号）
  if (actions.length) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = `18px ${FONT}`;
    ctx.fillText('今天就能做的三件事', PAD, y);
    y += 36;
    ctx.font = `20px ${FONT}`;
    for (const [i, a] of actions.entries()) {
      const lines = wrapText(ctx, a, CW - PAD * 2 - 44, 2);
      ctx.fillStyle = COLORS.purple;
      ctx.font = `bold 20px ${FONT}`;
      ctx.fillText(`${i + 1}`, PAD + 4, y);
      ctx.fillStyle = COLORS.text;
      ctx.font = `20px ${FONT}`;
      for (const [j, line] of lines.entries()) {
        ctx.fillText(line, PAD + 32, y + j * 30);
      }
      y += lines.length * 30 + 12;
    }
    y += 10;
  }

  // 对照案例（最多 2 条，弱化）
  if (cases.length) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = `16px ${FONT}`;
    for (const c of cases) {
      const lines = wrapText(ctx, `案例：${c}`, CW - PAD * 2, 1);
      ctx.fillText(lines[0] || '', PAD, y);
      y += 26;
    }
  }

  // 页脚：二维码 + 免责声明
  const FOOT = 240;
  {
    ctx.fillStyle = COLORS.elevated;
    ctx.fillRect(0, CH - FOOT, CW, FOOT);
    const qrSize = 150;
    const qrX = CW - PAD - qrSize;
    const qrY = CH - FOOT + 44;
    /*
     * 白边 21px：二维码规范要求**静区 ≥ 4 个模块**，而 150px 画 29×29 模块时
     * 单模块 ≈ 5.17px，原来只留 9px ≈ 1.74 个模块（实测 jsQR 仍能解出，但
     * 微信/系统相机这类容错更差的扫码器容易失败）。21 ≈ 4.06 个模块，刚好达标。
     */
    const qrPad = 21;
    const shareUrl = String(opts.shareUrl || '');
    let qrDrawn = false;
    if (/^https?:\/\//.test(shareUrl)) {
      const img = await loadImage(qrCodeImageUrl(shareUrl, 320), 6000);
      if (img) {
        try {
          ctx.fillStyle = '#ffffff';
          roundRect(ctx, qrX - qrPad, qrY - qrPad, qrSize + qrPad * 2, qrSize + qrPad * 2, 12);
          ctx.fill();
          ctx.drawImage(img, qrX, qrY, qrSize, qrSize);
          qrDrawn = true;
        } catch {
          qrDrawn = false;
        }
      }
    }
    ctx.fillStyle = COLORS.text;
    ctx.font = `bold 22px ${FONT}`;
    ctx.fillText('扫码看我的完整报告', PAD, CH - FOOT + 76);
    ctx.fillStyle = COLORS.muted;
    ctx.font = `16px ${FONT}`;
    const textW = qrDrawn ? CW - PAD * 2 - qrSize - 28 : CW - PAD * 2;
    const urlLines = wrapText(ctx, shareUrl.replace(/^https?:\/\//, ''), textW, 2);
    let uy = CH - FOOT + 110;
    for (const l of urlLines) {
      ctx.fillText(l, PAD, uy);
      uy += 24;
    }
    ctx.fillStyle = COLORS.muted;
    ctx.font = `13px ${FONT}`;
    ctx.fillText('AI 生成内容，仅供关系决策参考，不构成心理诊断或医疗建议。', PAD, CH - 32);
  }

  return canvas;
}

/** 保存避坑/复盘卡到本地；埋点由调用方负责（避免把分析逻辑塞进绘图模块） */
export async function downloadAdviceCard(report, opts = {}) {
  if (typeof document === 'undefined') return { ok: false, error: '当前环境不支持出图' };
  try {
    const canvas = await renderAdviceCard(report, opts);
    const dataUrl = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    const meta = ADVICE_META[report?.kind] || ADVICE_META.diagnose;
    a.download = `Q问${meta.title}-${new Date().toISOString().slice(0, 10)}.png`;
    a.href = dataUrl;
    a.click();
    return { ok: true, filename: a.download };
  } catch (err) {
    return { ok: false, error: err?.message || '生成分享图失败' };
  }
}
