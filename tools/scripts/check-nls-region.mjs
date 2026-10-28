/**
 * 阿里云 NLS「一句话识别」地域与权限探测
 *
 * 背景：线上 /api/speech 返回 502 "No permission!"。token 能拿到（说明 AK 有 CreateToken 权限），
 * 但 ASR 网关拒绝 —— 最常见的原因是 **AppKey 与 token 的地域/账号不匹配**（NLS 的 AppKey 按地域创建，
 * 用上海的网关去调北京的 AppKey 就会报 No permission）。
 *
 * 本脚本逐个候选地域打同一个静音请求，把"哪个地域认这个 AppKey"直接测出来，
 * 而不是让人去控制台猜。
 *
 * 凭据来源：obs.env 的 OBS_ACCESS_KEY_ID / OBS_SECRET_ACCESS_KEY（与线上 NLS 用的是同一把）。
 * 不打印任何密钥。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const env = {};
for (const line of fs.readFileSync('obs.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].trim();
}
const ak = env.OBS_ACCESS_KEY_ID;
const sk = env.OBS_SECRET_ACCESS_KEY;

const dev = fs.readFileSync('.dev.vars', 'utf8');
const appKey = (dev.split(/\r?\n/).find((l) => l.startsWith('NLS_APP_KEY=')) || '').split('=')[1]?.trim();

console.log(`AK：${ak.slice(0, 8)}…${ak.slice(-4)}（不打印完整值）`);
console.log(`AppKey：${appKey}`);
console.log('');

const pe = (s) => encodeURIComponent(String(s)).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');

// 静音 WAV（16k / 单声道 / 16bit）
const sr = 16000;
const dataBytes = sr * 0.3 * 2;
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8);
h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
h.write('data', 36); h.writeUInt32LE(dataBytes, 40);
const wav = Buffer.concat([h, Buffer.alloc(dataBytes)]);

async function createToken() {
  // NLS 的 token 服务只在 cn-shanghai 提供服务 —— 地域差异体现在**ASR 网关**上，不在 token 上。
  // （第一版脚本把 token 创建绑到每个地域，于是除上海外全部 fetch failed，
  //   看起来像"地域不对"，其实是探测方法错了。诊断代码必须区分"我方法错了"和"对方有问题"。）
  const params = {
    Action: 'CreateToken',
    Version: '2019-02-28',
    Format: 'JSON',
    AccessKeyId: ak,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    RegionId: 'cn-shanghai',
  };
  const canonical = Object.keys(params).sort().map((k) => `${pe(k)}=${pe(params[k])}`).join('&');
  const sig = crypto.createHmac('sha1', `${sk}&`).update(`GET&%2F&${pe(canonical)}`).digest('base64');
  const res = await fetch(`https://nls-meta.cn-shanghai.aliyuncs.com/?${canonical}&Signature=${pe(sig)}`);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  return { status: res.status, json, text };
}

const { status, json, text } = await createToken();
const token = json?.Token?.Id || json?.Token?.token || json?.Id || null;
console.log(`CreateToken：HTTP ${status}，token=${token ? `${String(token).slice(0, 8)}…` : '(无)'}`);
if (!token) {
  console.log(`原始响应：${text.slice(0, 300)}`);
  process.exit(1);
}
console.log(`有效期至：${json?.Token?.ExpireTime ? new Date(json.Token.ExpireTime * 1000).toISOString() : '(未返回)'}`);
console.log('');

const REGIONS = ['cn-shanghai', 'cn-beijing', 'cn-shenzhen', 'cn-hangzhou', 'cn-guangzhou'];

for (const region of REGIONS) {
  const url = `https://nls-gateway-${region}.aliyuncs.com/stream/v1/asr?appkey=${encodeURIComponent(appKey)}&format=wav&sample_rate=${sr}`;
  console.log(`=== ASR 网关 ${region} ===`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-NLS-Token': token, 'Content-Type': 'application/octet-stream' },
      body: wav,
    });
    const t = await res.text();
    console.log(`  HTTP ${res.status}  →  ${t.slice(0, 240)}`);
    if (t.includes('20000000')) console.log('  ★ 该地域认这个 AppKey（status 20000000 = 音频已受理，静音所以无文本）');
  } catch (e) {
    console.log(`  异常 ${e.message}`);
  }
  console.log('');
}
