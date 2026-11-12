/**
 * 10 秒片 A 版（暮色丛林隐喻版）逐帧渲染器
 * 依据：docs/影视广告10秒30秒实施蓝本.md §2.1 分镜表
 *
 * 产物：frames/f0000.png … f0299.png（1080×1920 @30fps，共 300 帧）
 * 跑法：node gen-frames.mjs [起始帧] [结束帧]   （支持分段跑，便于失败续跑）
 *
 * 为什么用程序化渲染而不是 AI 生成：
 *   本机没有视频生成工具；五段分镜全部是"光效 + 粒子 + 剪影"构成，
 *   用 SVG 图层能精确控制时码、品牌色（#FF6B81/#6C5CE7）与安全区。
 *   本片即为**时码/音效/字幕母版**——蓝本 §4 的 AI 质感背景日后可
 *   逐镜替换底板，不动节奏、不动声音、不动字幕。
 */
import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const W = 1080, H = 1920, FPS = 30, N = 300;
const OUT = path.join(__dirname, 'frames');
fs.mkdirSync(OUT, { recursive: true });

// ---------- 品牌与色彩 ----------
const MAGENTA = '#FF6B81', VIOLET = '#6C5CE7', GOLD = '#E8B04B';
const INK = '#0A1410'; // 底色基调（深青绿黑）

// ---------- 工具 ----------
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ramp = (t, a, b) => clamp((t - a) / (b - a || 1e-9), 0, 1);
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const easeInOut = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
// 可复现随机（蓝本要求：同种子重渲染结果一致）
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 静态资产 ----------
const logoB64 = fs.readFileSync(path.join(ROOT, 'logo', '1024-1024.png')).toString('base64');
const FONTS = [
  'C:/Windows/Fonts/HarmonyOS_Sans_SC_Bold.ttf',
  'C:/Windows/Fonts/HarmonyOS_Sans_SC_Medium.ttf',
  'C:/Windows/Fonts/HarmonyOS_Sans_SC_Regular.ttf',
].filter(p => fs.existsSync(p));

// ---------- 场景静态几何（种子固定，帧间一致） ----------
const rng = mulberry32(20261030);
// 森林地面剪影：三层贝塞尔土丘
const floorLayers = [0, 1, 2].map(li => {
  const baseY = H - (110 - li * 55);
  let d = `M -50 ${H + 50} L -50 ${baseY}`;
  for (let x = -50; x <= W + 50; x += 120) {
    d += ` Q ${x + 60} ${baseY - 40 - rng() * 90} ${x + 120} ${baseY - rng() * 30}`;
  }
  d += ` L ${W + 50} ${H + 50} Z`;
  return { d, fill: ['#101E18', '#0C1712', '#081009'][li] };
});
// 树冠剪影（顶部两角，小片 foliage，避免读作"幕布"）
const canopy = `
  <path d="M -20 -20 L 300 -20 Q 220 60 120 90 Q 40 110 -20 130 Z" fill="#081009" opacity="0.75"/>
  <path d="M ${W + 20} -20 L 780 -20 Q 860 70 950 100 Q 1020 120 ${W + 20} 150 Z" fill="#081009" opacity="0.75"/>`;
