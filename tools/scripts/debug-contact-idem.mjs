/** A8 复测：60 秒幂等窗口——同 clientId+同内容两次提交 → 只落一条、第二次带 duplicate 标记 */
import process from 'node:process';
const BASE = 'https://qtvq.cn';
const { connectDB, getDB } = await import('/opt/qtvq/server/src/config/db.js');
await connectDB();
const db = getDB();
const clientId = 'case_idem_' + Date.now().toString(36);
const msg = '幂等窗口验证（可删）';

const r1 = await fetch(BASE + '/api/contact', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: msg, clientId, replyEmail: 'qtvq@qtvq.cn' }),
}).then((r) => ({ s: r.status, j: r.json && null, t: null, raw: r }));
void r1;
const first = await fetch(BASE + '/api/contact', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: msg, clientId, replyEmail: 'qtvq@qtvq.cn' }),
}).then(async (r) => ({ status: r.status, json: await r.json() }));
const second = await fetch(BASE + '/api/contact', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: msg, clientId, replyEmail: 'qtvq@qtvq.cn' }),
}).then(async (r) => ({ status: r.status, json: await r.json() }));

const count = await db.collection('contact_messages').countDocuments({ clientId, message: msg });
console.log('第一次:', first.status, 'duplicate=', first.json?.duplicate ?? false);
console.log('第二次:', second.status, 'duplicate=', second.json?.duplicate ?? false);
console.log('落库条数:', count);
console.log('结论:', first.status === 200 && second.status === 200 && second.json?.duplicate === true && count === 1 ? '幂等生效 ✅' : '异常 ❌');

await db.collection('contact_messages').deleteMany({ clientId });
console.log('清理:', clientId);
process.exit(0);
