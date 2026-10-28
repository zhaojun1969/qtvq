/**
 * 语音识别链路端到端探测（真实调用 /api/speech）
 *
 * 健康检查里的 speechConfigured 只证明"环境变量存在"，不证明"能识别"——
 * 和微信支付"配好了≠能用"是同一类陷阱。这里发一段真实的静音 WAV：
 *   · 返回 422 未识别到语音  → 说明 NLS token 拿到了、音频被受理（链路通，只是没说话）
 *   · 返回 502 SPEECH_FAILED → 链路坏了，看 message 定位
 *   · 返回 503               → 服务端根本没配置
 */
const sampleRate = 16000;
const seconds = 0.5;
const samples = Math.floor(sampleRate * seconds);
const dataBytes = samples * 2;

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + dataBytes, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(sampleRate, 24);
header.writeUInt32LE(sampleRate * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(dataBytes, 40);
const wav = Buffer.concat([header, Buffer.alloc(dataBytes)]); // 全静音

const b64 = wav.toString('base64');
console.log(`构造静音 WAV：${wav.length} 字节，base64 长度 ${b64.length}`);
console.log('');

const started = Date.now();
const res = await fetch('https://qtvq.cn/api/speech', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ audio: b64, format: 'wav', sampleRate }),
});
const text = await res.text();
const ms = Date.now() - started;

console.log(`HTTP ${res.status}   耗时 ${ms}ms`);
console.log(`响应：${text.slice(0, 500)}`);
console.log('');

let verdict = '';
if (res.status === 422) verdict = '✅ 链路通：token 获取成功、音频被受理（只是静音所以"未识别到语音"）';
else if (res.status === 502) verdict = '❌ 链路坏了：见上面的 message';
else if (res.status === 503) verdict = '❌ 服务端未配置语音识别';
else if (res.status === 200) verdict = '✅ 识别成功';
else verdict = `⚠️ 非预期状态码 ${res.status}`;
console.log(`判读：${verdict}`);
