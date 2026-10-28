#!/usr/bin/env node
/**
 * 用「微信真实签名过的应答」验证 WECHAT_PLATFORM_PUBLIC_KEY（微信支付公钥）是否正确。
 *
 * 为什么必须这样验：回调验签失败是**静默**的 —— 客户付了钱、会员不开通、你这边什么提示都没有。
 * 而"公钥填对了没有"不能靠肉眼看 PEM（历史上正是手抄 PEM 出过两次事故）。
 * 微信对我们每一个请求的**应答都带签名**（响应头 Wechatpay-Signature / Timestamp / Nonce / Serial），
 * 用同一个公钥验一次，就等于提前把回调验签这条路走通了 —— 而且不用花一分钱。
 *
 * 用法：
 *   node tools/scripts/wechat-verify-platform-key.mjs                       # 用 .dev.vars 里的公钥
 *   node tools/scripts/wechat-verify-platform-key.mjs --key=.secrets/wechat/pub_key.pem
 *   node tools/scripts/wechat-verify-platform-key.mjs --order=ord_xxx
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = 'https://api.mch.weixin.qq.com';

function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
}

function loadDevVars() {
  const file = path.join(ROOT, '.dev.vars');
  if (!fs.existsSync(file)) return {};
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const env = {};
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (val.includes('BEGIN') && !val.includes('END')) {
      const parts = [val];
      for (let j = i + 1; j < lines.length; j += 1) {
        parts.push(lines[j]);
        if (lines[j].includes('END') || /^[A-Z][A-Z0-9_]+=/.test(lines[j])) break;
      }
      val = parts.join('\n');
    }
    env[key] = val.trim();
  }
  return env;
}

function normalizePublicKey(raw) {
  if (!raw) return '';
  const text = String(raw).replace(/\\n/g, '\n');
  const m = /-----BEGIN (PUBLIC KEY|CERTIFICATE)-----([\s\S]*?)-----END \1-----/.exec(text);
  if (!m) return '';
  if (m[1] === 'CERTIFICATE') {
    // 旧模式的平台证书：取出其中的公钥
    return new crypto.X509Certificate(text.slice(text.indexOf('-----BEGIN'))).publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
  }
  const body = m[2].replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) || [body];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----`;
}

function fp(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function verifyWith(publicPem, timestamp, nonce, body, signatureB64) {
  try {
    const v = crypto.createVerify('RSA-SHA256');
    v.update(`${timestamp}\n${nonce}\n${body}\n`);
    v.end();
    return v.verify(crypto.createPublicKey(publicPem), Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

const env = loadDevVars();
const mchId = env.WECHAT_MCH_ID || '';
const mchSerial = env.WECHAT_MCH_SERIAL || '';
let privateKey = (env.WECHAT_MCH_PRIVATE_KEY || '').replace(/\\n/g, '\n');
privateKey = normalizePublicKey(privateKey) ? privateKey : privateKey; // 保持原样，仅做长度判断

const keyFileArg = argValue('key');
const rawPublic = keyFileArg
  ? fs.readFileSync(path.resolve(ROOT, keyFileArg), 'utf8')
  : env.WECHAT_PLATFORM_PUBLIC_KEY || '';
const publicPem = normalizePublicKey(rawPublic);

console.log('=== 微信支付公钥验证（用微信真实签名过的应答来验）===');
console.log(`  商户号        : ${mchId || '(缺失)'}`);
console.log(`  商户证书序列号: ${mchSerial ? `${mchSerial.slice(0, 8)}***` : '(缺失)'}`);
console.log(`  待验证公钥来源: ${keyFileArg || (env.WECHAT_PLATFORM_PUBLIC_KEY ? '.dev.vars 的 WECHAT_PLATFORM_PUBLIC_KEY' : '(无)')}`);
if (!publicPem) {
  console.error('');
  console.error('❌ 没有可验证的公钥。请把 pub_key.pem（微信支付公钥）放进 .secrets/wechat/，');
  console.error('   然后先执行：node tools/scripts/wechat-pem-setup.mjs --write');
  process.exit(2);
}
console.log(`  公钥指纹      : ${fp(publicPem)}`);
console.log('');

if (!mchId || !mchSerial || !privateKey.includes('BEGIN')) {
  console.error('❌ .dev.vars 缺少 WECHAT_MCH_ID / WECHAT_MCH_SERIAL / WECHAT_MCH_PRIVATE_KEY，无法发起签名请求');
  process.exit(1);
}

function authorization(method, urlPath) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = `${method}\n${urlPath}\n${ts}\n${nonce}\n\n`;
  const signature = crypto.createSign('RSA-SHA256').update(message).sign(privateKey, 'base64');
  return `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${ts}",serial_no="${mchSerial}"`;
}

const orderId = argValue('order') || 'ord_mu44zhht_eqvhsp6c';
const urlPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderId)}?mchid=${encodeURIComponent(mchId)}`;

console.log(`=== 1) 向微信发起一次真实查询（同时验证商户私钥+序列号）===`);
console.log(`  GET ${urlPath}`);
const res = await fetch(BASE + urlPath, {
  method: 'GET',
  headers: {
    Authorization: authorization('GET', urlPath),
    Accept: 'application/json',
    'User-Agent': 'qtvq-api/1.0',
    'Accept-Language': 'zh-CN',
  },
});
const body = await res.text();
const hSig = res.headers.get('wechatpay-signature') || '';
const hTs = res.headers.get('wechatpay-timestamp') || '';
const hNonce = res.headers.get('wechatpay-nonce') || '';
const hSerial = res.headers.get('wechatpay-serial') || '';

console.log(`  HTTP ${res.status}   应答头 Wechatpay-Serial = ${hSerial || '(无)'}`);
if (res.status !== 200) {
  console.log(`  应答体：${body.slice(0, 220)}`);
  console.log('  → 商户私钥/序列号这一层就没过，先修这里（重新执行 wechat-pem-setup.mjs --write 并部署）');
  process.exit(1);
}
let tradeState = '';
try {
  tradeState = JSON.parse(body).trade_state || '';
} catch {
  /* ignore */
}
console.log(`  ✅ 商户私钥 + 序列号有效（微信接受了我们的签名），订单 ${orderId} trade_state=${tradeState}`);

