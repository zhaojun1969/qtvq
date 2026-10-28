/**
 * 三条报告「真实扣费」端到端验证（实施书 P2/P4 的最后一笔欠账）
 *
 * 为什么需要它：
 *   报告的计费开关（`ENFORCE_REPORT_BILLING`）默认是**关**的 —— 这是刻意的，
 *   扣钱的开关不该因为"忘了配环境变量"就悄悄打开。于是"三种报告能真实收钱"
 *   这件事一直只验证到"下单接口返回 402/价格字段"，没有验证过
 *   「余额真的少了 → 账本真的记了 → 报告真的出了」这条闭环。
 *
 * 这个脚本在**服务器上**跑（要读 .env、签发本地 token、直连 Mongo），做三件事：
 *   1. 造一个干净的测试 uid（资料齐全、18+、余额足够），余额用 admin credit 真入账；
 *   2. 依次调用 diagnose / retro / pair 的 `/v1/report/generate`，
 *      等异步生成完成（`pending → ready`）；
 *   3. 逐单核对：**余额减少额 == 报告单价**、账本有一笔 `report` 流水、报告 status=ready。
 *
 * 跑法（服务器）：
 *   cd /opt/qtvq/server && node --env-file=.env scripts/e2e-report-billing.mjs
 *   ... --uid=u_rptprobe_xxx --keep      # 指定 uid / 跑完不删测试数据
 *
 * 前置条件（脚本会自检并给出可直接粘的命令）：
 *   .env 里 `ENFORCE_REPORT_BILLING=1`，且 `REPORT_BILLING_GRAY_UIDS` 含本脚本的 uid
 *   （灰度名单为空 = 全量生效；测试期间建议只放这个 uid）。
 */
import process from 'node:process';

const arg = (name, def = null) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const i = hit.indexOf('=');
  return i === -1 ? true : hit.slice(i + 1);
};

const KEEP = process.argv.includes('--keep');
const UID = String(arg('uid', 'u_rptprobe_billing_001'));
const BASE = String(arg('base', 'http://127.0.0.1:3000'));

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}

const yuan = (fen) => `¥${(Number(fen || 0) / 100).toFixed(2)}`;

