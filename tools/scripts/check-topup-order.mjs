/**
 * 验证「充值订单」创建：自定义金额 + 携带 uid（Node 钱包主键）。
 * 不真付款，只确认下单链路与订单内容正确。
 */
const payload = {
  clientId: 'topup_order_probe',
  plan: 'topup',
  amount: 1,
  uid: 'u_topup_probe_test',
  channel: 'native',
};

console.log('=== 1) 创建 ¥1 充值订单 ===');
const r = await fetch('https://qtvq.cn/api/payment/wechat/create', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
const t = await r.text();
let j = null;
try {
  j = JSON.parse(t);
} catch {
  /* raw */
}
console.log(`  HTTP ${r.status}`);
console.log(`  ${JSON.stringify(j).slice(0, 400)}`);
if (j?.codeUrl) console.log('  ✅ 拿到真实微信订单二维码（金额由订单决定，用户无需再输金额）');
else console.log('  ❌ 未拿到 codeUrl');

console.log('\n=== 2) 查询该订单（应为 NOTPAY，且金额为 ¥1）===');
if (j?.orderId) {
  const q = await fetch(`https://qtvq.cn/api/payment/wechat/query?orderId=${encodeURIComponent(j.orderId)}&clientId=${encodeURIComponent(payload.clientId)}`);
  const qt = await q.text();
  console.log(`  HTTP ${q.status}  ${qt.slice(0, 300)}`);
}

console.log('\n=== 3) 金额非法时应被拒 ===');
for (const amount of [0, 5000, 1.005]) {
  const rr = await fetch('https://qtvq.cn/api/payment/wechat/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, amount }),
  });
  const tt = await rr.text();
  console.log(`  amount=${amount} → HTTP ${rr.status}  ${tt.slice(0, 120)}`);
}

console.log('\n=== 4) 缺少 uid 时应被拒（无法入账就不该下单）===');
const r4 = await fetch('https://qtvq.cn/api/payment/wechat/create', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...payload, uid: undefined }),
});
console.log(`  HTTP ${r4.status}  ${(await r4.text()).slice(0, 160)}`);
