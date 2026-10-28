/**
 * P3-T3.2 / T3.3 端到端自检：渠道归因 → 邀请券 → 券抵扣 → 核销
 *
 * 为什么单独一个脚本而不是塞进 e2e-report-skus.mjs：
 * 那边验的是"三种报告都能付费生成"（商品链路），这边验的是"钱从哪来/优惠怎么算"（定价链路）。
 * 两条链路的失败面完全不同，混在一起报错时看不出是哪边坏了。
 *
 * 跑法（在 /opt/qtvq/server 下）：
 *   MONGO_DB=qtvq_e2e_coupons PORT=3998 ALLOW_DEV_LOGIN=1 \
 *     node --env-file=.env scripts/e2e-coupons.mjs
 *
 * 安全：只写 `*e2e*` 测试库，否则拒绝运行；跑完按 `--keep` 决定是否删库。
 */
import process from 'node:process';

const PORT = Number(process.env.PORT || 3998);
const BASE = `http://127.0.0.1:${PORT}`;
const MONGO_DB = String(process.env.MONGO_DB || '');
const KEEP = process.argv.includes('--keep');
const RUN = `e2e${Date.now().toString(36)}`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

async function req(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json, data: json?.data ?? json };
}

/** 注册一个真账号（走 Node 侧 /api/auth，和网页注册同一条路） */
async function register(phone, { ch, inviterUid } = {}) {
  const r = await req('POST', '/api/auth', {
    body: {
      action: 'register',
      phone,
      password: 'CouponE2e123',
      clientId: `e2e_${phone.slice(-4)}`,
      ch: ch || undefined,
      inviterUid: inviterUid || undefined,
      landingAt: Date.now(),
    },
  });
  return r;
}

