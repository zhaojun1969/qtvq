/**
 * 30 秒片（信任片）逐帧渲染器
 * 依据：docs/影视广告10秒30秒实施蓝本.md §3.1 分镜与旁白总表
 *
 * 产物：frames/f0000.png … f0899.png（1080×1920 @30fps，共 900 帧）
 * 跑法：node gen-frames.mjs [起始帧] [结束帧]
 *
 * 五段结构（秒）：
 *   ① 0.0–4.6  真实案例钩子（聊天记录还原 → 转账 → 黑屏字幕）
 *   ② 4.9–11.0 隐喻桥（丁达尔空镜 + 分岔小径剪影）
 *   ③ 11.0–21.0 产品演示（避坑诊断：输入 → 生成 → 三段滚动）
 *   ④ 21.0–26.5 信任层（案例库翻页 + 三行资质）
 *   ⑤ 26.5–30.0 共用品牌尾 + CTA
 *
 * 与 10 秒片同工艺：程序化渲染（motion-graphics），本片即**时码/音效/字幕/VO 母版**。
 * ③ 的产品界面按主站真实设计令牌（css/styles.css :root）与真实服务文案
 * （server/src/services/report-diagnose.js 三段式 + 7 天可观察指标）重排，
 * 送审前须按 §3.2 用真机录屏替换（见蓝本 §7.2 偏离记录）。
 */
import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const W = 1080, H = 1920, FPS = 30, N = 900;
const OUT = path.join(__dirname, 'frames');
fs.mkdirSync(OUT, { recursive: true });

// ---------- 品牌与色彩（与主站 tokens 对齐） ----------
const MAGENTA = '#FF6B81', VIOLET = '#6C5CE7', GOLD = '#E8B04B';
const INK = '#0A1410';
const UI_BG = '#0F0E17', CARD = '#1A1928', CARD2 = '#242338';
const TXT = '#F5F5F7', MUTED = '#A0A0B0', FAINT = '#707080';
const SUCCESS = '#5AD07A';

// ---------- 工具 ----------
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ramp = (t, a, b) => clamp((t - a) / (b - a || 1e-9), 0, 1);
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const easeInOut = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const easeOutBack = t => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// 确定性抖动（帧间连续，避免 rng 顺序依赖）
const wob = (t, k = 1) => Math.sin(t * 137.7 * k) * 0.5 + Math.sin(t * 61.3 * k + 1.7) * 0.5;
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- 静态资产 ----------
const logoB64 = fs.readFileSync(path.join(ROOT, 'logo', '1024-1024.png')).toString('base64');
const FONTS = [
  'C:/Windows/Fonts/HarmonyOS_Sans_SC_Bold.ttf',
  'C:/Windows/Fonts/HarmonyOS_Sans_SC_Medium.ttf',
  'C:/Windows/Fonts/HarmonyOS_Sans_SC_Regular.ttf',
].filter(p => fs.existsSync(p));

// ---------- 场景静态几何 ----------
const rng = mulberry32(20261031);
const floorLayers = [0, 1, 2].map(li => {
  const baseY = H - (110 - li * 55);
  let d = `M -50 ${H + 50} L -50 ${baseY}`;
  for (let x = -50; x <= W + 50; x += 120) {
    d += ` Q ${x + 60} ${baseY - 40 - rng() * 90} ${x + 120} ${baseY - rng() * 30}`;
  }
  d += ` L ${W + 50} ${H + 50} Z`;
  return { d, fill: ['#101E18', '#0C1712', '#081009'][li] };
});
const canopy = `
  <path d="M -20 -20 L 300 -20 Q 220 60 120 90 Q 40 110 -20 130 Z" fill="#081009" opacity="0.78"/>
  <path d="M ${W + 20} -20 L 780 -20 Q 860 70 950 100 Q 1020 120 ${W + 20} 150 Z" fill="#081009" opacity="0.78"/>
  <path d="M 430 -20 Q 470 70 520 110 Q 560 60 600 -20 Z" fill="#081009" opacity="0.55"/>`;
