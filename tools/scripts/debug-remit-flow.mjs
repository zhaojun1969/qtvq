/** 激活链路诊断：注册→汇款提交→激活(全量响应)→桥记录→CF me 三方对照 */
import process from 'node:process';
const BASE = 'https://qtvq.cn';
const DIRECT = 'https://qtvq-api.pages.dev';
const { connectDB, getDB } = await import('/opt/qtvq/server/src/config/db.js');
await connectDB();
const db = getDB();
const AK = process.env.ADMIN_KEY || process.env.PAYMENT_ADMIN_KEY;

const phone = '199' + String(Date.now()).slice(-8);
const clientId = 'diag_act_' + Date.now().toString(36);
const r1 = await fetch(BASE + '/api/auth', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'register', phone, password: 'Act#2026x', clientId }),
}).then((r) => r.json());
const uid = r1.user?.id || r1.user?.userId;
const token = r1.token;
console.log('注册:', uid);

const submit = await fetch(DIRECT + '/api/payment', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify({ plan: 'month', payerName: '诊断', paidAt: '2026-11-12 10:00', amount: 29, clientId }),
}).then(async (r) => ({ status: r.status, body: await r.text() }));
console.log('提交汇款:', submit.status, submit.body.slice(0, 100));

const act = await fetch(BASE + `/v1/admin/client-quota/${uid}/activate`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': AK },
  body: JSON.stringify({ plan: 'month' }),
}).then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 200) }));
console.log('激活响应:', act.status, act.body);

const bridge = await fetch(BASE + `/v1/admin/client-quota/${uid}`, { headers: { 'X-Admin-Key': AK } }).then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 300) }));
console.log('桥记录:', bridge.status, bridge.body);

const me = await fetch(DIRECT + '/api/auth/me', { headers: { Authorization: 'Bearer ' + token } }).then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 260) }));
console.log('CF me:', me.status, me.body);

process.exit(0);
