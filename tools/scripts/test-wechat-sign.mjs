/** One-off: test WeChat V3 signing from .dev.vars (do not commit secrets) */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lines = fs.readFileSync(path.join(root, '.dev.vars'), 'utf8').split(/\r?\n/);

function getDevVar(key) {
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (idx === -1) return '';
  let val = lines[idx].slice(key.length + 1);
  if (key === 'WECHAT_MCH_PRIVATE_KEY' && val.includes('BEGIN PRIVATE KEY') && !val.includes('END PRIVATE KEY')) {
    const parts = [val];
    for (let j = idx + 1; j < lines.length; j += 1) {
      if (/^[A-Z][A-Z0-9_]+=/.test(lines[j])) break;
      parts.push(lines[j]);
      if (lines[j].includes('END PRIVATE KEY')) break;
    }
    val = parts.join('\n');
  }
  return val.replace(/\\n/g, '\n');
}

function normalizePem(raw) {
  let pem = String(raw).trim().replace(/\\n/g, '\n');
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const wrapped = (body.match(/.{1,64}/g) || [body]).join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----`;
}

const mchId = getDevVar('WECHAT_MCH_ID');
const serial = getDevVar('WECHAT_MCH_SERIAL').replace(/^serial=/i, '').replace(/:/g, '').toUpperCase();
const pem = normalizePem(getDevVar('WECHAT_MCH_PRIVATE_KEY'));

try {
  crypto.createPrivateKey(pem);
  console.log('PEM: OK');
} catch (e) {
  console.error('PEM: FAIL', e.message);
  process.exit(1);
}

console.log('MCH_ID:', mchId);
console.log('SERIAL:', serial, `(len ${serial.length})`);

const apiPath = '/v3/pay/transactions/native';
const bodyObj = {
  appid: getDevVar('WECHAT_APP_ID'),
  mchid: mchId,
  description: 'Q问会员-月卡',
  out_trade_no: `test_${Date.now()}`,
  notify_url: getDevVar('WECHAT_PAY_NOTIFY_URL'),
  amount: { total: 2900, currency: 'CNY' },
};
const bodyStr = JSON.stringify(bodyObj);
const timestamp = Math.floor(Date.now() / 1000).toString();
const nonce = crypto.randomBytes(16).toString('hex');
const message = `POST\n${apiPath}\n${timestamp}\n${nonce}\n${bodyStr}\n`;
const signature = crypto.sign('RSA-SHA256', Buffer.from(message), crypto.createPrivateKey(pem)).toString('base64');
const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${serial}"`;

const res = await fetch(`https://api.mch.weixin.qq.com${apiPath}`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'qtvq-api/1.0',
    Authorization: authorization,
    'Wechatpay-Serial': serial,
  },
  body: bodyStr,
});

const text = await res.text();
console.log('HTTP', res.status);
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text.slice(0, 400));
}
