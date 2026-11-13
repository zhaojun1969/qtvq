/** 汇款流终验：到期回退（实时判断）+ 会员注销拦截 + 全量清理 */
import process from 'node:process';
const BASE = 'https://qtvq.cn';
const DIRECT = 'https://qtvq-api.pages.dev';
const { connectDB, getDB } = await import('/opt/qtvq/server/src/config/db.js');
await connectDB();
const db = getDB();
const AK = process.env.ADMIN_KEY || process.env.PAYMENT_ADMIN_KEY;

let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + '  ' + d); } };

// 准备：注册 + 激活月卡（正确 clientId）
const phone = '199' + String(Date.now()).slice(-8);
const clientId = 'diag_fin_' + Date.now().toString(36);
const r1 = await fetch(BASE + '/api/auth', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'register', phone, password: 'Fin#2026x', clientId }),
}).then((r) => r.json());
const uid = r1.user?.id || r1.user?.userId;
const token = r1.token;

const act = await fetch(BASE + `/v1/admin/client-quota/${clientId}/activate`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': AK },
  body: JSON.stringify({ plan: 'month' }),
}).then((r) => r.json());
check('激活月卡（clientId 键）', act?.data?.activated === true, JSON.stringify(act).slice(0, 100));

const me1 = await fetch(DIRECT + '/api/auth/me', { headers: { Authorization: 'Bearer ' + token } }).then((r) => r.json());
check('激活后 unlimited=true', me1?.quota?.unlimited === true, JSON.stringify(me1?.quota).slice(0, 80));

// ⑤ 到期回退：把订阅 activeUntil 改到过去（模拟时间流逝）
const upd = await db.collection('client_quota').updateOne(
  { _id: clientId },
  { $set: { 'subscription.activeUntil': Date.now() - 86400000 } },
);
check('⑤a 订阅到期修改落库', upd.modifiedCount === 1, `modified=${upd.modifiedCount}`);
const me2 = await fetch(DIRECT + '/api/auth/me', { headers: { Authorization: 'Bearer ' + token } }).then((r) => r.json());
check('⑤b 到期后 unlimited 自动回退 false', me2?.quota?.unlimited === false, `unlimited=${me2?.quota?.unlimited}`);

// ⑥ 会员未到期注销拦截（重新激活后）
await fetch(BASE + `/v1/admin/client-quota/${clientId}/activate`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': AK }, body: JSON.stringify({ plan: 'month' }) });
const del = await fetch(DIRECT + '/api/auth/delete', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify({ password: 'Fin#2026x' }),
}).then(async (r) => ({ status: r.status, body: await r.json() }));
check('⑥ 未到期注销被 409 E_MEMBER_ACTIVE 拦截', del.status === 409 && del.body?.code === 'E_MEMBER_ACTIVE', `HTTP ${del.status} ${JSON.stringify(del.body).slice(0, 80)}`);

// ⑦ 汇款待核实的注销拦截（重新提交汇款 → 先撤会员 → 汇款待核实状态拦截）
// 会员激活后 paymentPending 已清 → 这里验证的是另一条闸门：无会员+有 pending
// （先清会员订阅，再提交一笔汇款，不清 pending → 注销）
await db.collection('client_quota').updateOne({ _id: clientId }, { $set: { subscription: null } });
const remit2 = await fetch(DIRECT + '/api/payment', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify({ plan: 'month', payerName: '终验', paidAt: '2026-11-13 10:00', amount: 29, clientId }),
}).then((r) => r.json());
const del2 = await fetch(DIRECT + '/api/auth/delete', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify({ password: 'Fin#2026x' }),
}).then(async (r) => ({ status: r.status, body: await r.json() }));
check('⑦ 有待核实汇款时注销被 409 E_PAYMENT_PENDING 拦截', del2.status === 409 && del2.body?.code === 'E_PAYMENT_PENDING', `HTTP ${del2.status} ${JSON.stringify(del2.body).slice(0, 80)}`);

// 清理
await db.collection('users').deleteOne({ _id: uid });
await db.collection('auth_users').deleteOne({ userId: uid });
await db.collection('auth_sessions').deleteMany({ userId: uid });
await db.collection('wallet').deleteOne({ _id: uid });
await db.collection('wallet_ledger').deleteMany({ uid });
await db.collection('client_quota').deleteOne({ _id: clientId }).catch(() => {});
await db.collection('client_billing').deleteOne({ clientId }).catch(() => {});
console.log('清理完成:', clientId);
console.log(`\n结论: 通过 ${pass} · 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