// S3 石板小径（透视收缩，向灭点 540,990）
const slabs = [];
for (let i = 0; i < 9; i++) {
  const p = 1 - i / 8;
  slabs.push({
    y: 990 + 890 * Math.pow(p, 1.6),
    w: 60 + 620 * Math.pow(p, 1.4),
    h: 10 + 58 * Math.pow(p, 1.4),
  });
}
// S3 萤火虫（环境组）
const fireflies = Array.from({ length: 46 }, () => ({
  x0: lerp(140, W - 140, rng()), y0: lerp(700, 1750, rng()),
  r: lerp(2.2, 5, rng()), sp: lerp(0.06, 0.16, rng()), ph: rng() * Math.PI * 2,
  amp: lerp(10, 34, rng()), drift: lerp(-14, -40, rng()),
  c: [MAGENTA, VIOLET, '#FFF0F5'][Math.floor(rng() * 3)],
}));
// S4 汇聚粒子（旋涡组：更近的起始半径 + 拖尾，让"收拢"可读）
const swirl = Array.from({ length: 70 }, () => {
  const a = rng() * Math.PI * 2;
  const r0 = lerp(380, 700, rng());
  return { a, r0, sz: lerp(2.5, 5, rng()), ph: rng() * Math.PI * 2 };
});
// 全局尘埃
const motes = Array.from({ length: 18 }, () => ({
  x: rng() * W, y: rng() * H, r: lerp(1.5, 3, rng()), sp: lerp(4, 12, rng()), ph: rng() * 6.28,
}));

// ---------- 通用图层 ----------
const DEFS = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0B1A14"/><stop offset="0.55" stop-color="#081209"/><stop offset="1" stop-color="#050A07"/>
    </linearGradient>
    <linearGradient id="shaft" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFF7EC" stop-opacity="0.55"/><stop offset="1" stop-color="#FFF7EC" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${MAGENTA}"/><stop offset="1" stop-color="${VIOLET}"/>
    </linearGradient>
    <radialGradient id="gMag"><stop offset="0" stop-color="#FFF0F5"/><stop offset="0.25" stop-color="${MAGENTA}"/><stop offset="1" stop-color="${MAGENTA}" stop-opacity="0"/></radialGradient>
    <radialGradient id="gVio"><stop offset="0" stop-color="#EDEAFF"/><stop offset="0.25" stop-color="${VIOLET}"/><stop offset="1" stop-color="${VIOLET}" stop-opacity="0"/></radialGradient>
    <radialGradient id="gGold"><stop offset="0" stop-color="#FFE9C4"/><stop offset="0.3" stop-color="${GOLD}"/><stop offset="1" stop-color="${GOLD}" stop-opacity="0"/></radialGradient>
    <radialGradient id="dPink"><stop offset="0" stop-color="#D96A7A" stop-opacity="0.9"/><stop offset="0.55" stop-color="#D96A7A" stop-opacity="0.65"/><stop offset="1" stop-color="#D96A7A" stop-opacity="0"/></radialGradient>
    <radialGradient id="dRose"><stop offset="0" stop-color="#C25A6E" stop-opacity="0.9"/><stop offset="0.55" stop-color="#B24E62" stop-opacity="0.6"/><stop offset="1" stop-color="#B24E62" stop-opacity="0"/></radialGradient>
    <radialGradient id="dGold"><stop offset="0" stop-color="#E8B04B" stop-opacity="0.85"/><stop offset="0.55" stop-color="#E8B04B" stop-opacity="0.5"/><stop offset="1" stop-color="#E8B04B" stop-opacity="0"/></radialGradient>
    <linearGradient id="mist" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#DCEFE6" stop-opacity="0.05"/><stop offset="1" stop-color="#DCEFE6" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="vign" cx="0.5" cy="0.45" r="0.85">
      <stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.6"/>
    </radialGradient>
    <filter id="bS" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="4"/></filter>
    <filter id="bM" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="12"/></filter>
    <filter id="bL" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="30"/></filter>
    <filter id="bXL" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="52"/></filter>
  </defs>`;

const glow = (x, y, r, grad, op) =>
  `<circle cx="${x}" cy="${y}" r="${r}" fill="url(#${grad})" opacity="${op}"/>`;
const dot = (x, y, r, c, op) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}" opacity="${op}"/>`;
// 失焦光斑（bokeh）：径向渐变圆盘替代模糊滤镜（性能：滤镜是 16s/帧的瓶颈）
const disc = (x, y, r, grad, op) =>
  `<circle cx="${x}" cy="${y}" r="${r}" fill="url(#${grad})" opacity="${op}"/>`;

