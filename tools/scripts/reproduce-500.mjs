/**
 * 复现「HTTP 500」：浏览器提交时比 curl 多带了 Authorization: Bearer <token>。
 * 逐个变体试，找出哪个会让函数抛异常。
 */
const payload = {
  clientId: 'diag500_' + Date.now().toString(36),
  plan: 'topup',
  amount: 1,
  payerName: '诊断',
  paidAt: '2026-09-18 00:30',
  remark: '诊断500',
};

const variants = [
  ['不带 Authorization（我之前的 curl 情形）', {}],
  ['带一个无效 token', { Authorization: 'Bearer invalid-token-abc' }],
  ['带一个形状像真 token 的值', { Authorization: 'Bearer 0123456789abcdef0123456789abcdef' }],
  ['带 Authorization 但没有 Bearer 前缀', { Authorization: 'garbage' }],
];

for (const [label, extra] of variants) {
  const res = await fetch('https://qtvq.cn/api/payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://qtvq.cn', ...extra },
    body: JSON.stringify(payload),
  }).catch((e) => ({ status: 'ERR ' + e.message, text: async () => '' }));

  const text = typeof res.text === 'function' ? await res.text() : '';
  const ct = res.headers?.get?.('content-type') || '';
  console.log(`=== ${label} ===`);
  console.log(`  HTTP ${res.status}   content-type=${ct || '(无)'}`);
  console.log(`  响应：${String(text).slice(0, 200).replace(/\s+/g, ' ')}`);
  if (res.status === 500) console.log('  ★★★ 复现了 500！');
  console.log('');
}
