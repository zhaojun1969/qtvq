import fs from 'node:fs';
import crypto from 'node:crypto';

const dev = fs.readFileSync('.dev.vars', 'utf8');
const get = (k) => {
  const line = dev.split(/\r?\n/).find((l) => l.startsWith(`${k}=`));
  return line ? line.slice(k.length + 1).trim() : '';
};
const adminKey = get('PAYMENT_ADMIN_KEY');
const mchId = get('WECHAT_MCH_ID');
const serial = get('WECHAT_MCH_SERIAL');
let privateKey = get('WECHAT_MCH_PRIVATE_KEY');
// .dev.vars 里 PEM 是多行，需要拼接
if (privateKey.includes('BEGIN') && !privateKey.includes('END')) {
  const lines = dev.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('WECHAT_MCH_PRIVATE_KEY='));
  const parts = [privateKey];
  for (let i = start + 1; i < lines.length; i += 1) {
    parts.push(lines[i]);
    if (lines[i].includes('END PRIVATE KEY')) break;
  }
  privateKey = parts.join('\n');
}

console.log('=== 1) 我们系统里的订单（按时间倒序，看最近 8 笔）===');
const j = await (await fetch(`https://qtvq.cn/api/payment?list=orders&adminKey=${encodeURIComponent(adminKey)}`)).json();
const orders = (j.orders || j.items || []).slice(0, 8);
for (const o of orders) {
  const ago = Math.round((Date.now() - (o.createdAt || 0)) / 60000);
  console.log(
    `  ${o.orderId}  ${o.status.padEnd(8)} ¥${o.amount}  ${o.channel}  ${ago} 分钟前  ${o.platformTradeNo ? '交易号' + o.platformTradeNo : '无交易号'}`,
  );
}

const paid = orders.filter((o) => o.status === 'paid');
console.log(`\n  已支付(paid)的最近订单数：${paid.length}`);

/* 对每笔查微信侧真实状态 */
function authorization(method, urlPath) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = `${method}\n${urlPath}\n${ts}\n${nonce}\n\n`;
  const signature = crypto.createSign('RSA-SHA256').update(message).sign(privateKey, 'base64');
  return `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${ts}",serial_no="${serial}"`;
}

console.log('\n=== 2) 逐笔问微信真实交易状态（权威）===');
for (const o of orders.slice(0, 8)) {
  const urlPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(o.orderId)}?mchid=${encodeURIComponent(mchId)}`;
  try {
    const res = await fetch(`https://api.mch.weixin.qq.com${urlPath}`, {
      headers: {
        Authorization: authorization('GET', urlPath),
        Accept: 'application/json',
        'User-Agent': 'qtvq-api/1.0',
        'Accept-Language': 'zh-CN',
      },
    });
    const data = await res.json().catch(() => ({}));
    const state = data.trade_state || data.code || `HTTP ${res.status}`;
    const amt = data.amount?.total;
    console.log(`  ${o.orderId}  微信侧=${state}${amt ? `  实收=¥${amt / 100}` : ''}`);
  } catch (e) {
    console.log(`  ${o.orderId}  查询失败 ${e.message}`);
  }
}
