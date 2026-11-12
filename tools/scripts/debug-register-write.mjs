/** 决定性实验：HTTP 注册（生产服务）→ 同进程立即查 Mongo —— 消除时间窗，找出注册写入的真实落点 */
import process from 'node:process';
const BASE = 'https://qtvq.cn';
const { connectDB, getDB } = await import('/opt/qtvq/server/src/config/db.js');
await connectDB();
const db = getDB();
console.log('MONGO_DB 实际值:', process.env.MONGO_DB || '(默认)');

const phone = '199' + String(Date.now()).slice(-8);
const clientId = 'dbg7_' + Date.now().toString(36);
const r1 = await fetch(BASE + '/api/auth', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'register', phone, password: 'Dbg#test1', clientId }),
}).then((r) => r.json());
const uid = r1.user?.id || r1.user?.userId;
console.log('register:', r1.ok, 'uid=', uid);

const u1 = await db.collection('users').findOne({ _id: uid });
console.log('① 立即查 users:', u1 ? `存在 keys=${Object.keys(u1).slice(0, 8).join(',')}` : '不存在！');

// 全库集合搜：这个 uid 到底落在哪个集合
const hits = [];
const cols = (await db.listCollections().toArray()).map((c) => c.name);
for (const name of cols) {
  try {
    const n = await db.collection(name).countDocuments({ $or: [{ _id: uid }, { userId: uid }, { id: uid }] });
    if (n > 0) hits.push(`${name}(${n})`);
  } catch { /* 系统集合无谓词支持时跳过 */ }
}
console.log('② 全库搜 uid 命中:', hits.join(', ') || '无任何集合');
process.exit(0);
