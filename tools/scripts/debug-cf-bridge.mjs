/** 金丝雀：模拟 CF 桥接的精确请求路径（外网 → qtvq.cn → nginx → Node），逐层打印真实响应 */
import crypto from 'node:crypto';

const BASE = 'https://qtvq.cn';
const AK = process.env.ADMIN_KEY;
if (!AK) { console.error('缺 ADMIN_KEY'); process.exit(1); }

async function j(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, body: text };
}
const show = (o) => JSON.stringify(o).slice(0, 260);

const phone = '199' + String(Date.now()).slice(-8);
const clientId = 'canary_' + Date.now().toString(36);

const r1 = await j(BASE + '/api/auth', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'register', phone, password: 'Dbg#test1', clientId }),
});
const r1j = r1.json;
const token = r1j.token;
const uid = r1j.user?.id || r1j.user?.userId;
console.log('0 register:', r1.status, 'uid=', uid, 'token.len=', token?.length);

const hashId = crypto.createHash('sha256').update('session:' + token).digest('hex').slice(0, 32);
const s = await j(`${BASE}/v1/admin/auth-sessions/${hashId}`, { headers: { 'X-Admin-Key': AK } });
console.log('1 session桥(外网):', s.status, s.body);

const u1 = await j(`${BASE}/v1/admin/auth-users/${uid}`, { headers: { 'X-Admin-Key': AK } });
console.log('2 user桥(外网)第1次:', u1.status, u1.body);

const u2 = await j(`${BASE}/v1/admin/auth-users/${uid}`, { headers: { 'X-Admin-Key': AK } });
console.log('3 user桥(外网)第2次(缓存行为):', u2.status, u2.body);

for (let i = 1; i <= 2; i++) {
  const m = await j('https://qtvq-api.pages.dev/api/auth/me', { headers: { Authorization: 'Bearer ' + token } });
  console.log(`4 CF me 第${i}次:`, m.status, m.body);
}

// 清理
const del = await j(`${BASE}/api/auth`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'adminResetPassword', phone, newPassword: 'Dbg#del1', adminKey: AK }),
});
const del2 = await j('https://qtvq-api.pages.dev/api/auth/delete', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify({ password: 'Dbg#del1' }),
});
console.log('5 admin重置+CF delete:', del.status, del2.status, del2.body.slice(0, 120));
process.exit(0);