console.log('');
console.log('=== 2) 用待验证公钥验微信的应答签名 ===');
if (!hSig || !hTs || !hNonce) {
  console.error('  ❌ 微信应答没有带签名头，无法验证（异常情况）');
  process.exit(1);
}
const ok = verifyWith(publicPem, hTs, hNonce, body, hSig);
console.log(`  验签结果：${ok ? '✅ 通过 —— 公钥正确，回调验签这条路已经通了' : '❌ 不通过 —— 公钥不对（可能是另一套证书/公钥，或文件放错）'}`);

// 反向自检：故意改一个字符，必须验不过。否则说明"验签"是假的（永远返回 true）。
const tampered = `${body.slice(0, -2)}${body.slice(-2) === 'xx' ? 'yy' : 'xx'}`;
const okTampered = verifyWith(publicPem, hTs, hNonce, tampered, hSig);
console.log(`  反向自检：篡改应答后验签应失败 → ${okTampered ? '❌ 竟然通过了（验签形同虚设）' : '✅ 正确失败'}`);

console.log('');
console.log(`  应答签名使用的序列号（回调和应答都用它标识用哪个公钥）：${hSerial || '(无)'}`);
if (hSerial.startsWith('PUB_KEY_ID_')) {
  console.log('  → 微信已在使用「微信支付公钥」模式，这与商户平台-API安全里显示的「公钥ID」应一致');
}

if (!ok || okTampered) process.exit(1);
console.log('');
console.log('🎉 结论：公钥、验签逻辑、回调链路均已就绪。现在做一笔真实付款即可端到端闭环。');
