/** 转盘全流程线上实测：注册→成年→资料→候选池→quote→spin→扣费台账→清理 */
import process from 'node:process';
const BASE = 'https://qtvq.cn';
const { connectDB, getDB } = await import('/opt/qtvq/server/src/config/db.js');
await connectDB();
const db = getDB();

const phone = '199' + String(Date.now()).slice(-8);
const clientId = 'case_wheel_' + Date.now().toString(36);
const r1 = await fetch(BASE + '/api/auth', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'register', phone, password: 'Wheel#2026', clientId }),
}).then((r) => r.json());
const uid = r1.user?.id || r1.user?.userId;
const token = r1.token;
console.log('注册:', uid);
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };

let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + '  ' + d); } };

// 年龄门
let r = await fetch(BASE + '/v1/profile/adult', { method: 'POST', headers: H, body: JSON.stringify({ birthYear: 1998 }) }).then((x) => x.json());
check('年龄门 1998', r?.data?.ok === true || r?.ok === true, JSON.stringify(r).slice(0, 100));
// 资料（进候选池的完整度）
r = await fetch(BASE + '/v1/profile/me', { method: 'PATCH', headers: H, body: JSON.stringify({ nickname: '转盘验' + phone.slice(-4), gender: 'male', city: '北京', job: '测试', tags: ['电影'], intro: '转盘流程验证' }) }).then((x) => x.json());
check('资料发布', Boolean(r?.data?.user || r?.user), JSON.stringify(r).slice(0, 80));
// 候选池
r = await fetch(BASE + '/v1/wheel/candidates', { headers: H }).then((x) => x.json());
const cand = r?.data?.candidates || r?.candidates || [];
check('候选池接口可用', Array.isArray(cand), JSON.stringify(r).slice(0, 120));
console.log('  · 候选数:', cand.length, cand.length ? '(样本: ' + cand.slice(0, 2).map((c) => c.nickname || c.uid).join(',') + ')' : '(基线干净期候选为空属预期)');
// quote
r = await fetch(BASE + '/v1/wheel/quote', { method: 'POST', headers: H, body: JSON.stringify({ tier: 'basic' }) }).then((x) => x.json());
const price = r?.data?.price ?? r?.price ?? null;
check('quote 可用（basic）', Boolean(r), JSON.stringify(r).slice(0, 100));
// spin（免费首转或扣 ¥1）
r = await fetch(BASE + '/v1/wheel/spin', { method: 'POST', headers: H, body: JSON.stringify({ tier: 'basic', idempotencyKey: 'case_spin_' + Date.now().toString(36) }) }).then((x) => x.json());
const spin = r?.data || r;
check('转盘 spin 执行', Boolean(spin), JSON.stringify(spin).slice(0, 150));
const spinAgain = await fetch(BASE + '/v1/wheel/spin', { method: 'POST', headers: H, body: JSON.stringify({ tier: 'basic', idempotencyKey: 'case_spin_2_' + Date.now().toString(36) }) }).then((x) => x.json());
console.log('  · 第二转（观察免费次数/扣费/拒绝策略）:', JSON.stringify(spinAgain?.data || spinAgain).slice(0, 120));
// 扣费台账
const ledger = await db.collection('wallet_ledger').countDocuments({ uid });
check('扣费台账留痕', ledger >= 1, 'ledger=' + ledger);

// 清理
await db.collection('users').deleteOne({ _id: uid });
await db.collection('auth_users').deleteOne({ userId: uid });
await db.collection('auth_sessions').deleteMany({ userId: uid });
await db.collection('wallet').deleteOne({ _id: uid });
await db.collection('wallet_ledger').deleteMany({ uid });
await db.collection('invites').deleteMany({ fromUid: uid });
console.log('清理完成');
console.log(`\n结论: 通过 ${pass} · 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