const fireflies = Array.from({ length: 40 }, () => ({
  x0: lerp(120, W - 120, rng()), y0: lerp(780, 1780, rng()),
  r: lerp(2.2, 4.6, rng()), sp: lerp(0.06, 0.15, rng()), ph: rng() * Math.PI * 2,
  amp: lerp(10, 30, rng()), drift: lerp(-10, -30, rng()),
  c: [MAGENTA, VIOLET, '#FFF0F5'][Math.floor(rng() * 3)],
}));
const motes = Array.from({ length: 16 }, () => ({
  x: rng() * W, y: rng() * H, r: lerp(1.5, 3, rng()), sp: lerp(4, 11, rng()), ph: rng() * 6.28,
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
    <linearGradient id="ctaGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${MAGENTA}"/><stop offset="1" stop-color="${VIOLET}"/>
    </linearGradient>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0F0E17" stop-opacity="0"/><stop offset="0.35" stop-color="#0F0E17" stop-opacity="0.88"/><stop offset="1" stop-color="#0F0E17" stop-opacity="0.97"/>
    </linearGradient>
    <radialGradient id="gMag"><stop offset="0" stop-color="#FFF0F5"/><stop offset="0.25" stop-color="${MAGENTA}"/><stop offset="1" stop-color="${MAGENTA}" stop-opacity="0"/></radialGradient>
    <radialGradient id="gVio"><stop offset="0" stop-color="#EDEAFF"/><stop offset="0.25" stop-color="${VIOLET}"/><stop offset="1" stop-color="${VIOLET}" stop-opacity="0"/></radialGradient>
    <radialGradient id="gGold"><stop offset="0" stop-color="#FFE9C4"/><stop offset="0.3" stop-color="${GOLD}"/><stop offset="1" stop-color="${GOLD}" stop-opacity="0"/></radialGradient>
    <radialGradient id="mist" gradientUnits="userSpaceOnUse" cx="540" cy="1760" r="500">
      <stop offset="0" stop-color="#DCEFE6" stop-opacity="0.07"/><stop offset="1" stop-color="#DCEFE6" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="vign" cx="0.5" cy="0.45" r="0.85">
      <stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.62"/>
    </radialGradient>
    <linearGradient id="topScrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#020604" stop-opacity="0.92"/><stop offset="0.55" stop-color="#020604" stop-opacity="0.35"/><stop offset="1" stop-color="#020604" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="topFadeUI" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0F0E17" stop-opacity="1"/><stop offset="1" stop-color="#0F0E17" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="bottomScrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0F0E17" stop-opacity="0"/><stop offset="0.4" stop-color="#0F0E17" stop-opacity="0.62"/><stop offset="1" stop-color="#0F0E17" stop-opacity="0.9"/>
    </linearGradient>
    <linearGradient id="horizonFog" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#152A22" stop-opacity="0.95"/><stop offset="0.5" stop-color="#152A22" stop-opacity="0.5"/><stop offset="1" stop-color="#152A22" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="pathGrad" x1="0" y1="1" x2="0.3" y2="0">
      <stop offset="0" stop-color="#1B3125"/><stop offset="0.55" stop-color="#14261C"/><stop offset="1" stop-color="#0B1710"/>
    </linearGradient>
    <linearGradient id="pathGrad2" x1="1" y1="1" x2="0.7" y2="0">
      <stop offset="0" stop-color="#17281E"/><stop offset="0.55" stop-color="#111D16"/><stop offset="1" stop-color="#0A140E"/>
    </linearGradient>
    <radialGradient id="fogbg" cx="0.5" cy="0.56" r="0.78">
      <stop offset="0" stop-color="#33513F"/><stop offset="0.42" stop-color="#1B3A2C"/><stop offset="1" stop-color="#050D09"/>
    </radialGradient>
    <radialGradient id="fogbg2" cx="0.5" cy="0.62" r="0.8">
      <stop offset="0" stop-color="#263F35"/><stop offset="0.45" stop-color="#152A22"/><stop offset="1" stop-color="#040A07"/>
    </radialGradient>
    <radialGradient id="gHaze"><stop offset="0" stop-color="#CFE8DC" stop-opacity="0.20"/><stop offset="0.55" stop-color="#CFE8DC" stop-opacity="0.06"/><stop offset="1" stop-color="#CFE8DC" stop-opacity="0"/></radialGradient>
    <radialGradient id="violetPool" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${VIOLET}" stop-opacity="0.55"/><stop offset="1" stop-color="${VIOLET}" stop-opacity="0"/>
    </radialGradient>
    <filter id="bS" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="4"/></filter>
    <filter id="bM" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="12"/></filter>
    <filter id="bL" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="30"/></filter>
    <clipPath id="repClip"><rect x="0" y="392" width="1080" height="1528"/></clipPath>
  </defs>`;

const glow = (x, y, r, grad, op) => `<circle cx="${x}" cy="${y}" r="${r}" fill="url(#${grad})" opacity="${op}"/>`;
const dot = (x, y, r, c, op) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}" opacity="${op}"/>`;
const T = (x, y, size, str, opt = {}) => {
  const { c = TXT, w = 400, op = 1, anchor = 'start', ls = 0, fam = 'HarmonyOS Sans SC' } = opt;
  return `<text x="${x}" y="${y}" font-family="${fam}" font-size="${size}" font-weight="${w}" fill="${c}" opacity="${op}" text-anchor="${anchor}"${ls ? ` letter-spacing="${ls}"` : ''}>${esc(str)}</text>`;
};
// 双描边字幕（先描边层后填充层，resvg 兼容写法）
function subtitle(x, y, size, spans, opacity, weight = 700) {
  const fillPass = spans.map(s => `<tspan fill="${s.c || '#FFFFFF'}">${esc(s.t)}</tspan>`).join('');
  const strokePass = spans
    .map(s => `<tspan fill="none" stroke="#0A1410" stroke-width="10" stroke-linejoin="round">${esc(s.t)}</tspan>`)
    .join('');
  return `<g opacity="${opacity}" font-family="HarmonyOS Sans SC" font-weight="${weight}" font-size="${size}">
    <text x="${x}" y="${y}" text-anchor="middle">${strokePass}</text>
    <text x="${x}" y="${y}" text-anchor="middle">${fillPass}</text>
  </g>`;
}
// 中文按字宽排版：CJK=1em，ASCII≈0.55em
const tw = (s, size) => [...s].reduce((a, ch) => a + (ch.charCodeAt(0) > 127 ? size : size * 0.56), 0);
function wrap(s, size, maxW) {
  const lines = []; let cur = '', w = 0;
  for (const ch of s) {
    const cw = ch.charCodeAt(0) > 127 ? size : size * 0.56;
    if (w + cw > maxW && cur) { lines.push(cur); cur = ch; w = cw; } else { cur += ch; w += cw; }
  }
  if (cur) lines.push(cur);
  // 中文禁则处理：行首不出现标点
  const BAD = '，。、；：？！）】》」』%…,.;:?!)]}';
  for (let i = 1; i < lines.length; i++) {
    while (lines[i].length > 1 && BAD.includes(lines[i][0])) {
      lines[i - 1] += lines[i][0];
      lines[i] = lines[i].slice(1);
    }
  }
  return lines;
}


// =====================================================================
// ① 0.0–4.6s 真实案例钩子（聊天记录还原）
// =====================================================================
const CHAT_MSGS = [
  { side: 'L', t0: 0.28, lines: ['宝，我这边临时周转不开，', '急死我了'] },
  { side: 'L', t0: 0.86, lines: ['你先转我 3 万，备注写借款，', '这样有保障'] },
  { side: 'R', t0: 1.46, lines: ['好，我这就转'] },
];
const BUBBLE = { x0: 96, maxW: 760, pad: 34, lh: 52, size: 38 };

function chatScreen(t) {
  let g = `<rect width="${W}" height="${H}" fill="${UI_BG}"/>`;
  // 顶部状态 + 标题栏
  g += T(64, 82, 28, '22:14', { c: MUTED, w: 500 });
  g += `<rect x="946" y="62" width="44" height="20" rx="6" fill="none" stroke="${MUTED}" stroke-width="2.4"/>`;
  g += `<rect x="950" y="66" width="30" height="12" rx="3" fill="${MUTED}"/>`;
  g += `<rect x="898" y="64" width="30" height="16" rx="3" fill="${MUTED}"/>`;
  g += `<path d="M 56 172 L 84 200 L 56 228" fill="none" stroke="${TXT}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`;
  g += T(540, 214, 40, '对方', { w: 700, anchor: 'middle' });
  g += `<line x1="0" y1="252" x2="${W}" y2="252" stroke="#000" stroke-opacity="0.45" stroke-width="2"/>`;

  // 历史分隔
  g += T(540, 316, 26, '今天 21:47', { c: FAINT, anchor: 'middle' });

  // 气泡
  let y = 366;
  CHAT_MSGS.forEach((m, i) => {
    const appear = ramp(t, m.t0, m.t0 + 0.12);
    if (appear <= 0) { y += 0; return; }
    const h = m.lines.length * BUBBLE.lh + 44;
    const wMax = Math.max(...m.lines.map(l => tw(l, BUBBLE.size)));
    const bw = wMax + BUBBLE.pad * 2;
    const left = m.side === 'L';
    const bx = left ? 100 : W - 118 - bw;
    // 头像
    const avX = left ? 62 : W - 62;
    g += `<circle cx="${avX}" cy="${y + 34}" r="26" fill="#2A2940"/>`;
    g += T(avX, y + 44, 24, left ? '对' : '我', { c: MUTED, anchor: 'middle' });
    // 气泡
    g += `<g opacity="${appear}" transform="translate(0 ${(1 - easeOutCubic(appear)) * 18})">
      <rect x="${bx}" y="${y}" width="${bw}" height="${h}" rx="22" fill="${left ? CARD : 'url(#ctaGrad)'}"/>
      ${m.lines.map((ln, li) => T(bx + BUBBLE.pad, y + 34 + 30 + li * BUBBLE.lh, BUBBLE.size, ln, { c: left ? TXT : '#FFFFFF', w: 400 })).join('')}
    </g>`;
    y += h + 34;
  });

  // 底部输入栏
  const io = ramp(t, 0.1, 0.4);
  g += `<g opacity="${0.92 * io}">
    <rect x="0" y="1700" width="${W}" height="220" fill="#14131F"/>
    <rect x="56" y="1746" width="720" height="92" rx="46" fill="${CARD2}"/>
    ${T(96, 1806, 32, '说点什么…', { c: FAINT })}
    <rect x="806" y="1746" width="218" height="92" rx="46" fill="url(#ctaGrad)"/>
    ${T(915, 1806, 32, '发送', { c: '#FFFFFF', w: 700, anchor: 'middle' })}
  </g>`;
  return g;
}

// 转账面板（1.72s 起滑入）
function transferSheet(t) {
  const pin = ramp(t, 1.72, 2.10);
  if (pin <= 0) return '';
  const yOff = (1 - easeOutCubic(pin)) * 760;
  let g = `<g transform="translate(0 ${yOff.toFixed(1)})">`;
  // 背板压暗
  g += `<rect width="${W}" height="${H}" fill="#000" opacity="${0.55 * pin}"/>`;
  g += `<rect x="0" y="1120" width="${W}" height="800" rx="36" fill="${CARD}"/>`;
  g += `<rect x="470" y="1156" width="140" height="8" rx="4" fill="${CARD2}"/>`;
  g += T(60, 1250, 32, '转账给 对方', { c: MUTED });
  // 金额键入（1.85–2.52）
  const amount = '30000';
  const typ = Math.floor(clamp((t - 1.85) / 0.67, 0, 1) * amount.length + 0.0001);
  const shown = amount.slice(0, Math.max(0, typ));
  g += T(58, 1352, 44, '¥', { c: TXT, w: 700 });
  g += T(112, 1354, 96, shown.replace(/\B(?=(\d{3})+(?!\d))/g, ','), { c: TXT, w: 700 });
  const caretOn = typ < amount.length || Math.sin(t * 12) > 0;
  if (typ < amount.length && caretOn) g += `<rect x="${112 + tw(shown, 96) + 6}" y="1286" width="4" height="76" fill="${MAGENTA}"/>`;
  // 备注
  const noteIn = ramp(t, 2.52, 2.70);
  g += `<line x1="60" y1="1408" x2="1020" y2="1408" stroke="${CARD2}" stroke-width="2"/>`;
  g += T(60, 1472, 32, '备注', { c: MUTED });
  if (noteIn > 0) {
    const hl = ramp(t, 2.62, 2.90);
    g += `<g opacity="${noteIn}">
      <rect x="150" y="1436" width="150" height="56" rx="12" fill="${MAGENTA}" fill-opacity="${0.14 * hl}"/>
      ${T(176, 1478, 36, '借款', { c: hl > 0.15 ? MAGENTA : TXT, w: 700 })}
    </g>`;
    // 圈注
    if (hl > 0.1) {
      g += `<ellipse cx="225" cy="1462" rx="${lerp(50, 88, easeOutCubic(hl))}" ry="${lerp(24, 38, easeOutCubic(hl))}"
        fill="none" stroke="${MAGENTA}" stroke-width="3.5" opacity="${0.9 * hl}" stroke-dasharray="6 5"/>`;
    }
  }
  // 确认按钮
  const press = ramp(t, 2.94, 3.04);
  const ok = ramp(t, 3.04, 3.24);
  if (ok <= 0) {
    g += `<g transform="translate(540 1580) scale(${1 - 0.03 * press}) translate(-540 -1580)">
      <rect x="60" y="1524" width="960" height="112" rx="56" fill="url(#ctaGrad)"/>
      ${T(540, 1596, 40, '确认转账', { c: '#FFFFFF', w: 700, anchor: 'middle' })}
    </g>`;
  } else {
    g += `<g opacity="${ok}">
      <circle cx="540" cy="1580" r="${lerp(30, 46, easeOutBack(ok))}" fill="${SUCCESS}" fill-opacity="0.16" stroke="${SUCCESS}" stroke-width="4"/>
      <path d="M 518 1580 L 534 1596 L 564 1562" fill="none" stroke="${SUCCESS}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
      ${T(540, 1676, 34, '转账成功', { c: SUCCESS, anchor: 'middle', w: 500 })}
    </g>`;
  }
  g += `</g>`;
  return g;
}

function sec1(f) {
  const t = f / FPS;
  const dim = ramp(t, 3.30, 3.76);           // 屏幕渐暗
  let g = chatScreen(t);
  g += transferSheet(t);
  if (dim > 0) g += `<rect width="${W}" height="${H}" fill="#05070A" opacity="${easeInOut(dim)}"/>`;
  return g;
}

// 段末黑屏字幕卡（3.5–5.15s 覆盖在 ① 之上，② 淡入时退出）
function blackCard(f) {
  const t = f / FPS;
  const pin = ramp(t, 3.52, 3.90);
  const pout = ramp(f, 150, 166);            // 5.0–5.53s
  if (pin <= 0 || pout >= 1) return '';
  const op = easeOutCubic(pin) * (1 - easeInOut(pout));
  return `<g opacity="${op}">
    <rect width="${W}" height="${H}" fill="#05070A"/>
    ${subtitle(540, 900, 62, [{ t: '三个月后，' }], 1)}
    ${subtitle(540, 992, 62, [{ t: '这三万成了说不清的债。' }], 1)}
    <rect x="${540 - 70}" y="1050" width="140" height="4" rx="2" fill="${MAGENTA}" opacity="0.85"/>
  </g>`;
}

// =====================================================================
// ② 4.9–11.0s 隐喻桥（暮色丛林：逆光丁达尔空镜 → 分岔小径）
// 布光：光在背景（雾），树干全部为暗剪影 —— 逆光森林的物理关系
// =====================================================================
const TRUNKS = [
  // [远] 被雾吃掉一部分，暗但发灰
  { x: 118, w: 36, c: '#16302A', o: 0.55, top: -110, bot: 1500 },
  { x: 296, w: 28, c: '#16302A', o: 0.5, top: -60, bot: 1500 },
  { x: 512, w: 32, c: '#16302A', o: 0.46, top: -150, bot: 1490 },
  { x: 748, w: 30, c: '#16302A', o: 0.52, top: -90, bot: 1500 },
  { x: 918, w: 36, c: '#16302A', o: 0.5, top: -130, bot: 1500 },
  { x: 1042, w: 28, c: '#16302A', o: 0.44, top: -70, bot: 1500 },
  // [中] 正片剪影
  { x: 40, w: 64, c: '#0A1812', o: 0.97, lean: 22, top: -140, bot: 1560 },
  { x: 250, w: 46, c: '#0A1812', o: 0.93, lean: -18, top: -60, bot: 1560 },
  { x: 700, w: 54, c: '#0A1812', o: 0.96, lean: 16, top: -120, bot: 1560 },
  { x: 880, w: 60, c: '#0A1812', o: 0.93, lean: -12, top: -70, bot: 1560 },
  { x: 1016, w: 48, c: '#0A1812', o: 0.9, lean: 10, top: -150, bot: 1560 },
  // [近] 压到纯黑做框
  { x: -40, w: 120, c: '#030806', o: 1, lean: 10, top: 30, bot: 1920 },
  { x: 158, w: 86, c: '#030806', o: 1, lean: 20, top: -20, bot: 1920 },
  { x: 966, w: 100, c: '#030806', o: 1, lean: -16, top: -30, bot: 1920 },
  { x: 1140, w: 94, c: '#030806', o: 1, lean: -8, top: 50, bot: 1920 },
];
function trunkGeom(k) {
  const { x, w, c, o, lean = 0, top = -80, bot = 1540 } = k;
  const bx = x + lean * 0.55;
  return `<path d="M ${x - w / 2} ${top} L ${x + w / 2} ${top} Q ${bx + w * 0.58} ${(top + bot) / 2} ${bx + w * 0.62} ${bot} L ${bx - w * 0.62} ${bot} Q ${bx - w * 0.56} ${(top + bot) / 2} ${x - w * 0.5} ${top} Z" fill="${c}" opacity="${o}"/>`;
}
const TRUNK_FAR = TRUNKS.slice(0, 6).map(trunkGeom).join('');
const TRUNK_MID = TRUNKS.slice(6, 11).map(trunkGeom).join('');
const TRUNK_NEAR = TRUNKS.slice(11).map(trunkGeom).join('');
// 顶部压暗（代替叶簇块，保持干净）
const FOLIAGE = `<rect x="0" y="0" width="${W}" height="820" fill="url(#topScrim)"/>`;
// 树枝（斜向，打断垂直）
const BRANCHES = `
  <g stroke="#060F0A" stroke-linecap="round" fill="none" opacity="0.95">
    <path d="M 700 500 q 92 -84 156 -178" stroke-width="14"/>
    <path d="M 250 760 q -66 -58 -112 -146" stroke-width="11"/>
  </g>`;
const GROUND = `
  <path d="M -50 1920 L -50 1600 Q 200 1544 420 1572 Q 720 1614 1130 1560 L 1130 1920 Z" fill="#0A1610"/>
  <path d="M -50 1920 L -50 1664 Q 260 1612 520 1642 Q 800 1678 1130 1622 L 1130 1920 Z" fill="#061009"/>
  <path d="M -50 1920 L -50 1736 Q 320 1694 620 1720 Q 880 1744 1130 1704 L 1130 1920 Z" fill="#030805"/>`;
const shaftPoly = (x0, x1, xt0, xt1, op) =>
  `<polygon points="${x0},-90 ${x1},-90 ${xt1},1580 ${xt0},1580" fill="url(#shaft)" opacity="${op}" filter="url(#bS)"/>`;

function fireflyLayer(t, alpha = 1, y0 = 4.9) {
  let g = '';
  fireflies.forEach(p => {
    const x = p.x0 + Math.sin(t * p.sp * 6 + p.ph) * p.amp;
    const y = p.y0 + p.drift * (t - y0) + Math.cos(t * p.sp * 5 + p.ph) * p.amp * 0.6;
    const tk = 0.35 + 0.65 * Math.abs(Math.sin(t * p.sp * 9 + p.ph));
    g += glow(x, y, p.r * 5, p.c === VIOLET ? 'gVio' : 'gMag', 0.5 * tk * alpha)
      + dot(x, y, p.r, p.c, 0.9 * tk * alpha);
  });
  return g;
}

function shot2A(t) { // 4.9–7.5 丁达尔空镜
  let g = `<rect width="${W}" height="${H}" fill="url(#fogbg)"/>`;
  // 背景雾光（光在树后）
  g += glow(560, 1020, 700, 'gHaze', 1.15);
  g += glow(540, 1240, 330, 'gGold', 0.20 + 0.05 * ramp(t, 5.3, 7.2));
  g += TRUNK_FAR;
  // 光束（穿行于中景树之间）
  g += shaftPoly(240, 470, 392, 700, 0.30 + 0.03 * Math.sin(t * 0.9));
  g += shaftPoly(600, 770, 668, 862, 0.22 + 0.03 * Math.cos(t * 0.7));
  g += shaftPoly(80, 220, 158, 344, 0.15);
  g += TRUNK_MID;
  g += BRANCHES;
  g += GROUND;
  g += glow(520, 1548, 340, 'gGold', 0.16 + 0.04 * ramp(t, 5.4, 7.2));
  g += FOLIAGE;
  g += TRUNK_NEAR;
  g += fireflyLayer(t, 0.9);
  return g;
}

function shot2B(t) { // 7.4–11.0 分岔小径 + 人影剪影
  const cx = 540;
  let g = `<rect width="${W}" height="${H}" fill="url(#fogbg2)"/>`;
  g += glow(cx, 1080, 620, 'gHaze', 0.85);
  g += TRUNK_FAR;

  // 两条小径（透视梯形路面，向前收窄；不用等宽带）
  const litL = ramp(t, 7.9, 9.3);
  g += `<polygon points="150,1920 462,1920 556,1330 448,1330" fill="url(#pathGrad)"/>`;
  g += `<polygon points="618,1920 930,1920 632,1330 524,1330" fill="url(#pathGrad2)"/>`;
  // 左路面被紫光点亮
  g += `<polygon points="150,1920 462,1920 556,1330 448,1330" fill="${VIOLET}" opacity="${0.18 * litL}"/>`;
  g += `<line x1="300" y1="1900" x2="500" y2="1348" stroke="#D6CFFF" stroke-width="3" opacity="${0.5 * litL}" stroke-dasharray="12 22"/>`;
  // 右路面只留一线冷反光
  g += `<polygon points="618,1920 930,1920 632,1330 524,1330" fill="#7C8C7F" opacity="${0.055 * litL}"/>`;
  g += `<line x1="790" y1="1900" x2="580" y2="1348" stroke="#7A7360" stroke-width="3" opacity="${0.4 * litL}" stroke-dasharray="9 24"/>`;
  g += TRUNK_MID;
  g += BRANCHES;

  // 右侧荆棘丛（三簇，读得出"拦路"）
  const thorn = ramp(t, 8.2, 9.4);
  if (thorn > 0) {
    const clusters = [[cx + 210, 1760, 1.0], [cx + 140, 1580, 0.85], [cx + 78, 1420, 0.66]];
    clusters.forEach(([bx, by, sc], ci) => {
      g += `<g transform="translate(${bx} ${by}) scale(${sc})" opacity="${thorn * (0.75 + 0.25 * Math.sin(t * 2 + ci))}">
        <path d="M -52 26 q 10 -46 40 -56 q 34 -12 56 14 q 18 24 6 46 Z" fill="#101B12"/>
        <path d="M -26 0 l -14 -34 M -4 -10 l 2 -38 M 18 -4 l 16 -32 M 38 4 l 22 -22 M -44 14 l -20 -20"
          stroke="#6B4A2E" stroke-width="5" stroke-linecap="round" fill="none"/>
        <path d="M -40 -30 l -8 -12 M 6 -48 l 4 -12 M 34 -36 l 10 -10" stroke="#8A6238" stroke-width="4" stroke-linecap="round" fill="none"/>
      </g>`;
    });
    // 缠在右路牌柱上的藤
    g += `<path d="M ${788 + 6} 900 q 22 60 -8 120 q -26 54 6 108" fill="none" stroke="#4A3626" stroke-width="6" opacity="${thorn * 0.9}"/>`;
  }

  g += GROUND;
  g += `<rect x="0" y="1240" width="${W}" height="220" fill="url(#horizonFog)"/>`;
  g += glow(cx, 1500, 420, 'violetPool', 0.22);

  // 路牌（左紫光 / 右荆棘）
  const signIn = ramp(t, 7.8, 8.4);
  const sign = (bx, label, glowIt, bad) => {
    let s = `<g opacity="${signIn}">
      <rect x="${bx - 8}" y="900" width="16" height="330" fill="#1D3A2C" stroke="#000" stroke-opacity="0.5" stroke-width="2"/>
      <rect x="${bx - 130}" y="828" width="260" height="104" rx="6" fill="#0D1A14" stroke="${bad ? '#3E2E1E' : '#4A3F7A'}" stroke-width="3"/>
      <path d="M ${bx - 130} 852 q 65 14 130 0 q 65 -14 130 0 M ${bx - 130} 906 q 65 14 130 0 q 65 -14 130 0" fill="none" stroke="${bad ? '#2E2314' : '#2A2450'}" stroke-width="2" opacity="0.8"/>
      ${T(bx, 894, 40, label, { c: bad ? '#BFA98C' : '#DCD5FF', anchor: 'middle', w: 500 })}`;
    if (glowIt) s += glow(bx, 880, 230, 'violetPool', 0.7 * signIn * glowIt);
    s += glow(bx, 946, 120, glowIt ? 'violetPool' : 'gGold', 0.22 * signIn);
    if (bad) s += `<path d="M ${bx - 132} 848 q 66 30 134 6 q 62 -22 130 12" fill="none" stroke="#6B4A2E" stroke-width="5" opacity="0.9"/>
      <path d="M ${bx - 98} 842 l -6 18 M ${bx - 28} 846 l 8 16 M ${bx + 46} 842 l -6 18" fill="none" stroke="#8A6238" stroke-width="4"/>`;
    return s + `</g>`;
  };
  g += sign(300, '一起走', 1, false);
  g += sign(792, '先转账', 0, true);

  // 人影剪影（无面部、无角色特征；落在岔口，脚在 1290）
  const figIn = ramp(t, 7.6, 8.25);
  if (figIn > 0) {
    const fx = cx + Math.sin(t * 0.8) * 2.5;
    const lift = (1 - easeOutCubic(figIn)) * 24;
    g += `<g opacity="${figIn}" transform="translate(${fx} ${1332 + lift}) scale(0.94)">
      <ellipse cx="0" cy="6" rx="92" ry="15" fill="#020604" opacity="0.85"/>
      <circle cx="0" cy="-318" r="30" fill="#040B07"/>
      <ellipse cx="0" cy="-332" rx="31" ry="24" fill="#040B07"/>
      <path d="M -50 -248 Q -54 -288 -24 -290 L 24 -290 Q 54 -288 50 -248 L 54 -150 Q 56 -122 42 -114 L -42 -114 Q -56 -122 -54 -150 Z" fill="#040B07"/>
      <path d="M -48 -112 L -52 0 L -14 0 L -10 -112 Z" fill="#040B07"/>
      <path d="M 10 -112 L 14 0 L 52 0 L 48 -112 Z" fill="#040B07"/>
      <path d="M -52 -240 Q -72 -186 -62 -134" fill="none" stroke="#040B07" stroke-width="18" stroke-linecap="round"/>
      <path d="M 52 -240 Q 72 -186 62 -134" fill="none" stroke="#040B07" stroke-width="18" stroke-linecap="round"/>
      <path d="M -48 -250 Q -52 -286 -23 -288" fill="none" stroke="${VIOLET}" stroke-width="3.5" opacity="0.7"/>
      <path d="M -52 -242 Q -70 -188 -60 -138" fill="none" stroke="${VIOLET}" stroke-width="2.5" opacity="0.5"/>
      <path d="M 26 -290 Q 50 -286 46 -252" fill="none" stroke="${MAGENTA}" stroke-width="2" opacity="0.3"/>
    </g>`;
  }
  g += FOLIAGE;
  g += TRUNK_NEAR;
  g += fireflyLayer(t, 0.6);
  return g;
}

function sec2(f) {
  const t = f / FPS;
  let g = '';
  const a = 1 - ramp(t, 7.35, 7.75);
  const b = ramp(t, 7.35, 7.85);
  if (a > 0) g += `<g opacity="${a}">${shot2A(t)}</g>`;
  if (b > 0) g += `<g opacity="${b}">${shot2B(t)}</g>`;
  return g;
}

// =====================================================================
// ③ 11.0–21.0s 产品演示（避坑诊断）
// =====================================================================
const BEZEL = `<rect x="16" y="52" width="1048" height="1816" rx="76" fill="none" stroke="#2A2940" stroke-width="9" opacity="0.9"/>
  <rect x="386" y="76" width="308" height="40" rx="20" fill="#05060A"/>`;

const INPUT_TEXT = '他让我先转三万过去，说见面就还。备注写「借款」，这算保障吗？';
const REPORT = {
  conclusion: ['指定备注「借款」，是把责任写给你，', '而不是写给他。转出前先停一步。'],
  risks: [
    { main: ['未见面就要求转账，并指定备注写「借款」——', '这是把赠与写成借贷的标准动作。'], obs: '7 天内观察：口头「见面就还」，是否始终不定日期。' },
    { main: ['钱一旦转出，聊天记录里的这两个字，', '会成为对你最不利的证据。'], obs: '7 天内观察：对方是否拒绝视频通话、拒绝共同好友见证。' },
  ],
  caseTitle: '红包陷阱：转账备注写借款',
  caseMeta: '已帮 2,847 人 · 同类案例库 50 条可查',
  actions: ['今天先不转，任何理由都不转', '把完整聊天记录导出，另存一份', '提出视频通话：两次推脱即止损'],
};

function uiHeader(t) {
  let g = `<rect width="${W}" height="${H}" fill="${UI_BG}"/>`;
  g += T(72, 150, 28, '22:14', { c: MUTED, w: 500 });
  g += `<rect x="946" y="132" width="44" height="20" rx="6" fill="none" stroke="${MUTED}" stroke-width="2.4"/>`;
  g += `<rect x="950" y="136" width="30" height="12" rx="3" fill="${MUTED}"/>`;
  g += `<path d="M 58 224 L 84 250 L 58 276" fill="none" stroke="${TXT}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`;
  g += T(540, 262, 40, '避坑诊断', { w: 700, anchor: 'middle' });
  // 角标常驻
  g += `<g>
    <rect x="592" y="304" width="424" height="56" rx="28" fill="${CARD2}"/>
    ${T(804, 342, 26, '24 小时 5 次免费提问', { c: '#C8C8D8', anchor: 'middle', w: 500 })}
  </g>`;
  g += `<line x1="0" y1="392" x2="${W}" y2="392" stroke="#000" stroke-opacity="0.4" stroke-width="2"/>`;
  return g;
}

function uiInput(t) {
  let g = '';
  // 输入卡
  g += `<rect x="52" y="430" width="976" height="360" rx="26" fill="${CARD}"/>`;
  g += T(92, 492, 28, '说说你的处境', { c: MUTED, w: 500 });
  const chars = Math.floor(clamp((t - 11.35) / 1.0, 0, 1) * INPUT_TEXT.length + 0.0001);
  const typed = INPUT_TEXT.slice(0, chars);
  const lines = wrap(typed, 36, 860);
  lines.slice(0, 3).forEach((ln, i) => { g += T(92, 560 + i * 58, 36, ln, { c: TXT }); });
  const caretY = 560 + (lines.length ? lines.length - 1 : 0) * 58;
  const caretX = 92 + tw(lines.length ? lines[lines.length - 1] : '', 36) + 4;
  if (chars < INPUT_TEXT.length || Math.sin(t * 12) > 0) {
    g += `<rect x="${caretX}" y="${caretY - 34}" width="3" height="44" fill="${MAGENTA}"/>`;
  }
  // 场景标签
  const chipIn = ramp(t, 12.3, 12.55);
  g += `<g opacity="${chipIn}">
    <rect x="52" y="826" width="240" height="66" rx="33" fill="${MAGENTA}" fill-opacity="0.16" stroke="${MAGENTA}" stroke-width="2"/>
    ${T(172, 870, 28, '涉及金钱往来', { c: MAGENTA, anchor: 'middle', w: 700 })}
    <rect x="312" y="826" width="196" height="66" rx="33" fill="${CARD}" stroke="#2A2940" stroke-width="2"/>
    ${T(410, 870, 28, '网恋 / 未见面', { c: MUTED, anchor: 'middle' })}
  </g>`;
  // CTA
  const press = ramp(t, 12.98, 13.10);
  const busy = t >= 13.10;
  g += `<g transform="translate(540 990) scale(${1 - 0.03 * press}) translate(-540 -990)">
    <rect x="52" y="918" width="976" height="120" rx="60" fill="url(#ctaGrad)"/>
    ${T(540, 992, 38, busy ? '诊断中，约 10 秒…' : '生成诊断报告 · 首单 ¥4.9', { c: '#FFFFFF', anchor: 'middle', w: 700 })}
  </g>`;
  if (busy) {
    for (let k = 0; k < 3; k++) {
      const ph = (Math.sin((t - 13.1) * 8 - k * 0.7) + 1) / 2;
      g += dot(850 + k * 22, 978, 6, '#FFFFFF', 0.35 + 0.6 * ph);
    }
  }
  // 大家在问（填满下半屏，避免空白）
  const listIn = ramp(t, 11.9, 12.3);
  const QS = ['异地半年，他从不视频', '她说先给彩礼再领证'];
  g += `<g opacity="${listIn}">
    ${T(56, 1148, 28, '大家在问 · 匿名', { c: MUTED, w: 500 })}
    ${QS.map((q, i) => {
      const y = 1204 + i * 104;
      return `<rect x="52" y="${y}" width="976" height="88" rx="18" fill="${CARD}" fill-opacity="0.7"/>
        ${T(92, y + 52, 30, q, { c: '#D8D8E2' })}
        ${T(986, y + 52, 30, '›', { c: FAINT, anchor: 'end' })}`;
    }).join('')}
  </g>`;
  return g;
}

function reportBody(t) {
  const slideIn = easeOutCubic(ramp(t, 13.55, 13.95));
  const bg = `<rect x="0" y="392" width="${W}" height="1528" fill="${UI_BG}"/>`;
  // 内容整体上滚：15.0–20.4
  const scroll = 560 * easeInOut(ramp(t, 15.0, 20.4));
  let g = `<g transform="translate(0 ${lerp(200, 0, slideIn) - scroll})">`;
  let y = 410;
  // 结论卡
  g += `<rect x="52" y="${y}" width="976" height="286" rx="26" fill="${CARD}"/>`;
  g += `<rect x="52" y="${y}" width="6" height="286" fill="url(#ctaGrad)" opacity="0.9"/>`;
  g += T(92, y + 58, 28, '核心结论', { c: MAGENTA, w: 700 });
  REPORT.conclusion.forEach((ln, i) => { g += T(92, y + 118 + i * 56, 36, ln, { c: TXT, w: 500 }); });
  y += 326;
  // 风险点
  g += `<rect x="52" y="${y}" width="976" height="536" rx="26" fill="${CARD}"/>`;
  g += T(92, y + 56, 30, '风险点', { c: TXT, w: 700 });
  let ry = y + 108;
  REPORT.risks.forEach((r, i) => {
    g += `<circle cx="104" cy="${ry + 6}" r="16" fill="${MAGENTA}" fill-opacity="0.18"/>`;
    g += T(104, ry + 14, 24, String(i + 1), { c: MAGENTA, anchor: 'middle', w: 700 });
    r.main.forEach((ln, li) => { g += T(136, ry + li * 50, 33, ln, { c: TXT }); });
    g += T(136, ry + 112, 27, r.obs, { c: MUTED });
    ry += 196;
  });
  y += 576;
  // 对照案例
  g += `<rect x="52" y="${y}" width="976" height="300" rx="26" fill="${CARD}"/>`;
  g += `<rect x="52" y="${y}" width="976" height="6" fill="url(#ctaGrad)" opacity="0.85"/>`;
  g += T(92, y + 58, 28, '对照案例', { c: VIOLET, w: 700 });
  g += T(92, y + 128, 38, REPORT.caseTitle, { c: TXT, w: 700 });
  g += T(92, y + 186, 27, REPORT.caseMeta, { c: MUTED });
  g += `<rect x="92" y="${y + 220}" width="240" height="56" rx="28" fill="${CARD2}"/>
    ${T(212, y + 258, 26, '看全部案例 ›', { c: '#C8C8D8', anchor: 'middle' })}`;
  y += 340;
  // 行动清单
  g += `<rect x="52" y="${y}" width="976" height="420" rx="26" fill="${CARD}"/>`;
  g += T(92, y + 58, 30, '行动清单（今天就能做）', { c: TXT, w: 700 });
  REPORT.actions.forEach((a, i) => {
    const ay = y + 128 + i * 92;
    g += `<rect x="92" y="${ay - 34}" width="44" height="44" rx="12" fill="${MAGENTA}" fill-opacity="0.16"/>
      ${T(114, ay - 2, 26, String(i + 1), { c: MAGENTA, anchor: 'middle', w: 700 })}`;
    g += T(158, ay + 2, 32, a, { c: TXT });
  });
  y += 460;
  g += T(92, y + 40, 24, '本报告由真实案例库 + AI 生成，不替代专业咨询', { c: FAINT });
  g += `</g>`;
  g = bg + `<g clip-path="url(#repClip)">` + g + `</g>`;
  // 圈注：风险点第 2 行「「借款」」
  const ann = ramp(t, 16.25, 16.6);
  if (ann > 0 && t < 19.6) {
    const cxA = 136 + tw('未见面就要求转账，并指定备注写', 33) + tw('「借款」', 33) / 2;
    const cyA = 410 + 326 + 108 - 12 - scroll;
    g += `<ellipse cx="${cxA}" cy="${cyA}" rx="${lerp(30, 92, easeOutCubic(ann))}" ry="${lerp(14, 34, easeOutCubic(ann))}"
      fill="none" stroke="${MAGENTA}" stroke-width="3.5" opacity="${0.9 * ann}"/>`;
  }
  return g;
}

function sec3(f) {
  const t = f / FPS;
  let g = uiHeader(t);
  g += uiInput(t);
  if (t >= 13.55) g += reportBody(t);
  g += `<rect x="0" y="392" width="${W}" height="90" fill="url(#topFadeUI)"/>`;
  g += BEZEL;
  // 底部字幕安全区压暗（保证硬字幕可读）
  g += `<rect x="0" y="1290" width="${W}" height="630" fill="url(#bottomScrim)"/>`;
  return g;
}

// =====================================================================
// ④ 21.0–26.5s 信任层
// =====================================================================
const CASE_CARDS = [
  ['红包陷阱', '转账备注写借款'],
  ['冷暴力', '已读不回超过 72 小时'],
  ['彩礼陷阱', '先付后反悔'],
  ['备胎陷阱', '只聊天不确认关系'],
];
const STAT_ROWS = [
  ['50 条真实案例', '持续更新，每条都有追溯'],
  ['经营许可齐全', '营业执照与备案可在官网核验'],
  ['只面向 18–30 岁', '成年用户定位，不做未成年人'],
];

function sec4(f) {
  const t = f / FPS;
  let g = `<rect width="${W}" height="${H}" fill="${UI_BG}"/>`;
  g += glow(540, 420, 520, 'gVio', 0.10);
  // 案例卡翻页（21.0–25.4，每 1.1s 一张）
  const idxF = (t - 21.0) / 1.1;
  const idx = Math.floor(idxF);
  const sub = idxF - idx;
  if (idx < CASE_CARDS.length) {
    const out = easeInOut(clamp((sub - 0.72) / 0.28, 0, 1));
    const inP = easeOutCubic(clamp(sub / 0.28, 0, 1));
    const draw = (i, y, op, sc) => {
      if (i < 0 || i >= CASE_CARDS.length || op <= 0) return '';
      const [tag, title] = CASE_CARDS[i];
      return `<g opacity="${op}" transform="translate(540 ${y}) scale(${sc}) translate(-540 ${-y})">
        <rect x="92" y="${y - 96}" width="896" height="192" rx="24" fill="${CARD}" stroke="#2A2940" stroke-width="2"/>
        <rect x="92" y="${y - 96}" width="896" height="192" rx="24" fill="${VIOLET}" fill-opacity="0.05"/>
        ${T(132, y - 22, 26, tag, { c: MAGENTA, w: 700 })}
        ${T(132, y + 36, 40, title, { c: TXT, w: 700 })}
        ${T(948, y - 20, 24, '案例库 ›', { c: FAINT, anchor: 'end' })}
      </g>`;
    };
    g += draw(idx - 1, 400 - out * 190, (1 - out) * 0.22, 0.95 + out * 0.04);
    g += draw(idx, 470 + (1 - inP) * 130, 0.25 + 0.75 * inP, 0.96 + 0.04 * inP);
  }
  // 三行资质逐条落下
  const baseY = 860;
  g += T(540, 790, 30, '为什么可以信这一份报告', { c: MUTED, anchor: 'middle', w: 500 });
  STAT_ROWS.forEach((r, i) => {
    const t0 = 21.5 + i * 0.34;
    const p = ramp(t, t0, t0 + 0.36);
    if (p <= 0) return;
    const y = baseY + i * 150;
    const dy = (1 - easeOutCubic(p)) * -40;
    g += `<g opacity="${p}" transform="translate(0 ${dy})">
      <rect x="92" y="${y - 56}" width="896" height="126" rx="20" fill="${CARD}" fill-opacity="0.72"/>
      <circle cx="150" cy="${y + 6}" r="26" fill="${SUCCESS}" fill-opacity="0.14" stroke="${SUCCESS}" stroke-width="2"/>
      <path d="M 138 ${y + 6} L 147 ${y + 15} L 163 ${y - 4}" fill="none" stroke="${SUCCESS}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
      ${T(200, y - 2, 38, r[0], { c: TXT, w: 700 })}
      ${T(200, y + 42, 26, r[1], { c: MUTED })}
    </g>`;
  });
  return g;
}

// =====================================================================
// ⑤ 26.5–30.0s 共用品牌尾 + CTA（几何与 10s-A 品牌尾一致）
// =====================================================================
function sec5(f) {
  const t = f / FPS;
  const cx = 540, cy = 810;
  let g = `<rect width="${W}" height="${H}" fill="url(#bg)"/>`;
  g += glow(cx, cy, 460, 'gVio', 0.16) + glow(cx, cy + 300, 420, 'gMag', 0.08);
  const logoIn = ramp(t, 25.55, 26.3);
  if (logoIn > 0) {
    const pulse = 1 + 0.012 * Math.sin((t - 25.9) * Math.PI * 2 * 0.8);
    g += `<image href="data:image/png;base64,${logoB64}" x="${cx - 300 * pulse}" y="${cy - 300 * pulse}" width="${600 * pulse}" height="${600 * pulse}" opacity="${logoIn}"/>`;
  }
  const mainIn = ramp(t, 26.62, 26.95);
  g += subtitle(cx, 1196, 74, [{ t: '首次提问免费' }], mainIn, 700);
  const pillIn = ramp(t, 26.80, 27.15);
  if (pillIn > 0) {
    g += `<g opacity="${pillIn}">
      <rect x="${cx - 190}" y="1258" width="380" height="104" rx="52" fill="${INK}" fill-opacity="0.55" stroke="#FFFFFF" stroke-opacity="0.35" stroke-width="2.5"/>
      <text x="${cx}" y="1326" text-anchor="middle" font-family="HarmonyOS Sans SC" font-size="54" font-weight="500" fill="#FFFFFF">搜索 <tspan fill="${MAGENTA}" font-weight="700">Q问</tspan></text>
    </g>`;
  }
  // 合规标注（案例改编 + AI 生成）
  const aiIn = ramp(t, 26.95, 27.3);
  g += `<text x="92" y="1692" font-family="HarmonyOS Sans SC" font-size="27" font-weight="400" fill="#FFFFFF" opacity="${0.55 * aiIn}">内容由 AI 辅助生成</text>`;
  g += `<text x="92" y="1740" font-family="HarmonyOS Sans SC" font-size="25" font-weight="400" fill="#FFFFFF" opacity="${0.45 * aiIn}">案例根据真实案例库改编，已脱敏</text>`;
  return g;
}

// =====================================================================
// 帧合成
// =====================================================================
function frame(f) {
  const t = f / FPS;
  const o1 = 1 - ramp(f, 100, 116);                    // ① 3.33–3.87 出（随黑屏字幕卡退场）
  const o2 = ramp(f, 149, 168) * (1 - ramp(f, 320, 334)); // ② 4.97–5.6 进 / 10.67–11.13 出
  const o3 = ramp(f, 324, 340);                        // ③ 10.8–11.33 进
  const o4 = ramp(f, 626, 642);                        // ④ 20.87–21.4 进
  const o5 = ramp(f, 768, 792);                        // ⑤ 25.6–26.4 Logo 起（与 ④ 交叠）
  const t5 = 1 - ramp(f, 626, 642);                    // ④ 淡入时 ③ 同期退出
  const t3 = 1 - ramp(f, 766, 790);

  // 全局缓慢推近（只作用于非 UI 场景）
  const zoom = lerp(1.0, 1.04, t / 30);
  const shake = 6 * (1 - ramp(t, 3.0, 3.4));           // 转账成功瞬间的轻微体感
  const sx = shake ? wob(t, 3) * shake : 0;
  const sy = shake ? wob(t, 5) * shake * 0.6 : 0;

  let body = '';
  body += `<g opacity="${o2}"><g transform="translate(${540 + sx} ${960 + sy}) scale(${zoom * 1.02}) translate(-540 -960)">${sec2(f)}</g></g>`;
  body += `<g opacity="${o1 * t3}">${sec1(f)}</g>`;
  body += blackCard(f);
  body += `<g opacity="${o3 * t5}">${sec3(f)}</g>`;
  body += `<g opacity="${o4 * t3}">${sec4(f)}</g>`;
  body += `<g opacity="${o5}">${sec5(f)}</g>`;

  // 字幕层
  let subs = '';
  const u = (a, b, c, d) => ramp(f, a, b) * (1 - ramp(f, c, d));
  // ② VO1
  subs += subtitle(540, 1372, 62, [{ t: '感情的丛林里，' }], u(178, 190, 316, 328));
  subs += subtitle(540, 1458, 62, [{ t: '坑从来不会提前打招呼。', c: '#FFFFFF' }], u(182, 194, 316, 328));
  // ③ VO2（三段递进）
  subs += subtitle(540, 1458, 58, [{ t: '把你的困惑交给 ', }, { t: 'Q问', c: MAGENTA }], u(364, 374, 424, 432));
  subs += subtitle(540, 1458, 58, [{ t: '五十条真实案例训练出的' }], u(426, 434, 514, 522));
  subs += subtitle(540, 1458, 58, [{ t: '避坑诊断 + 行动清单' }], u(516, 524, 586, 594));
  // ④ VO3
  subs += subtitle(540, 1372, 62, [{ t: '我们不承诺脱单，' }], u(642, 654, 762, 774));
  subs += subtitle(540, 1458, 62, [{ t: '只帮你看清脚下的路。' }], u(646, 658, 762, 774));
  // ⑤ VO4
  subs += subtitle(540, 1470, 52, [{ t: '今晚，来问第一句。' }], u(800, 812, 884, 892), 500);

  // 尘埃（只在 ② 生效）
  let dust = '';
  if (o2 > 0.01) {
    motes.forEach(m => {
      const x = (m.x + t * m.sp * 3) % W, y = (m.y - t * m.sp) % H;
      dust += dot(x < 0 ? x + W : x, y < 0 ? y + H : y, m.r, '#CFE8DC', 0.1 * o2);
    });
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${DEFS}
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  ${body}
  ${dust}
  <rect width="${W}" height="${H}" fill="url(#vign)" opacity="0.85"/>
  ${subs}
  <rect width="${W}" height="${H}" fill="#000" opacity="${ramp(f, 884, 899)}"/>
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
  const t0 = Date.now();
  const svg = frame(f);
  if (process.env.DUMP) { fs.writeFileSync(path.join(__dirname,'debug.svg'), svg); process.exit(0); }
  const png = new Resvg(svg, resvgOpt).render().asPng();
  fs.writeFileSync(path.join(OUT, `f${String(f).padStart(4, '0')}.png`), png);
  const pct = Math.floor(((f - from + 1) / (to - from + 1)) * 100);
  if (pct >= lastPct + 5) { lastPct = pct; console.log(`[frames] ${pct}% (f=${f}, ${Date.now() - t0}ms)`); }
}
console.log(`[frames] done ${from}-${to}`);