// 双描边字幕（resvg 无 paint-order 保险写法：先描边层后填充层）
function subtitle(x, y, size, spans, opacity, weight = 700) {
  const fillPass = spans.map(s => `<tspan fill="${s.c || '#FFFFFF'}">${s.t}</tspan>`).join('');
  const strokePass = spans
    .map(s => `<tspan fill="none" stroke="#0A1410" stroke-width="10" stroke-linejoin="round">${s.t}</tspan>`)
    .join('');
  return `<g opacity="${opacity}" font-family="HarmonyOS Sans SC" font-weight="${weight}" font-size="${size}">
    <text x="${x}" y="${y}" text-anchor="middle">${strokePass}</text>
    <text x="${x}" y="${y}" text-anchor="middle">${fillPass}</text>
  </g>`;
}

// ---------- 分镜（蓝本 §2.1 时码表，帧 = 秒 × 30） ----------
function scene1(f) { // 0–1.0s 危险钩子
  const t = f / FPS;
  let g = '';
  g += canopy;
  // 顶部中央环境光（让画面"黑而有物"）
  g += glow(540, 260, 430, 'gVio', 0.12, 'bXL');
  // 丁达尔光束两道（加强到可感知）
  g += `<polygon points="160,-40 380,-40 600,920 380,920" fill="url(#shaft)" opacity="0.16" filter="url(#bL)"/>`;
  g += `<polygon points="680,-40 840,-40 720,880 540,880" fill="url(#shaft)" opacity="0.12" filter="url(#bL)"/>`;
  // 暗处一对光点（0.15s 亮起，0.72s 熄灭）——不具象化为任何动物（IP 红线）
  const eyeOn = ramp(t, 0.15, 0.35) * (1 - ramp(t, 0.70, 0.78));
  const ey = 620 + Math.sin(t * 3) * 6;
  g += glow(470, ey, 44, 'gMag', 0.7 * eyeOn, 'bM') + glow(590, ey + 14, 44, 'gMag', 0.62 * eyeOn, 'bM');
  g += dot(470, ey, 8, '#FFE9EE', eyeOn) + dot(590, ey + 14, 8, '#FFE9EE', eyeOn);
  // 悬挂树枝剪影（给绳套一个物理参照）
  g += `<path d="M 1080 120 Q 860 300 720 520 Q 668 620 650 780" fill="none" stroke="#0D1712" stroke-width="16" stroke-linecap="round"/>`;
  // 绳套陷阱：摆入 → 0.8s 咬合收缩 → 白闪
  const snap = ramp(t, 0.80, 0.88);
  const sw = Math.sin(t * 2.2) * 6 * (1 - snap);
  g += `<g transform="rotate(${sw} 640 820)"><ellipse cx="640" cy="880" rx="${lerp(130, 46, easeOutCubic(snap))}" ry="${lerp(92, 34, easeOutCubic(snap))}" fill="none" stroke="#4A3826" stroke-width="12" opacity="0.95"/></g>`;
  if (snap > 0 && snap < 1) {
    const fr = lerp(60, 190, snap);
    g += `<circle cx="640" cy="880" r="${fr}" fill="none" stroke="#FFF0F5" stroke-width="${lerp(7, 1.5, snap)}" opacity="${0.9 * (1 - snap)}"/>`;
  }
  // 地面剪影三层（最上层加品牌色轮廓光）
  floorLayers.forEach((l, i) => {
    g += `<path d="${l.d}" fill="${l.fill}"${i === 0 ? ` stroke="${MAGENTA}" stroke-opacity="0.14" stroke-width="3"` : ''}/>`;
  });
  return g;
}