async function main() {
  if (!/e2e/i.test(MONGO_DB)) {
    console.error(`拒绝运行：MONGO_DB="${MONGO_DB}" 不是测试库。请显式传 MONGO_DB=qtvq_e2e_xxx。`);
    process.exit(2);
  }
  process.env.MONGO_DB = MONGO_DB;
  process.env.ALLOW_DEV_LOGIN = '1';

  console.log(`\n=== 券/归因自检 · 库 ${MONGO_DB} · 端口 ${PORT} ===\n`);
  await import('../src/app.js');
  await new Promise((r) => setTimeout(r, 1200));

  const { getDB } = await import('../src/config/db.js');
  const db = getDB();
  await db.collection('coupons').createIndex({ inviteKey: 1 }, { unique: true, sparse: true });

  const suffix = RUN.slice(-6);
  const phoneA = `139${String(Date.now()).slice(-8)}`;
  const phoneB = `138${String(Date.now()).slice(-8)}`;

  /* ── 1) 邀请人 A 注册（带渠道码 ch=xhs01） ─────────────────────────── */
  const a = await register(phoneA, { ch: 'xhs01' });
  check('邀请人 A 注册成功', a.status === 200 && !!a.data?.token, `HTTP ${a.status} ${a.json?.error || ''}`);
  const tokenA = a.data?.token;
  const uidA = a.data?.user?.userId || a.data?.user?.id;

  const userA = await db.collection('auth_users').findOne({ userId: uidA });
  check('A 的 acquisition 落库', userA?.acquisition?.channel === 'xhs01', JSON.stringify(userA?.acquisition));

  /* ── 2) 被邀请人 B 用 A 的 uid + 另一个渠道码注册 ──────────────────── */
  const b = await register(phoneB, { ch: 'dy07', inviterUid: uidA });
  check('被邀请人 B 注册成功', b.status === 200 && !!b.data?.token, `HTTP ${b.status} ${b.json?.error || ''}`);
  check('注册响应回报发券结果', b.data?.invite?.issued === true, JSON.stringify(b.data?.invite));

  const couponsA = await db.collection('coupons').find({ uid: uidA }).toArray();
  check('A 获得一张 ¥4.9 邀请券', couponsA.length === 1 && couponsA[0].valueFen === 490, `count=${couponsA.length} valueFen=${couponsA[0]?.valueFen}`);
  check('券的幂等键含双方 uid', couponsA[0]?.inviteKey === `${uidA}:${b.data?.user?.userId || b.data?.user?.id}`, couponsA[0]?.inviteKey);

  /* ── 3) 幂等：同一对邀请人/被邀请人不会发第二张 ─────────────────────── */
  const { grantInviteCoupon } = await import('../src/services/coupons.js');
  const again = await grantInviteCoupon({ inviterUid: uidA, inviteeUid: b.data?.user?.userId || b.data?.user?.id });
  check('重复发券被唯一索引挡住', again.ok === false && again.duplicate === true, JSON.stringify(again));

  const self = await grantInviteCoupon({ inviterUid: uidA, inviteeUid: uidA });
  check('自己邀请自己被拒绝', self.ok === false && self.error === 'E_SELF_INVITE', JSON.stringify(self));

  /* ── 4) /v1/report/skus 必须体现出券后价 ────────────────────────────── */
  const profA = await req('PATCH', '/v1/profile/me', {
    token: tokenA,
    body: { nickname: '券用户A', gender: 'female', age: 30, city: '北京', tags: ['沟通'], intro: '端到端自检账号，喜欢看书' },
  });
  check('A 填资料', profA.status === 200, `HTTP ${profA.status}`);
  await req('POST', '/v1/profile/adult', { token: tokenA, body: { birthYear: new Date().getFullYear() - 30 } });

  const skus = await req('GET', '/v1/report/skus', { token: tokenA });
  const diag = skus.data?.skus?.diagnose;
  check('skus 下发可用券', skus.data?.couponFen === 490, `couponFen=${skus.data?.couponFen}`);
  // A 从没买过诊断 → 首单价 490，券 490 全额抵掉 → 应付 0
  check('券后价 = 0（首单价 + 券全额抵扣）', diag?.payableFen === 0, `yourPriceFen=${diag?.yourPriceFen} discount=${diag?.couponDiscountFen} payable=${diag?.payableFen}`);

  /* ── 5) 下单：0 元单直接结清并核销券 ───────────────────────────────── */
  const pay = await req('POST', '/v1/payment/wechat/create', { token: tokenA, body: { sku: 'diagnose', channel: 'native' } });
  check('0 元单由券结清', pay.status === 200 && pay.data?.paidByCoupon === true, `HTTP ${pay.status} ${JSON.stringify(pay.json).slice(0, 200)}`);
  check('0 元单金额为 0 且记录了抵扣', Number(pay.data?.amountFen) === 0 && Number(pay.data?.discountFen) === 490, `amountFen=${pay.data?.amountFen} discount=${pay.data?.discountFen}`);

  const orderA = await db.collection('orders').findOne({ orderId: pay.data?.orderId });
  check('订单状态 paid 且 meta 记了券', orderA?.status === 'paid' && orderA?.meta?.couponId === couponsA[0]?._id?.toString(), `status=${orderA?.status} meta=${JSON.stringify(orderA?.meta)}`);

  const couponAfter = await db.collection('coupons').findOne({ _id: couponsA[0]?._id });
  check('券已核销到该订单', couponAfter?.usedInOrderId === pay.data?.orderId, `usedInOrderId=${couponAfter?.usedInOrderId}`);

  const skus2 = await req('GET', '/v1/report/skus', { token: tokenA });
  check('券用掉后列表为空', (skus2.data?.coupons || []).length === 0 && skus2.data?.couponFen === 0, `couponFen=${skus2.data?.couponFen}`);

  /* ── 6) 首单价在支付侧也生效（这是之前真出过的不一致） ─────────────── */
  // B 也是新用户，但 B 没有券：diagnose 应付的就是首单价 490
  const profB = await req('PATCH', '/v1/profile/me', {
    token: b.data?.token,
    body: { nickname: '券用户B', gender: 'male', age: 31, city: '上海', tags: ['沟通'], intro: '端到端自检账号，周末打球' },
  });
  check('B 填资料', profB.status === 200, `HTTP ${profB.status}`);
  await req('POST', '/v1/profile/adult', { token: b.data?.token, body: { birthYear: new Date().getFullYear() - 31 } });

  const payB = await req('POST', '/v1/payment/wechat/create', { token: b.data?.token, body: { sku: 'diagnose', channel: 'native' } });
  check(
    '支付接口按首单价 490 建单（不是 990）',
    Number(payB.data?.amountFen) === 490,
    `amountFen=${payB.data?.amountFen} base=${payB.data?.basePriceFen} discount=${payB.data?.discountFen}`,
  );

  /* ── 7) 收尾 ───────────────────────────────────────────────────────── */
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\n=== 通过 ${pass} · 失败 ${fail} ===`);

  if (!KEEP) {
    await db.dropDatabase();
    console.log(`  已删除测试库 ${MONGO_DB}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('自检异常：', err);
  process.exit(1);
});
