/** D4 并发防双花实测（修正版）：注册 → 充 10 元（credit）→ 6 笔并发扣 10 元 → 必须恰好 1 成 5 败（402）→ 清理 */
import process from 'node:process';
const BASE = 'https://qtvq.cn';
const { connectDB, getDB } = await import('/opt/qtvq/server/src/config/db.js');
await connectDB();
const db = getDB();

const phone = '199' + String(Date.now()).slice(-8);
const clientId = 'case_cc2_' + Date.now().toString(36);
const r1 = await fetch(BASE + '/api/auth', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'register', phone, password: 'Cc#2026x', clientId }),
}).then((r) => r.json());
const uid = r1.user?.id || r1.user?.userId;
const w = await db.collection('wallet').findOne({ _id: uid });
console.log('注册:', uid, '| 初始余额:', w?.balance ?? '(无 wallet 文档)');

const { spend } = await import('/opt/qtvq/server/src/services/wallet.js');
const results = await Promise.all(
  Array.from({ length: 6 }, (_, i) =>
    spend(uid, 10, { reason: 'case_cc2_' + i }).then(
      (r) => ({ i, ok: true, charged: r.charged, balanceAfter: r.balance }),
      (e) => ({ i, ok: false, status: e.status, err: String(e.message || e).slice(0, 36) }),
    ),
  ),
);
const succeeded = results.filter((r) => r.ok);
const failed = results.filter((r) => !r.ok);
console.log('并发 6 笔扣 10 元 → 成功:', succeeded.length, '| 402 拒绝:', failed.length);
console.log('成功后余额轨迹:', JSON.stringify(succeeded.map((r) => r.balanceAfter)));
const w2 = await db.collection('wallet').findOne({ _id: uid });
console.log('最终 wallet.balance:', w2?.balance, '| ledger(done):', await db.collection('wallet_ledger').countDocuments({ uid, status: 'done' }));

const pass = succeeded.length === 1 && failed.length === 5 && Number(w2?.balance) === 0;
console.log(pass ? '\n✅ D4 并发防双花实证通过（原子条件扣款生效）' : '\n❌ 异常，需排查');
// 清理
await db.collection('users').deleteOne({ _id: uid });
await db.collection('auth_users').deleteOne({ userId: uid });
await db.collection('auth_sessions').deleteMany({ userId: uid });
await db.collection('wallet').deleteOne({ _id: uid });
await db.collection('wallet_ledger').deleteMany({ uid });
console.log('清理完成');
process.exit(0);