function scene2(f) { // 1.0–2.4s 玫瑰与刺（微距浅焦，主体居左、字幕区避让）
  const t = f / FPS;
  let g = '';
  // 失焦玫瑰花团（右上大光斑 bokeh + 玫瑰底光）
  g += glow(830, 470, 270, 'gMag', 0.12);
  const bo = [[790, 400, 100, 'dPink', 0.5], [910, 560, 74, 'dGold', 0.4], [700, 290, 64, 'dRose', 0.45],
              [960, 370, 54, 'dPink', 0.35], [650, 470, 88, 'dRose', 0.32], [880, 700, 66, 'dGold', 0.25]];
  bo.forEach(([x, y, r, grad, o]) => { g += disc(x, y, r, grad, o); });
  // 茎（居左，上段右倾），字幕带内只剩细茎穿过
  g += `<path d="M 200 1980 C 300 1620 340 1330 400 1060" fill="none" stroke="#24473A" stroke-width="30" stroke-linecap="round"/>`;
  g += `<path d="M 224 1956 C 316 1620 354 1330 410 1075" fill="none" stroke="${VIOLET}" stroke-width="5" opacity="0.55" filter="url(#bS)"/>`;
  // 叶片（都在字幕带上沿以上）
  g += `<path d="M 288 1300 Q 200 1230 170 1120 Q 290 1140 340 1230 Z" fill="#1B3A2C"/>`;
  g += `<path d="M 372 1085 Q 460 1030 505 930 Q 380 950 330 1030 Z" fill="#1B3A2C"/>`;
  // 刺（加大）：1.8–2.2s 锐化 + 紫光泛起
  const th = easeOutCubic(ramp(t, 1.8, 2.2));
  g += `<g transform="translate(358 1215) scale(${lerp(1.5, 1.72, th)})">
    <path d="M -46 36 L 14 -60 L 56 44 Z" fill="#2E5140"/>
    <path d="M 14 -60 L 56 44 L 26 34 Z" fill="${VIOLET}" opacity="${lerp(0.3, 0.9, th)}"/></g>`;
  g += glow(372, 1172, lerp(14, 34, th), 'gVio', 0.55 * th, 'bM');
  // 露珠
  [[268, 1440, 8], [318, 1140, 6], [238, 1700, 9]].forEach(([x, y, r]) => {
    g += dot(x, y, r, '#EAF6FF', 0.9) + dot(x - r * 0.3, y - r * 0.3, r * 0.32, '#FFFFFF', 0.95);
  });
  return g;
}

function scene3(f) { // 2.4–4.6s 萤光小径
  const t = f / FPS;
  let g = '';
  g += canopy;
  // 地平线暖光
  g += glow(540, 985, 520, 'gGold', 0.30 * ramp(t, 2.55, 3.1), 'bXL');
  // 石板逐块点亮
  slabs.forEach((s, i) => {
    const lit = ramp(t, 2.5 + i * 0.17, 2.78 + i * 0.17);
    g += `<rect x="${540 - s.w / 2}" y="${s.y - s.h / 2}" width="${s.w}" height="${s.h}" rx="${s.h / 2}" fill="#16241C"/>`;
    if (lit > 0) {
      g += `<rect x="${540 - s.w / 2}" y="${s.y - s.h / 2}" width="${s.w}" height="${s.h}" rx="${s.h / 2}" fill="url(#gMag)" opacity="${0.42 * lit}"/>`;
      g += `<rect x="${540 - s.w / 2 + 8}" y="${s.y - s.h / 2 - 2}" width="${s.w - 16}" height="4" rx="2" fill="${MAGENTA}" opacity="${0.7 * lit}"/>`;
    }
  });
  // 萤火虫群（升腾 + 闪烁）
  fireflies.forEach(p => {
    const ft = t;
    const x = p.x0 + Math.sin(ft * p.sp * 6 + p.ph) * p.amp;
    const y = p.y0 + p.drift * ft + Math.cos(ft * p.sp * 5 + p.ph) * p.amp * 0.6;
    const tw = 0.35 + 0.65 * Math.abs(Math.sin(ft * p.sp * 9 + p.ph));
    g += glow(x, y, p.r * 4.2, p.c === VIOLET ? 'gVio' : 'gMag', 0.5 * tw) + dot(x, y, p.r, p.c, 0.9 * tw);
  });
  // 底部雾气
  g += `<rect x="0" y="${H - 320}" width="${W}" height="320" fill="url(#mist)"/>`;
  return g;
}

