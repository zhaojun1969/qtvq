/** reveal 链路线上验证：登录态查邮箱 → 每日上限 429 → 审计落库 → 清理 */
import process from 'node:process';
const BASE = 'https://qtvq.cn';
const { connectDB, getDB } = await import('/opt/qtvq/server/src/config/db.js');
await connectDB();
const db = getDB();

const phone = '199' + String(Date.now()).slice(-8);
const clientId = 'dbg_reveal_' + Date.now().toString(36);
const r1 = await fetch(BASE + '/api/auth', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'register', phone, password: 'Reveal#1', clientId }),
}).then((r) => r.json());
const token = r1.token;
const uid = r1.user?.id || r1.user?.userId;
console.log('注册:', uid);

const out = [];
for (let i = 1; i <= 6; i++) {
  const r = await fetch(BASE + '/v1/contact/reveal', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ clientId }),
  });
  const j = await r.json().catch(() => ({}));
  out.push(`${i}:${r.status}${j.email ? '(email✓,余' + j.remaining + ')' : ''}${j.code ? '(' + j.code + ')' : ''}`);
}
console.log('reveal 序列:', out.join('  '));
const audited = await db.collection('contact_reveals').countDocuments({ uid });
console.log('审计落库:', audited, '条');

// 清理：账号 + 审计记录
await db.collection('users').deleteMany({ $or: [{ _id: uid }, { userId: uid }] });
await db.collection('auth_users').deleteOne({ userId: uid });
await db.collection('auth_sessions').deleteMany({ userId: uid });
await db.collection('contact_reveals').deleteMany({ uid });
console.log('清理完成');
process.exit(0);
