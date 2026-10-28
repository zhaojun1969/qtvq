/**
 * 复现浏览器端的「缘值充值·提交核实」请求，找出"提交失败"的真实原因。
 * 关键：浏览器的报错文案只来自 `data.error`，若响应不是 JSON（例如 404/405/500 的 HTML），
 * 前端就会退化成笼统的「提交失败」—— 所以这里把**原始状态码 + 响应体**都打出来。
 */
const payload = {
  clientId: 'diag_' + Date.now().toString(36),
  plan: 'topup',
  amount: 1,
  payerName: '诊断',
  paidAt: '2026-09-17 23:59',
  remark: '诊断请求',
};

const targets = [
  ['同源（nginx → Pages）', 'https://qtvq.cn/api/payment'],
  ['直连 Pages', 'https://qtvq-api.pages.dev/api/payment'],
];

for (const [label, url] of targets) {
  console.log(`=== ${label}  ${url} ===`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://qtvq.cn',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36',
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    console.log(`  HTTP ${res.status}  content-type=${res.headers.get('content-type')}`);
    console.log(`  响应体：${text.slice(0, 400)}`);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    if (!json) console.log('  ⚠️ 响应不是 JSON —— 前端会因此显示笼统的「提交失败」');
    else console.log(`  ✅ JSON 正常；error=${json.error || '(无)'} noticeSent=${json.noticeSent ?? '(无)'}`);
  } catch (e) {
    console.log(`  请求异常：${e.message}`);
  }
  console.log('');
}

// 顺带确认：预检（OPTIONS）是否被正确放行（浏览器发 JSON 时会先发 OPTIONS）
console.log('=== OPTIONS 预检（浏览器发 JSON 前会先发这个）===');
try {
  const res = await fetch('https://qtvq.cn/api/payment', {
    method: 'OPTIONS',
    headers: { Origin: 'https://qtvq.cn', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  console.log(`  HTTP ${res.status}`);
  for (const h of ['access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers']) {
    console.log(`  ${h}: ${res.headers.get(h)}`);
  }
} catch (e) {
  console.log('  预检异常：', e.message);
}
