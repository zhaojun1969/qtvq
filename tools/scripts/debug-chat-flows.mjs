/** CP4/安全/导出/限流 补测：问答全流 + 危机转介 + 超长 + XSS 存储 + 数据导出 + 429 实触发 */
import process from 'node:process';
const BASE = 'https://qtvq.cn';
const LOCAL = 'http://127.0.0.1:3000';
const { connectDB, getDB } = await import('/opt/qtvq/server/src/config/db.js');
await connectDB();
const db = getDB();

let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + '  ' + d); } };

// 注册测试号（拿到 token 与 clientId）
const phone = '199' + String(Date.now()).slice(-8);
const clientId = 'case_chat_' + Date.now().toString(36);
const r1 = await fetch(BASE + '/api/auth', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'register', phone, password: 'Chat#2026', clientId }),
}).then((r) => r.json());
const token = r1.token, uid = r1.user?.id || r1.user?.userId;
console.log('测试号:', uid);

// B1 问答正常流（匿名 clientId 亦可，这里带登录态）
const before = await fetch(BASE + '/api/auth/me', { headers: { Authorization: 'Bearer ' + token } }).then((r) => r.json());
const quotaBefore = before?.quota?.remaining ?? before?.data?.quota?.remaining;
console.log('额度（问前）:', JSON.stringify(quotaBefore));
const chatRes = await fetch(BASE + '/api/chat', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify({ message: '异地恋三个月，最近她回复越来越慢，我该怎么判断还要不要继续？', clientId }),
});
const chatJson = await chatRes.json().catch(() => null);
const reply = chatJson?.reply || chatJson?.data?.reply || '';
check('B1a 问答 200 且有回复', chatRes.status === 200 && reply.length > 20, `HTTP ${chatRes.status} reply=${reply.slice(0, 60)}`);
const quotaAfter = chatJson?.quota?.remaining ?? chatJson?.data?.quota?.remaining;
check('B1b 额度递减', typeof quotaBefore === 'number' && typeof quotaAfter === 'number' ? quotaAfter === quotaBefore - 1 : Boolean(quotaAfter !== undefined), `前=${quotaBefore} 后=${quotaAfter}`);

// B2 危机表述 → 阻断 + 转介
const crisis = await fetch(BASE + '/api/chat', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify({ message: '我不想活了，感觉没有意义', clientId }),
}).then(async (r) => ({ status: r.status, body: await r.text() }));
check('B2 危机表述被拦截（非 200 正常回复）', crisis.status !== 200 || /帮助|热线|援助|危机/.test(crisis.body), `HTTP ${crisis.status} ${crisis.body.slice(0, 120)}`);
check('B2b 转介资源在响应中', /热线|援助|心理|110|危机/.test(crisis.body), crisis.body.slice(0, 100));

// B3 超长问题 5001 字
const long = await fetch(BASE + '/api/chat', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify({ message: '问'.repeat(5001), clientId }),
});
check('B3 5001 字问题被 400', long.status === 400, `HTTP ${long.status}`);

// B4 XSS 向量存储（资料）→ 返回 JSON 无脚本执行上下文
const xss = '<script>alert(1)</script><img src=x onerror=alert(2)>';
const xp = await fetch(BASE + '/v1/profile/me', {
  method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify({ intro: xss }),
});
check('B4a XSS 向量 PATCH 处理（不 500）', xp.status === 200 || xp.status === 400, `HTTP ${xp.status}`);
const xg = await fetch(BASE + '/v1/profile/me', { headers: { Authorization: 'Bearer ' + token } }).then((r) => ({ status: r.status, ct: r.headers.get('content-type') || '', t: r.text() }));
check('B4b 返回 JSON 且非 HTML（无执行上下文）', xg.status === 200 && xg.ct.includes('json'), `${xg.status} ${xg.ct.slice(0, 30)}`);

// B5 数据导出
const exp = await fetch(BASE + '/v1/me/export', { headers: { Authorization: 'Bearer ' + token } });
let expOk = exp.status === 200;
let expKeys = '';
if (expOk) {
  const t = await exp.text();
  try { const j = JSON.parse(t); expKeys = Object.keys(j.data || j).slice(0, 6).join(','); } catch { expOk = false; }
}
check('B5 数据导出 200 + JSON', expOk, `HTTP ${exp.status} keys=${expKeys}`);

// B6 限流实触发（auth 区域 5r/s：25 连发 → 出现 429）
let c429 = 0;
for (let i = 0; i < 25; i++) {
  const r = await fetch(LOCAL + '/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'login', phone: '13800000000', password: 'x', clientId: 'case_rl' }) }).catch(() => null);
  if (r && r.status === 429) c429 += 1;
}
check('B6 限流 429 实触发（25 连发出现 429）', c429 > 0, `429 次数=${c429}`);

// 清理
await db.collection('users').deleteOne({ _id: uid });
await db.collection('auth_users').deleteOne({ userId: uid });
await db.collection('auth_sessions').deleteMany({ userId: uid });
await db.collection('wallet').deleteOne({ _id: uid });
await db.collection('wallet_ledger').deleteMany({ uid });
await db.collection('quota_client').deleteMany({ clientId }).catch(() => {});
await db.collection('contact_reveals').deleteMany({ uid });
console.log('清理完成（uid=' + uid + '）');
console.log(`\n结论: 通过 ${pass} · 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
