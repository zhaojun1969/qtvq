/** 留言审核机制线上验证：正常应过、词表命中应拒；跑完清理测试记录 */
import process from 'node:process';
const BASE = 'https://qtvq.cn';
const { connectDB, getDB } = await import('/opt/qtvq/server/src/config/db.js');

async function post(message, clientId) {
  const res = await fetch(BASE + '/api/contact', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, clientId, replyEmail: 'qtvq@qtvq.cn' }),
  });
  return { status: res.status, body: (await res.text()).slice(0, 150) };
}

await connectDB();
const db = getDB();

const ok1 = await post('审核机制验证：正常留言测试（可删）', 'audit_contact_ok');
console.log('正常留言:', ok1.status, ok1.body);

const blocked = await post('加微信免费领取资料', 'audit_contact_blocked');
console.log('引流词留言:', blocked.status, blocked.body);

// 清理两条测试留言
const c1 = await db.collection('contact_messages').deleteMany({ clientId: /^audit_contact_/ });
console.log('清理测试留言:', c1.deletedCount, '条');

// 判定
const okPass = ok1.status === 200;
const blockHit = blocked.status === 400 || blocked.status === 403 || /审核|安全|违规/.test(blocked.body);
console.log('\n结论:', okPass && blockHit ? '审核机制生效（正常过/命中拒）' : `异常：ok=${okPass} block=${blockHit}`);
process.exit(okPass && blockHit ? 0 : 1);
