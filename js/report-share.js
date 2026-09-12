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

/** 中文按字断行；同时尊重已有的 \n */
function wrapText(ctx, text, maxWidth, maxLines = Infinity) {
  const out = [];
  for (const paragraph of String(text || '').split('\n')) {
    if (out.length >= maxLines) break;
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
        if (out.length >= maxLines) break;
      } else {
        line = test;
      }
    }
    if (line && out.length < maxLines) out.push(line);
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

  let qrDrawn = false;
  if (/^https?:\/\//.test(shareUrl)) {
    const qrImg = await loadImage(qrCodeImageUrl(shareUrl, 300), 6000);
    if (qrImg) {
      try {
        ctx.fillStyle = '#ffffff';
        roundRect(ctx, qrX - 8, qrY - 8, qrSize + 16, qrSize + 16, 10);
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
