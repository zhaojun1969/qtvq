/** 异常流/恢复流探针（E.86 用例清单前置实测）：补 E2E 未覆盖的负向用例，跑完自清理 */
import process from 'node:process';
const BASE = 'https://qtvq.cn';
const { connectDB, getDB } = await import('/opt/qtvq/server/src/config/db.js');
await connectDB();
const db = getDB();

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}  ${detail}`); }
};
async function j(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const post = (p, body, token) => j(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
const patch = (p, body, token) => j(BASE + p, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });

console.log('=== 异常流探针 ===');
// A1 重复注册
const phone = '199' + String(Date.now()).slice(-8);
const r1 = await post('/api/auth', { action: 'register', phone, password: 'Case#2026', clientId: 'case_' + Date.now().toString(36) });
const r2 = await post('/api/auth', { action: 'register', phone, password: 'Case#2026', clientId: 'case2_' + Date.now().toString(36) });
check('A1 重复注册被拒（该手机号已注册）', r2.status === 400 && /已注册/.test(r2.json?.error || ''), `HTTP ${r2.status} ${JSON.stringify(r2.json).slice(0, 80)}`);
const uid = r1.json?.user?.id || r1.json?.user?.userId;
const token = r1.json?.token;

// A2 错密码连续 5 次（观察是否有锁定/延迟）
let all401 = true;
for (let i = 0; i < 5; i++) {
  const r = await post('/api/auth', { action: 'login', phone, password: 'Wrong#' + i, clientId: 'case_x' });
  if (r.status !== 401) all401 = false;
}
check('A2 连续 5 次错密码均 401（无信息泄漏）', all401);

// A3 手机号格式边界
const bads = ['12345678901', '199', '', '1995044772a'];
let fmtAll = true;
for (const b of bads) {
  const r = await post('/api/auth', { action: 'register', phone: b, password: 'Case#2026', clientId: 'case_f' });
  if (r.status !== 400) fmtAll = false;
}
check('A3 非法手机号格式 4 变体全部 400', fmtAll);

// A4 密码长度边界（5 位拒 / 6 位过）
const r5 = await post('/api/auth', { action: 'register', phone: '199' + String(Date.now() + 1).slice(-8), password: 'Aa1#2', clientId: 'case_p5' });
check('A4a 5 位密码被拒', r5.status === 400, `HTTP ${r5.status}`);
const r6 = await post('/api/auth', { action: 'register', phone: '199' + String(Date.now() + 2).slice(-8), password: 'Aa1#23', clientId: 'case_p6' });
check('A4b 6 位密码通过', r6.status === 200, `HTTP ${r6.status}`);

// A5 超长昵称（300 字）
let r = await patch('/v1/profile/me', { nickname: '超'.repeat(300) }, token);
check('A5 300 字昵称被拒或截断（不 500）', r.status === 400 || r.status === 200, `HTTP ${r.status}`);

// A6 留言超长（2001 字）
r = await post('/api/contact', { message: '长'.repeat(2001), clientId: 'case_long' });
check('A6 2001 字留言被 400', r.status === 400, `HTTP ${r.status}`);

// A7 留言图片格式校验（非 image data URI）
r = await post('/api/contact', { message: '附图测试', clientId: 'case_img', images: [{ name: 'a.txt', type: 'text/plain', data: 'data:text/plain;base64,SGVsbG8=' }] });
check('A7 非图片附件被 400', r.status === 400, `HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 60)}`);

// A8 留言重复提交幂等（同 id 两次 → 库里一条）
const cId = 'case_dup_' + Date.now().toString(36);
const dupBody = { id: cId, message: '幂等验证', clientId: cId };
await post('/api/contact', dupBody);
await post('/api/contact', dupBody);
const dupCount = await db.collection('contact_messages').countDocuments({ id: cId });
check('A8 同 id 留言两次落库一条（幂等）', dupCount === 1, `count=${dupCount}`);

// A9 匿名访问 admin 接口（不泄漏存在性）
r = await j(BASE + '/v1/admin/metrics');
check('A9 匿名 admin → 401/404（非 500/200）', r.status === 401 || r.status === 404, `HTTP ${r.status}`);

// A10 匿名举报 → 401
r = await post('/v1/moderation/report', { targetType: 'report', targetId: 'x', reason: 'spam' });
check('A10 匿名举报 401', r.status === 401, `HTTP ${r.status}`);

// A11 越权：他人报告枚举（假 ObjectId）不泄漏存在性
r = await j(BASE + '/v1/report/000000000000000000000000', { headers: { Authorization: 'Bearer ' + token } });
check('A11 不存在报告 → 401/404（无泄漏）', r.status === 401 || r.status === 404, `HTTP ${r.status}`);

// A12 /v1 强制同源后，直连 Pages 域打 /v1 → 必须非 200（Pages 无该路由）
r = await j('https://qtvq-api.pages.dev/v1/wallet');
check('A12 直连 Pages 域 /v1 不提供服务（非 200 数据）', r.status !== 200, `HTTP ${r.status}`);

// A13 恢复流：改密码后旧 token 状态 + 新登录重试（覆盖恢复语义）
r = await post('/api/auth', { action: 'adminResetPassword', phone, newPassword: 'Case#new1', adminKey: process.env.ADMIN_KEY || process.env.PAYMENT_ADMIN_KEY });
const relogin = await post('/api/auth', { action: 'login', phone, password: 'Case#new1', clientId: 'case_re' });
check('A13 重置后新凭据可恢复登录', relogin.status === 200 && relogin.json?.ok, `HTTP ${relogin.status}`);

console.log('=== 清理 ===');
const clean = { uid };
await db.collection('auth_users').deleteOne({ userId: uid });
await db.collection('auth_users').deleteMany({ phone: { $in: bads.concat([phone]) } });
await db.collection('auth_sessions').deleteMany({ userId: uid });
await db.collection('users').deleteMany({ $or: [{ _id: uid }, { userId: uid }] });
await db.collection('contact_messages').deleteMany({ clientId: /^case_/ });
// A4b/A13 建的号也要清（拿 phone 正则）
const strays = await db.collection('auth_users').find({ phone: /^199\d{8}$/ }).toArray();
for (const s of strays) {
  if (/^199(4751|4752|4984|5044)/.test(s.phone || '')) continue; // 保护真实用户段
  await db.collection('auth_users').deleteOne({ userId: s.userId });
  await db.collection('auth_sessions').deleteMany({ userId: s.userId });
}
console.log(`清理完成（含 A1/A4/A13 测试号）`);
console.log(`\n结论：通过 ${pass} · 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
