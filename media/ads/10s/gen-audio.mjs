/**
 * 10 秒片 A 版音效设计合成器（蓝本 §2.1 音效列）
 * 产物：audio.wav（44.1kHz / 16bit / 立体声 / 10.0s）
 *
 * 声音事件对照分镜：
 *   0.00 丛林底噪淡入        0.80 sub hit + 陷阱咬合
 *   1.00–2.40 微光 shimmer   2.40–4.60 萤光铃音上扬
 *   4.60–5.40 whoosh（汇聚） 5.40–7.00 pad 蓄力
 *   7.00 落点鼓 + Logo 定版   7.00–10.00 尾音渐隐
 * 目标响度 ≈ -14 LUFS（integrated），峰值为 -6 dBFS；平台侧会再做响度归一。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SR = 44100, DUR = 10.0, LEN = Math.floor(SR * DUR);
const L = new Float64Array(LEN), R = new Float64Array(LEN);

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// 事件包络：起点起 5ms 淡入，之后指数衰减
function add(t0, dur, fn, gain = 1, pan = 0) {
  const s = Math.floor(t0 * SR), e = Math.min(LEN, Math.floor((t0 + dur) * SR));
  for (let i = s; i < e; i++) {
    const t = (i - s) / SR, tt = t0 + t;
    const v = fn(t, dur) * gain;
    const w = clamp((i - s) / (SR * 0.005), 0, 1); // 防爆音
    L[i] += v * (1 - Math.max(0, pan)) * w;
    R[i] += v * (1 + Math.min(0, pan)) * w;
  }
}
const sine = (f, t) => Math.sin(TAU * f * t);
const exp = (t, tau) => Math.exp(-t / tau);
let noiseState = 0.3;
const noise = () => { noiseState = (noiseState * 16807 + 0.123) % 1; return noiseState * 2 - 1; };

// 丛林底噪（低频 drone + 低通噪声，0–10s 常驻，首尾淡入淡出）
const lp = { v: 0 };
for (let i = 0; i < LEN; i++) {
  const t = i / SR;
  const fade = clamp(t / 0.5, 0, 1) * clamp((DUR - t) / 0.8, 0, 1);
  lp.v += (noise() - lp.v) * 0.02; // ~300Hz 低通
  const drone = sine(52, t) * 0.5 + sine(78, t) * 0.2;
  const v = (drone * 0.05 + lp.v * 0.035) * fade;
  L[i] += v; R[i] += v * 0.96;
}
// 0.80s sub hit（陷阱咬合）
add(0.80, 0.9, (t) => sine(46, t) * exp(t, 0.16), 0.85);
add(0.80, 0.06, (t) => noise() * exp(t, 0.012), 0.5);          // 咬合瞬态
add(0.80, 0.3, (t) => sine(190, t) * exp(t, 0.05), 0.18);      // 木质体感
// 1.00–2.40 shimmer（微光）
for (const [f0, p, g] of [[2380, -0.5, 0.028], [3560, 0.5, 0.02]]) {
  add(1.0, 1.4, (t, d) => sine(f0, t) * (0.6 + 0.4 * Math.sin(TAU * 5.2 * t)) * Math.min(1, t / 0.25) * exp(Math.max(0, t - d + 0.3), 0.25), g, p);
}
// 2.40–4.60 萤光铃音上扬（A 大调琶音）
[[2.45, 440], [2.95, 554], [3.45, 659], [3.95, 880], [4.35, 1109]].forEach(([t0, f0], i) => {
  add(t0, 0.9, (t) => (sine(f0, t) + 0.4 * sine(f0 * 2, t)) * exp(t, 0.28), 0.12, i % 2 ? 0.4 : -0.4);
});
// 萤火虫随机高音闪烁
for (let k = 0; k < 9; k++) {
  const t0 = 2.5 + k * 0.22 + (k % 3) * 0.03;
  const f0 = 2200 + (k * 337) % 1400;
  add(t0, 0.25, (t) => sine(f0, t) * exp(t, 0.06), 0.035, ((k % 2) ? 0.6 : -0.6));
}
// 4.60–5.40 whoosh（噪声带通扫频上扬）
{
  const t0 = 4.6, dur = 0.85, s = Math.floor(t0 * SR), e = Math.floor((t0 + dur) * SR);
  let bp = { v: 0, v2: 0 };
  for (let i = s; i < e; i++) {
    const t = (i - s) / SR, p = t / dur;
    const fc = 280 + 2800 * Math.pow(p, 1.6);
    const a = clamp(TAU * fc / SR, 0, 0.9);
    bp.v += (noise() - bp.v) * a; bp.v2 += (bp.v - bp.v2) * a * 0.8; // 简易带通
    const env = Math.sin(Math.PI * Math.pow(p, 0.8)) * 0.5;
    L[i] += bp.v2 * env; R[i] += bp.v2 * env * 0.95;
  }
}
// 5.40–7.00 pad 蓄力（失谐双锯齿 + 低通，渐强）
{
  const t0 = 5.4, dur = 1.6, s = Math.floor(t0 * SR), e = Math.floor((t0 + dur) * SR);
  let lpv = { L: 0, R: 0 };
  for (let i = s; i < e; i++) {
    const t = (i - s) / SR, p = t / dur;
    const f0 = 110;
    const saw = (f, ph) => 2 * (((f * (t0 + t)) + ph) % 1) - 1;
    const raw = (saw(f0, 0) + saw(f0 * 1.007, 0.3)) * 0.5;
    lpv.L += (raw - lpv.L) * clamp(0.05 + p * 0.12, 0, 0.9);
    const env = Math.pow(p, 2.2) * 0.16;
    L[i] += lpv.L * env; R[i] += lpv.L * env * 0.97;
  }
}
// 7.00 落点（Logo 定版）：深 sub + 短噪声 + 简易混响尾
add(7.0, 1.4, (t) => sine(58, t) * exp(t, 0.3), 0.8);
add(7.0, 0.12, (t) => noise() * exp(t, 0.02), 0.35);
for (const [dt, g] of [[0.05, 0.4], [0.11, 0.3], [0.19, 0.22], [0.31, 0.15]]) {
  add(7.0 + dt, 0.6, (t) => sine(116, t) * exp(t, 0.12), g);
}
// 7.0–10.0 尾音：高音 pad 微光 + 终止
add(7.1, 2.6, (t, d) => (sine(880, t) + 0.5 * sine(1318, t)) * Math.min(1, t / 0.4) * exp(Math.max(0, t - (d - 0.6)), 0.5), 0.03);
add(8.6, 1.2, (t, d) => sine(440, t) * Math.min(1, t / 0.3) * exp(Math.max(0, t - (d - 0.5)), 0.4), 0.025, -0.3);

// ---------- 归一化与写出（峰值 -6 dBFS） ----------
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
const out = path.join(__dirname, 'audio.wav');
fs.writeFileSync(out, buf);
console.log(`[audio] written ${out} (${(buf.length / 1e6).toFixed(1)} MB, peak ${g ? 'normalized' : 'silent'})`);