function scene4(f) { // 4.6–7.0s 萤光汇聚成环
  const t = f / FPS;
  const cx = 540, cy = 810, R = 330;
  // 粒子运动函数：半径先快后慢收拢，角度匀加速旋入
  const swirlPos = (s, tt) => {
    const p = 1 - Math.pow(1 - ramp(tt, 4.6, 6.2), 2); // easeOut：早期就开始收拢
    const r = lerp(s.r0, R + Math.sin(tt * 2 + s.ph) * 8, p);
    const a = s.a + p * Math.PI * 3.4;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.96];
  };
  let g = '';
  swirl.forEach(s => {
    const [x, y] = swirlPos(s, t);
    const [px, py] = swirlPos(s, t - 0.033);
    const tw = 0.4 + 0.6 * Math.abs(Math.sin(t * 7 + s.ph));
    // 拖尾（沿切线方向的短线段）
    g += `<line x1="${px.toFixed(1)}" y1="${py.toFixed(1)}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#FFD9E0" stroke-width="${s.sz}" stroke-linecap="round" opacity="${0.35 * tw}"/>`;
    g += glow(x, y, s.sz * 4, 'gMag', 0.42 * tw) + dot(x, y, s.sz, '#FFD9E0', 0.85 * tw);
  });
  // 渐变圆环逐步成形（stroke-dasharray 推进，提前到 5.0s 起画）
  const C = 2 * Math.PI * R;
  const ringP = ramp(t, 5.0, 6.05);
  if (ringP > 0) {
    g += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="url(#ringGrad)" stroke-width="14"
      stroke-linecap="round" stroke-dasharray="${C * ringP} ${C}" transform="rotate(-90 ${cx} ${cy})"
      opacity="${0.95}" filter="url(#bS)"/>`;
    g += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="url(#ringGrad)" stroke-width="30"
      stroke-dasharray="${C * ringP} ${C}" transform="rotate(-90 ${cx} ${cy})" opacity="${0.16}"/>`;
  }
  // 6.2s 起官方 Logo（渐变圆环+艺术字「问」）叠入
  const logoIn = ramp(t, 6.15, 6.7);
  if (logoIn > 0) {
    const pulse = 1 + 0.012 * Math.sin((t - 6.2) * Math.PI * 2 * 0.8);
    g += `<image href="data:image/png;base64,${logoB64}" x="${cx - 300 * pulse}" y="${cy - 300 * pulse}" width="${600 * pulse}" height="${600 * pulse}" opacity="${logoIn}"/>`;
  }
  return g;
}

function scene5(f) { // 7.0–10.0s 共用品牌尾（定版 + CTA）
  const t = f / FPS;
  let g = '';
  // 品牌尾延续 S4 的 Logo（在 S4 已淡入），此处只加文字层
  const mainIn = ramp(t, 7.15, 7.5);
  g += subtitle(540, 1196, 74, [{ t: '18–30 岁避坑地图' }], mainIn, 700);
  const pillIn = ramp(t, 7.35, 7.7);
  if (pillIn > 0) {
    g += `<g opacity="${pillIn}">
      <rect x="${540 - 190}" y="1258" width="380" height="104" rx="52" fill="${INK}" fill-opacity="0.55" stroke="#FFFFFF" stroke-opacity="0.35" stroke-width="2.5"/>
      <text x="540" y="1326" text-anchor="middle" font-family="HarmonyOS Sans SC" font-size="54" font-weight="500" fill="#FFFFFF">搜索 <tspan fill="${MAGENTA}" font-weight="700">Q问</tspan></text>
    </g>`;
  }
  const aiIn = ramp(t, 7.5, 7.8);
  g += `<text x="92" y="1692" font-family="HarmonyOS Sans SC" font-size="27" font-weight="400" fill="#FFFFFF" opacity="${0.55 * aiIn}">内容由 AI 辅助生成</text>`;
  return g;
}