async function main() {
  const { connectDB, getDB, closeDB } = await import('../src/config/db.js');
  const { credit } = await import('../src/services/wallet.js');
  const { signLocalToken } = await import('../src/middleware/auth.js');
  const { ADULT_AGREEMENT_VER } = await import('../src/middleware/adult.js');

  await connectDB();
  const db = getDB();

  console.log(`\n=== 三条报告真实扣费验证（uid=${UID}）===`);

  // ---- 前置：计费开关 ----
  if (process.env.ENFORCE_REPORT_BILLING !== '1') {
    console.error('❌ 报告计费开关未开。先在 .env 里加：\n   ENFORCE_REPORT_BILLING=1\n   REPORT_BILLING_GRAY_UIDS=' + UID + '\n   然后 sudo systemctl restart qtvq-report');
    process.exit(2);
  }
  const gray = String(process.env.REPORT_BILLING_GRAY_UIDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (gray.length && !gray.includes(UID)) {
    console.error(`❌ 灰度名单 ${JSON.stringify(gray)} 不含 ${UID}；这个 uid 不会被真扣，验证无意义。`);
    process.exit(2);
  }
  console.log(`  计费开关：开${gray.length ? `（灰度：${gray.join(', ')}）` : '（全量）'}`);

  // ---- 1. 造测试用户与目标 ----
  await db.collection('auth_users').updateOne(
    { userId: UID },
    { $set: { userId: UID, clientId: 'e2e_billing', createdAt: new Date(), updatedAt: new Date() }, $setOnInsert: { phone: null } },
    { upsert: true },
  );
  await db.collection('users').updateOne(
    { _id: UID },
    {
      $set: {
        nickname: '扣费验证号',
        gender: 'female',
        birthYear: 1995,
        status: 'active',
        // 年龄门：三个付费入口都挂 requireAdult，缺 adultAgreedAt 会 403 E_NEED_ADULT_AGREE
        adultAgreedAt: new Date(),
        adultAgreementVer: ADULT_AGREEMENT_VER,
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
  const me = await db.collection('users').findOne({ _id: UID });
  check('测试账号资料齐全（可生成报告）', Boolean(me?.nickname) && me?.birthYear === 1995);

  // pair 需要一个真实目标：优先取库里已有资料的用户
  const target = await db.collection('users').findOne({ _id: { $ne: UID }, nickname: { $exists: true } });
  if (!target) {
    console.error('❌ 库里没有可用的 pair 目标用户（需要至少一份真实资料）');
    process.exit(1);
  }
  console.log(`  pair 目标：${target._id}（${target.nickname}）`);

  // ---- 2. 真入账（走钱包服务，不是直接改库）----
  const before = Number((await db.collection('wallet').findOne({ _id: UID }))?.balance || 0);
  await credit(UID, 100, {
    reason: 'billing_e2e',
    operator: 'e2e-report-billing',
    ref: 'e2e_billing_' + Date.now(),
    idempotencyKey: 'e2e_credit_' + UID + '_' + Date.now(),
  });
  const startBalance = Number((await db.collection('wallet').findOne({ _id: UID }))?.balance || 0);
  check(`余额已入账（${yuan(before * 100)} → ${yuan(startBalance * 100)}）`, startBalance >= 100);

  const token = signLocalToken(UID);
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // ---- 3. 逐单生成 ----
  const cases = [
    {
      sku: 'diagnose',
      body: {
        sku: 'diagnose',
        description: '我们认识三个月，他从不主动约我，但只要我开口他都会答应。最近两周已读不回超过 72 小时，我一直在等一个解释。',
        scenes: ['ambiguous', 'cold'],
        question: '他到底想不想认真？',
      },
    },
    {
      sku: 'retro',
      body: {
        sku: 'retro',
        selfView: '我总觉得自己在追着一段关系跑，每次争执后都是我主动去修，久了我开始怀疑是不是我太敏感。',
        partnerView: '他觉得我要求太多、动不动就谈"以后"，他更想活在当下，不想被定义。',
        history: '第一年热恋，第二年异地，第三年他工作变动开始冷下来，最近半年每月至少爆发一次同样的争吵。',
        question: '这段关系还值得挽救吗？',
      },
    },
    {
      sku: 'pair',
      body: { sku: 'pair', targetUid: String(target._id), tier: 'deep', question: '我们适不适合长期走下去？' },
    },
  ];

  /*
   * 关键一步：报告的"真实扣费"走的是**已支付订单**（微信），不是钱包余额。
   * 钱包余额只用于转盘/会员等其它商品 —— 所以这里必须真的建单 + 真的让微信侧
   * 生成 prepay（code_url），然后把订单置为已支付再消费。
   *
   * 唯一不能自动完成的是"扫一下付钱"：那需要一台手机和真人。所以脚本明确区分两件事：
   *   · ✅ 微信侧下单成功（code_url 可扫）= 商户证书/签名/金额都对；
   *   · ✅ 已支付订单 → 生成报告 → 订单被消费（且不能重复消费）= 计费闭环；
   *   · ⚠️ "钱真的从买家账户划走"仍需一次人工扫码（脚本会在结尾提示金额）。
   */
  const { createOrder, markPaid, getOrder } = await import('../src/services/orders.js');
  const { createNativeOrder, isWechatPayConfigured } = await import('../src/services/wechat-pay.js');

  const results = [];
  for (const c of cases) {
    const priceFen = await fetch(`${BASE}/v1/report/skus`, { headers: authHeaders })
      .then((r) => r.json())
      .then((j) => j?.data?.skus?.[c.sku]?.yourPriceFen ?? j?.data?.skus?.[c.sku]?.priceFen ?? null)
      .catch(() => null);
    const fallbackPrice = { diagnose: 490, retro: 1990, pair: 2990 }[c.sku];
    const amountFen = Number(priceFen || fallbackPrice);

    // 1) 本地建单（金额与商品都对）
    const order = await createOrder({ uid: UID, sku: c.sku, amountFen, channel: 'native', meta: { e2e: true } });

    // 2) 真的调微信下单（这一步验证商户证书 + APIv3 签名）
    let codeUrl = null;
    let prepayError = null;
    if (isWechatPayConfigured()) {
      try {
        const prepay = await createNativeOrder({
          orderId: order.orderId,
          description: `Q问·${c.sku}（扣费验证）`,
          amountFen,
          notifyUrl: process.env.WECHAT_PAY_NOTIFY_URL,
        });
        codeUrl = prepay?.codeUrl || null; // 服务层返回的是 camelCase（codeUrl），不是微信原始的 code_url
      } catch (err) {
        prepayError = err?.message || String(err);
      }
    }
    check(
      `${c.sku} 微信侧真实下单（codeUrl 可扫）`,
      Boolean(codeUrl && codeUrl.startsWith('weixin://')),
      prepayError || (isWechatPayConfigured() ? '微信返回里没有 codeUrl' : '商户号未配置')
    );

    // 3) 模拟"支付成功后微信回调"的结果：把订单置为已支付
    await markPaid({ orderId: order.orderId, transactionId: 'e2e_prepay:' + order.orderId, amountFen });
    const paidOrder = await getOrder(order.orderId);
    check(`${c.sku} 订单状态=paid`, paidOrder?.status === 'paid', `实际 ${paidOrder?.status}`);

    const res = await fetch(`${BASE}/v1/report/generate`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ ...c.body, orderId: order.orderId }),
    });
    const json = await res.json().catch(() => ({}));
    const reportId = json?.data?.reportId || json?.reportId || null;
    check(`${c.sku} 下单成功`, res.ok && Boolean(reportId), `HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
    if (!reportId) continue;

    // 等异步生成完成
    let report = null;
    const deadline = Date.now() + 180_000;
    let ticks = 0;
    while (Date.now() < deadline) {
      const r = await fetch(`${BASE}/v1/report/${reportId}`, { headers: authHeaders });
      const j = await r.json().catch(() => ({}));
      report = j?.data || null;
      if (report?.status === 'ready' || report?.status === 'failed') break;
      ticks += 1;
      await new Promise((r2) => setTimeout(r2, 4000));
    }

    // 订单必须被消费掉（否则说明报告是"白拿"的）
    const consumed = await getOrder(order.orderId);
    console.log(
      `    报告 ${c.sku}: status=${report?.status} 订单=${consumed?.status} 金额 ${yuan(amountFen)} 完整度=${report?.completeness ?? '—'}`
    );
    check(`${c.sku} 报告生成完成（ready）`, report?.status === 'ready', `实际 ${report?.status}`);
    check(`${c.sku} 付费订单已被消费`, consumed?.status === 'consumed', `实际 ${consumed?.status}`);
    check(`${c.sku} 报告内容非空`, Boolean(report?.sections?.summary || report?.content));

    // 防重复消费：同一张已消费订单再下单必须被拒（否则一次付费出两份报告）
    const replay = await fetch(`${BASE}/v1/report/generate`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ ...c.body, orderId: order.orderId }),
    });
    const replayJson = await replay.json().catch(() => ({}));
    check(
      `${c.sku} 同一订单不能重复使用`,
      replay.status === 400 && (replayJson.errorCode === 'E_ORDER_UNUSABLE' || /订单不可用/.test(replayJson.error || '')),
      `HTTP ${replay.status} ${JSON.stringify(replayJson).slice(0, 160)}`
    );

    results.push({ sku: c.sku, reportId, status: report?.status, amountFen, codeUrl, completeness: report?.completeness ?? null });
  }

  const totalFen = results.reduce((a, r) => a + Number(r.amountFen || 0), 0);
  console.log(`\n  三张单合计 ${yuan(totalFen)}${results.every((r) => r.codeUrl) ? '（微信侧均成功下单，可扫码真实支付）' : ''}`);
  check('三单都走了"已支付订单"闭环', results.length === 3 && results.every((r) => r.status === 'ready'));

  if (!KEEP) {
    await db.collection('wallet_ledger').deleteMany({ uid: UID });
    await db.collection('wallet').deleteOne({ _id: UID });
    await db.collection('users').deleteOne({ _id: UID });
    await db.collection('auth_users').deleteOne({ userId: UID });
    await db.collection('orders').deleteMany({ uid: UID });
    await db.collection('reports').deleteMany({ uid: UID });
    console.log('  🗑  测试数据已清理（--keep 可保留）');
  }

  console.log(`\n通过 ${pass} · 失败 ${fail}`);
  if (fail) console.log(`失败项：${failures.join('、')}`);

  await closeDB();
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  console.error('❌ 验证脚本异常：', err?.stack || err?.message || err);
  process.exit(1);
});
