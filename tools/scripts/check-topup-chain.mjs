/**
 * 验证「在线充值自动到账」的入账链路，重点验证**幂等**。
 *
 * 为什么必须验幂等：微信回调会重试、前端轮询也会重复触发，
 * 如果入账不幂等，用户充一次钱可能被加多次余额 —— 这是自动到账能不能上线的硬前提。
 *
 * 用测试 uid（u_topup_probe_test）+ ¥0.01，并连续调用两次：
 *   · 第一次：credited = 0.01
 *   · 第二次：credited = 0（replayed），余额不变 ← 幂等 ✅
 */
import fs from 'node:fs';

const key = (fs.readFileSync('server/.env', 'utf8').split(/\r?\n/).find((l) => l.startsWith('ADMIN_KEY=')) || '')
  .slice('ADMIN_KEY='.length)
  .trim();

const uid = 'u_topup_probe_test';
// 与支付系统实际发送的一致（含 createIfMissing）：用户在 Pages 侧注册、
// Node 侧可能还没有资料文档，自动入账需要按需创建。
const body = {
  amount: 0.01,
  ref: 'ord_probe_idempotent_1',
  reason: '链路自测（可忽略）',
  createIfMissing: true,
};

const call = async () => {
  const r = await fetch(`https://qtvq.cn/v1/admin/users/${uid}/credit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  let j = null;
  try {
    j = JSON.parse(t);
  } catch {
    /* raw */
  }
  return { status: r.status, j, t };
};

console.log('=== 第一次入账 ===');
const a = await call();
console.log(`  HTTP ${a.status}  ${JSON.stringify(a.j?.data ?? a.j ?? a.t).slice(0, 200)}`);

console.log('=== 第二次入账（同一 ref，应当幂等）===');
const b = await call();
console.log(`  HTTP ${b.status}  ${JSON.stringify(b.j?.data ?? b.j ?? b.t).slice(0, 200)}`);

const bal = async () => {
  const r = await fetch(`https://qtvq.cn/v1/admin/users/${uid}`, { headers: { 'X-Admin-Key': key } });
  const j = await r.json().catch(() => ({}));
  return j?.data?.wallet?.balance ?? j?.data?.balance ?? j?.wallet?.balance ?? null;
};

console.log('');
console.log('余额（两次之后）:', await bal());

const creditedA = a.j?.data?.credited ?? a.j?.credited;
const creditedB = b.j?.data?.credited ?? b.j?.credited;
console.log('');
if (creditedA === 0.01 && creditedB === 0) {
  console.log('✅ 幂等成立：第一次入账 0.01，第二次 credited=0（未重复入账）');
  console.log('   → 微信回调重试 / 前端轮询重复触发都不会重复加钱，自动到账可以放心上线');
} else {
  console.log(`⚠️ 幂等未按预期表现：第一次 credited=${creditedA}，第二次 credited=${creditedB}`);
  console.log('   → 请勿上线自动到账，先查 Node 侧 credit() 的 idempotencyKey 逻辑');
}
