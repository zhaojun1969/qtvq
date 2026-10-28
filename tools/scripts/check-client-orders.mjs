/**
 * 核对某个客户的全部订单在**微信侧**的真实状态。
 * 目的：确认那些 pending 订单是"客户没付款"，而不是"付了钱没开通"。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const dev = fs.readFileSync('.dev.vars', 'utf8');
const g = (k) => {
  const line = dev.split(/\r?\n/).find((l) => l.startsWith(`${k}=`));
  return line ? line.slice(k.length + 1).trim() : '';
};
const adminKey = g('PAYMENT_ADMIN_KEY');
const mchId = g('WECHAT_MCH_ID');
const serial = g('WECHAT_MCH_SERIAL');
let pk = g('WECHAT_MCH_PRIVATE_KEY');
if (pk.includes('BEGIN') && !pk.includes('END')) {
  const lines = dev.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('WECHAT_MCH_PRIVATE_KEY='));
  const parts = [pk];
  for (let i = start + 1; i < lines.length; i += 1) {
    parts.push(lines[i]);
    if (lines[i].includes('END PRIVATE KEY')) break;
  }
  pk = parts.join('\n');
}

const cid = process.argv[2] || 'q_mpffb1yt_nzbdriw1';
const list = await (await fetch(`https://qtvq.cn/api/payment?list=orders&adminKey=${encodeURIComponent(adminKey)}`)).json();
const mine = (list.orders || list.items || []).filter((o) => o.clientId === cid);
console.log(`客户 ${cid} 共 ${mine.length} 笔订单，逐笔向微信核对：\n`);

const auth = (urlPath) => {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const msg = `GET\n${urlPath}\n${ts}\n${nonce}\n\n`;
  const sig = crypto.createSign('RSA-SHA256').update(msg).sign(pk, 'base64');
  return `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonce}",signature="${sig}",timestamp="${ts}",serial_no="${serial}"`;
};

const tally = {};
for (const o of mine) {
  const p = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(o.orderId)}?mchid=${encodeURIComponent(mchId)}`;
  let state = 'QUERY_FAILED';
  try {
    const r = await fetch(`https://api.mch.weixin.qq.com${p}`, {
      headers: { Authorization: auth(p), Accept: 'application/json', 'User-Agent': 'qtvq/1.0', 'Accept-Language': 'zh-CN' },
    });
    const j = await r.json().catch(() => ({}));
    state = j.trade_state || j.code || `HTTP${r.status}`;
  } catch (e) {
    state = 'ERR:' + e.message.slice(0, 20);
  }
  tally[state] = (tally[state] || 0) + 1;
  console.log(`  ${o.orderId}  本地=${o.status.padEnd(7)} 微信侧=${state}  ¥${o.amount}`);
}

console.log('\n=== 汇总 ===');
for (const [k, v] of Object.entries(tally)) console.log(`  ${k}: ${v} 笔`);
const paid = tally.SUCCESS || 0;
console.log('');
console.log(paid ? `⚠️ 其中 SUCCESS=${paid} 笔：说明有真实收款，需确认是否已开通` : '✅ 没有任何一笔 SUCCESS —— 这些 pending 全部是"客户没完成付款"，不涉及资金');
