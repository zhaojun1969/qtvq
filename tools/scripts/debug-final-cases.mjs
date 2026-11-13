/** 最后一批可自动化边界用例：图片大小边界/中文名/并发注册竞态/导出完整性 */
import process from 'node:process';
const BASE = 'https://qtvq.cn';
const { connectDB, getDB } = await import('/opt/qtvq/server/src/config/db.js');
await connectDB();
const db = getDB();

let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + '  ' + d); } };

const clientId = 'case_final_' + Date.now().toString(36);
const phone = '199' + String(Date.now()).slice(-8);
const r1 = await fetch(BASE + '/api/auth', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'register', phone, password: 'Final#2026', clientId }),
}).then((r) => r.json());
const uid = r1.user?.id || r1.user?.userId;
const token = r1.token;
console.log('测试号:', uid);

// C1 图片超 400KB（500KB 假 JPEG data URI）→ 400
const bigB64 = 'data:image/jpeg;base64,' + 'A'.repeat(500 * 1024 * 3 / 4);
let r = await fetch(BASE + '/api/contact', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: '大图测试', clientId, images: [{ name: 'big.jpg', type: 'image/jpeg', data: bigB64 }] }),
});
check('C1 500KB 图片被 400', r.status === 400, `HTTP ${r.status}`);

// C2 恰好 380KB（合法）→ 通过
const okB64 = 'data:image/jpeg;base64,' + 'B'.repeat(380 * 1024 * 3 / 4);
r = await fetch(BASE + '/api/contact', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: '合法图测试', clientId, images: [{ name: 'ok.jpg', type: 'image/jpeg', data: okB64 }] }),
});
check('C2 380KB 图片通过', r.status === 200, `HTTP ${r.status}`);

// C3 中文文件名（截断到 80 字符，落库 name 正确）
const longCnName = '很长的中文文件名'.repeat(10) + '.png';
r = await fetch(BASE + '/api/contact', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: '中文名测试', clientId, images: [{ name: longCnName, type: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=' }] }),
});
const cj = await r.json().catch(() => ({}));
check('C3 中文长文件名处理（不 500）', r.status === 200 || r.status === 400, `HTTP ${r.status}`);
const stored = await db.collection('contact_messages').findOne({ clientId }, { sort: { createdAt: -1 } });
check('C3b 中文名截断 ≤80 字符', stored ? (stored.images?.[0]?.name?.length || 0) <= 80 : false, `name.len=${stored?.images?.[0]?.name?.length}`);

// C4 并发注册同手机号（竞态）：2 笔同时 → 恰好 1 用户
const phone2 = '199' + String(Date.now()).slice(-8);
const body2 = JSON.stringify({ action: 'register', phone: phone2, password: 'Race#2026', clientId: 'race_' + Date.now().toString(36) });
const [ra, rb] = await Promise.all([
  fetch(BASE + '/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body2 }).then((x) => x.json()),
  fetch(BASE + '/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body2 }).then((x) => x.json()),
]);
const okCount = (ra.ok ? 1 : 0) + (rb.ok ? 1 : 0);
const userCount = await db.collection('auth_users').countDocuments({ phone: phone2 });
check('C4 并发注册同号：恰好 1 成功 1 用户', okCount === 1 && userCount === 1, `ok=${okCount} users=${userCount}`);

// C5 数据导出内容完整性（注册→提问→导出→结构断言）
await fetch(BASE + '/api/chat', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify({ message: '导出验证提问', clientId }),
});
const exp = await fetch(BASE + '/v1/me/export', { headers: { Authorization: 'Bearer ' + token } }).then((x) => x.text());
let expJ = null;
try { expJ = JSON.parse(exp); } catch {}
const expKeys = expJ ? Object.keys(expJ.data || expJ) : [];
check('C5a 导出 200 + 可解析 JSON', Boolean(expJ), `HTTP ${exp.status}`);
check('C5b 含个人资料/问答记录', /profile|chat|record|quota/i.test(expKeys.join(',')) || expKeys.length >= 3, expKeys.join(','));
check('C5c 不含密码/openid 明文', !/passwordHash|passwordSalt|openid/i.test(JSON.stringify(expJ)), '');

// 清理
await db.collection('users').deleteOne({ _id: uid });
await db.collection('auth_users').deleteOne({ userId: uid }).catch(() => {});
await db.collection('auth_users').deleteOne({ phone: phone2 }).catch(() => {});
await db.collection('auth_sessions').deleteMany({ $or: [{ userId: uid }, { userId: uid }] }).catch(() => {});
await db.collection('contact_messages').deleteMany({ clientId: /^case_final_|race_/ }).catch(() => {});
await db.collection('chat_messages').deleteMany({ clientId }).catch(() => {});
await db.collection('client_quota').deleteMany({ _id: { $in: [clientId, 'race_' + Date.now().toString(36)] } }).catch(() => {});
console.log('清理完成');
console.log(`\n结论: 通过 ${pass} · 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