// ---------- 帧合成 ----------
function frame(f) {
  const t = f / FPS;
  const o1 = 1 - ramp(f, 27, 35);              // S1 出
  const o2 = ramp(f, 29, 37) * (1 - ramp(f, 68, 76));  // S2 进/出
  const o3 = ramp(f, 70, 78) * (1 - ramp(f, 133, 141)); // S3 进/出
  const o4 = ramp(f, 136, 144);                // S4 进（保持到尾）
  // 全局缓慢推近（只作用于场景，不作用于字幕 UI）
  const zoom = lerp(1.0, 1.05, t / 10);
  // 陷阱咬合抖屏（0.8–1.0s 衰减）
  const shakeA = 9 * (1 - ramp(f, 24, 32));
  const sx = shakeA ? (rng() * 2 - 1) * shakeA : 0; // 注意：抖屏允许非确定性，视觉噪声
  const sy = shakeA ? (rng() * 2 - 1) * shakeA * 0.6 : 0;

  let body = '';
  body += `<g opacity="${o1}">${scene1(f)}</g>`;
  body += `<g opacity="${o2}">${scene2(f)}</g>`;
  body += `<g opacity="${o3}">${scene3(f)}</g>`;
  body += `<g opacity="${o4}">${scene4(f)}</g>`;
  body += scene5(f);

  // 字幕层（蓝本：单行 ≤12 字、≥64px、72% 高度、白字深描边）
  let subs = '';
  const s2In = ramp(f, 30, 38) * (1 - ramp(f, 62, 70));
  subs += subtitle(540, 1382, 68, [
    { t: 'TA 是甜的，' }, { t: '还是带刺的？', c: MAGENTA },
  ], s2In);
  const s3In = ramp(f, 78, 88) * (1 - ramp(f, 126, 134));
  subs += subtitle(540, 1382, 60, [{ t: '感情的丛林，坑不会提前打招呼' }], s3In, 700);

  // 尘埃（贯穿全片）
  let dust = '';
  motes.forEach(m => {
    const x = (m.x + t * m.sp * 3) % W, y = (m.y - t * m.sp) % H;
    dust += dot(x < 0 ? x + W : x, y < 0 ? y + H : y, m.r, '#CFE8DC', 0.1);
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${DEFS}
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <g transform="translate(${540 + sx} ${960 + sy}) scale(${zoom}) translate(-540 -960)">${body}${dust}</g>
  ${subs}
  <rect width="${W}" height="${H}" fill="url(#vign)"/>
  <rect width="${W}" height="${H}" fill="#000" opacity="${ramp(f, 281, 298)}"/>
</svg>`;
  return svg;
}

// ---------- 渲染主循环 ----------
const [from, to] = [Number(process.argv[2] || 0), Math.min(Number(process.argv[3] || N - 1), N - 1)];
const resvgOpt = {
  fitTo: { mode: 'original' },
  background: 'rgba(0,0,0,0)',
  font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'HarmonyOS Sans SC' },
};
let lastPct = -1;
for (let f = from; f <= to; f++) {
  const svg = frame(f);
  const png = new Resvg(svg, resvgOpt).render().asPng();
  fs.writeFileSync(path.join(OUT, `f${String(f).padStart(4, '0')}.png`), png);
  const pct = Math.floor(((f - from + 1) / (to - from + 1)) * 100);
  if (pct >= lastPct + 10) { lastPct = pct; console.log(`[frames] ${pct}% (f=${f})`); }
}
console.log(`[frames] done ${from}-${to}`);
