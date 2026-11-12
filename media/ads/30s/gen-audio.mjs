/**
 * 30 秒片音效与配乐合成器（蓝本 §3.1 音效/配乐栏）
 * 产物：music.wav（44.1kHz / 16bit / 立体声 / 30.0s）
 *
 * 情绪曲线：悬念（①）→ 释然（②③）→ 笃定（④⑤）
 * 和声：Dm(0–4.6) → B♭(4.6–11) → F(11–21) → C(21–26.5) → D(26.5–30)
 * 全部声音事件对齐分镜时码；人声（VO）另由 ffmpeg 混入，此处只做音乐床与音效。
 * 目标：音乐床 ≈ -18 LUFS 垫底，成片混音后整体 -14 LUFS。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SR = 44100, DUR = 30.0, LEN = Math.floor(SR * DUR);
const L = new Float64Array(LEN), R = new Float64Array(LEN);

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ramp01 = (t, a, b) => clamp((t - a) / (b - a || 1e-9), 0, 1);
const sine = (f, t) => Math.sin(TAU * f * t);
const exp = (t, tau) => Math.exp(-t / tau);
let noiseState = 0.37;
const noise = () => { noiseState = (noiseState * 16807 + 0.123) % 1; return noiseState * 2 - 1; };

function add(t0, dur, fn, gain = 1, pan = 0) {
  const s = Math.floor(t0 * SR), e = Math.min(LEN, Math.floor((t0 + dur) * SR));
  for (let i = s; i < e; i++) {
    if (i < 0) continue;
    const t = (i - s) / SR;
    const v = fn(t, dur) * gain;
    const w = clamp((i - s) / (SR * 0.004), 0, 1);
    L[i] += v * (1 - Math.max(0, pan)) * w;
    R[i] += v * (1 + Math.min(0, pan)) * w;
  }
}

// ---------- 功能件 ----------
const note = (f, t, tau = 0.3, harm = 0.35) => (sine(f, t) + harm * sine(f * 2, t)) * exp(t, tau);

// UI 消息音（短促木质双击）
function msgIn(t0, gain = 0.5, pan = -0.25) {
  add(t0, 0.22, t => (sine(880, t) * 0.6 + sine(1320, t) * 0.3) * exp(t, 0.05), gain, pan);
  add(t0 + 0.05, 0.16, t => sine(1180, t) * exp(t, 0.04), gain * 0.55, pan);
}
// 键盘/点击
const tick = (t0, gain = 0.3, pan = 0) => add(t0, 0.05, t => noise() * exp(t, 0.006), gain, pan);
// 滑入 whoosh
function whoosh(t0, dur, f0, f1, gain = 0.3, pan = 0) {
  const s = Math.floor(t0 * SR), e = Math.min(LEN, Math.floor((t0 + dur) * SR));
  let bp = { v: 0, v2: 0 };
  for (let i = s; i < e; i++) {
    const t = (i - s) / SR, p = t / dur;
    const fc = f0 + (f1 - f0) * Math.pow(p, 1.5);
    const a = clamp(TAU * fc / SR, 0, 0.9);
    bp.v += (noise() - bp.v) * a; bp.v2 += (bp.v - bp.v2) * a * 0.8;
    const env = Math.sin(Math.PI * Math.pow(p, 0.75));
    L[i] += bp.v2 * env * gain * (1 - Math.max(0, pan));
    R[i] += bp.v2 * env * gain * (1 + Math.min(0, pan));
  }
}
// 垫底 pad：一组频率的失谐叠加，带低通与渐强
function pad(t0, dur, freqs, gain = 0.1, cutoff = 0.06, pan = 0) {
  const s = Math.floor(t0 * SR), e = Math.min(LEN, Math.floor((t0 + dur) * SR));
  const lp = { v: 0 };
  for (let i = s; i < e; i++) {
    const t = (i - s) / SR, p = t / dur;
    let raw = 0;
    freqs.forEach((f, k) => {
      const saw = 2 * (((f * (t0 + t)) + k * 0.21) % 1) - 1;
      raw += saw / (1 + k * 0.3);
    });
    raw /= freqs.length;
    lp.v += (raw - lp.v) * clamp(cutoff + p * 0.03, 0, 0.9);
    const env = Math.min(1, p / 0.18) * (p > 0.85 ? (1 - p) / 0.15 : 1) * gain;
    L[i] += lp.v * env * (1 - Math.max(0, pan));
    R[i] += lp.v * env * (1 + Math.min(0, pan));
  }
}
// 低音 sub 落点
const subHit = (t0, f = 52, gain = 0.5, tau = 0.35) => add(t0, 1.6, t => sine(f, t) * exp(t, tau), gain);

// =====================================================================
// ① 0–4.6 聊天 → 转账 → 黑屏（悬念）
// =====================================================================
// 房间底噪（很小的低频）
pad(0, 4.6, [55, 82.5, 110], 0.05, 0.03);
add(0.0, 4.6, t => noise() * 0.012 * Math.min(1, t / 0.4), 0.5);
msgIn(0.28, 0.42, -0.3);
msgIn(0.86, 0.42, -0.3);
// 我方发送：短促上扬
add(1.46, 0.25, t => sine(660, t) * 0.5 * exp(t, 0.05) + sine(990, t) * 0.25 * exp(t, 0.04), 0.4, 0.3);
// 转账面板滑入
whoosh(1.70, 0.42, 900, 240, 0.26, 0.1);
// 键入（5 个数字）
[1.88, 1.98, 2.08, 2.18, 2.28].forEach((t0, i) => tick(t0, 0.26, (i % 2 ? 0.12 : -0.12)));
// 备注自动填充 + 高亮
add(2.55, 0.3, t => sine(1560, t) * exp(t, 0.06), 0.14, 0.15);
add(2.64, 0.7, t => (sine(2340, t) * 0.5 + sine(3120, t) * 0.3) * Math.min(1, t / 0.1) * exp(Math.max(0, t - 0.4), 0.2), 0.09, 0.2);
// 确认 + 成功提示（大三度上行）
tick(2.94, 0.3);
add(3.02, 0.5, t => (sine(784, t) + 0.4 * sine(1568, t)) * exp(t, 0.14), 0.22, 0.05);
add(3.14, 0.6, t => (sine(1046, t) + 0.4 * sine(2093, t)) * exp(t, 0.18), 0.2, 0.05);
// 屏幕压暗：低频下坠 + 静默
subHit(3.30, 46, 0.55, 0.5);
add(3.30, 1.4, t => (sine(220, t) * 0.4 + sine(146, t) * 0.3) * exp(t, 0.5), 0.22);
// 3.9–4.9 几乎无声（留白，给黑屏字幕读的时间）
add(4.3, 1.2, t => sine(38, t) * Math.min(1, t / 0.4) * exp(Math.max(0, t - 0.7), 0.4), 0.18);

// =====================================================================
// ② 4.9–11 隐喻桥（悬疑 → 微光）
// =====================================================================
pad(4.9, 6.1, [73.42, 110, 146.83, 174.61], 0.1, 0.045); // D 小调色彩
add(4.95, 0.9, t => noise() * 0.05 * Math.min(1, t / 0.5) * exp(Math.max(0, t - 0.6), 0.3), 0.55);
// 丁达尔微光 shimmer
[5.5, 6.4].forEach((t0, i) => {
  add(t0, 1.5, t => (sine(2380, t) * 0.6 + sine(3560, t) * 0.35) * (0.7 + 0.3 * Math.sin(TAU * 4.4 * t)) * Math.min(1, t / 0.3) * exp(Math.max(0, t - 1.1), 0.25), 0.045, i ? 0.5 : -0.5);
});
// 路牌亮起
add(7.95, 0.8, t => (sine(659, t) + 0.5 * sine(1318, t)) * Math.min(1, t / 0.08) * exp(t, 0.25), 0.12, -0.35);
// 荆棘摩擦
add(9.3, 0.5, t => noise() * Math.sin(Math.PI * (t / 0.5)) * 0.4, 0.2, 0.35);
// 上扬起势（进 ③ 前）
whoosh(10.2, 0.9, 300, 3200, 0.22, 0);

// =====================================================================
// ③ 11–21 产品演示（释然：开始有节拍）
// =====================================================================
pad(11.0, 10.0, [87.31, 130.81, 174.61, 220], 0.09, 0.05); // F
// 轻节拍：每 0.75s 一记软 kick，只在演示段
for (let t0 = 11.4; t0 < 20.6; t0 += 0.75) {
  add(t0, 0.3, t => sine(58, t) * exp(t, 0.08), 0.16);
  if (t0 > 14.2) add(t0 + 0.375, 0.12, t => noise() * exp(t, 0.012), 0.06, 0.24);
}
// 打字
for (let k = 0; k < 14; k++) tick(11.35 + k * 0.072, 0.14, k % 2 ? 0.1 : -0.1);
// 点按 CTA + 生成中脉冲
tick(13.0, 0.32);
for (let k = 0; k < 3; k++) add(13.12 + k * 0.16, 0.18, t => sine(520 + k * 60, t) * exp(t, 0.05), 0.09);
// 报告生成完成（上行琶音）
[13.6, 13.72, 13.84].forEach((t0, i) => {
  add(t0, 0.7, t => note([523.25, 659.25, 783.99][i], t, 0.22), 0.13, i % 2 ? 0.3 : -0.3);
});
// 滚动声（15.0–20.4，持续轻微）
whoosh(15.0, 1.1, 420, 900, 0.08, 0);
whoosh(16.6, 1.1, 380, 820, 0.07, 0);
whoosh(18.2, 1.1, 400, 860, 0.06, 0);
// 圈注 ping
add(16.35, 0.6, t => (sine(1760, t) + 0.4 * sine(2640, t)) * exp(t, 0.09), 0.1, 0.2);

// =====================================================================
// ④ 21–26.5 信任层（笃定）
// =====================================================================
subHit(20.98, 58, 0.32, 0.3);
add(21.0, 0.01, () => 0); // 占位，保持事件表可读
pad(21.0, 5.5, [65.41, 98, 130.81, 196], 0.11, 0.055); // C
// 案例卡翻页 ×4
[21.1, 22.2, 23.3, 24.4].forEach(t0 => whoosh(t0, 0.3, 700, 220, 0.13, 0.1));
// 三行资质逐条落下
[21.5, 21.84, 22.18].forEach((t0, i) => {
  subHit(t0, 70 + i * 8, 0.18, 0.22);
  add(t0 + 0.02, 0.5, t => note([587.33, 698.46, 783.99][i], t, 0.2), 0.1, i % 2 ? 0.3 : -0.3);
});
// 转向品牌尾的起势
whoosh(25.3, 1.0, 240, 2600, 0.16, 0);

// =====================================================================
// ⑤ 26.5–30 品牌尾（落定）
// =====================================================================
subHit(26.45, 55, 0.5, 0.4);
add(26.45, 0.1, t => noise() * exp(t, 0.02), 0.22);
pad(26.45, 3.55, [73.42, 110, 146.83, 220, 293.66], 0.13, 0.07); // D
// 落点铃音
[26.5, 26.6, 26.72, 26.9].forEach((t0, i) => {
  add(t0, 0.9, t => note([880, 1174.66, 1468.83, 1760][i], t, 0.3), 0.055, i % 2 ? 0.4 : -0.4);
});
// 尾音收束
add(28.3, 1.6, t => (sine(587.33, t) + 0.3 * sine(880, t)) * Math.min(1, t / 0.3) * exp(Math.max(0, t - 0.9), 0.45), 0.05, -0.2);

// ---------- 收尾淡出 ----------
for (let i = 0; i < LEN; i++) {
  const t = i / SR;
  const f = t > 29.2 ? clamp((DUR - t) / 0.75, 0, 1) : 1;
  L[i] *= f; R[i] *= f;
}

// ---------- 归一化（峰值 -6 dBFS，留 VO 余量） ----------
let peak = 0;
for (let i = 0; i < LEN; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const g = peak > 0 ? 0.5 / peak : 1;

const buf = Buffer.alloc(44 + LEN * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + LEN * 4, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(LEN * 4, 40);
for (let i = 0; i < LEN; i++) {
  buf.writeInt16LE(clamp(L[i] * g, -1, 1) * 32767, 44 + i * 4);
  buf.writeInt16LE(clamp(R[i] * g, -1, 1) * 32767, 46 + i * 4);
}
const out = path.join(__dirname, 'music.wav');
fs.writeFileSync(out, buf);
console.log(`[audio] ${out} (${(buf.length / 1e6).toFixed(1)} MB, peak ${peak.toFixed(3)})`);
