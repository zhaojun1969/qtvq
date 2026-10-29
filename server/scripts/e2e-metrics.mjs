/**
 * 指标聚合与 90 天验收门的离线验证（实施书 P4-T4.1/T4.2）
 *
 * 为什么要有这个脚本：
 *   `metrics.js` 里全是"口径"——留存分子分母、激活事件、CAC 的成本范围。
 *   这类代码**看不出对错**，只能拿造出来的数据跑一遍，然后逐字段核对。
 *   而且验收门最危险的行为不是算错，是"数据不足却给了绿灯"，
 *   所以这里专门测了 insufficient 分支和"s 恰好两项不达标"的边界。
 *
 * 安全约束：MONGO_DB 必须含 `e2e`，否则拒绝运行 —— 这个脚本会清库造数。
 *
 * 造数必须**照着生产形态造**：事件 `ts` 是 Date（`routes/track.js` 写 `new Date(ms)`），
 * 订单 `paidAt/createdAt` 线上是 Date 与毫秒数混着的。第一版脚本全用毫秒数，
 * 于是"查询按毫秒、库里是 Date"这个致命不一致一次都没被测到 —— 线上看板 `landingViews`
 * 恒为 0，测试却全绿。场景 1b/1c 就是为此补的回归。
 *
 * 跑法（服务器）：
 *   cd /opt/qtvq/server && MONGO_DB=qtvq_e2e_metrics timeout 300 node --env-file=.env scripts/e2e-metrics.mjs
 *
 * 参数：`--keep` 保留测试库（默认跑完删库）。
 */
import process from 'node:process';

const KEEP = process.argv.includes('--keep');
const MONGO_DB = process.env.MONGO_DB || '';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  ❌ ${name}\n     期望 ${JSON.stringify(expected)}\n     实际 ${JSON.stringify(actual)}`);
  }
}

function checkTruthy(name, actual) {
  if (actual) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  ❌ ${name}（实际 ${JSON.stringify(actual)}）`);
  }
}

async function main() {
  if (!MONGO_DB.includes('e2e')) {
    console.error(`❌ 拒绝运行：MONGO_DB=${MONGO_DB || '(空)'} 不含 "e2e"。这个脚本会清空数据库。`);
    process.exit(2);
  }

  const { connectDB, getDB } = await import('../src/config/db.js');
  await connectDB();
  const db = getDB();
  const metrics = await import('../src/services/metrics.js');
  const { dayKey, dayStart } = metrics;

  const addDays = (d, n) => {
    const x = new Date(d.getTime());
    x.setDate(x.getDate() + n);
    return x;
  };
  const monthCollOf = (d) => `events_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;

  async function wipe() {
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith('system.'));
    for (const n of names) await db.collection(n).deleteMany({});
  }

  let eventSeq = 0;
  /**
   * 造事件。
   *
   * `tsKind` 默认 `date` —— 生产里 `events_*.ts` **全是 Date**（`routes/track.js` 写入
   * `new Date(ms)`）。第一版这个脚本写成毫秒数，正好绕开了「查询用毫秒、库里是 Date」
   * 这个致命不一致：测试全绿，线上 `landingViews` 恒为 0。
   * `number` 分支用来保证兼容老数据。
   */
  async function addEvent(date, event, uid, extra = {}) {
    eventSeq += 1;
    const ms = date.getTime() + 12 * 3600 * 1000;
    await db.collection(monthCollOf(date)).insertOne({
      eventId: `e2e_${eventSeq}`,
      event,
      uid,
      anonId: null,
      ch: extra.ch ?? null,
      props: extra.props ?? {},
      ts: extra.tsKind === 'number' ? ms : new Date(ms),
      receivedAt: new Date(),
    });
  }

  async function addUser(userId, createdAt, channel) {
    await db.collection('auth_users').insertOne({
      userId,
      phone: `1${String(Math.floor(Math.random() * 1e9)).padStart(10, '0')}`,
      clientId: 'e2e',
      createdAt: createdAt.getTime(),
      acquisition: channel ? { channel, landingAt: createdAt.getTime() } : null,
    });
  }

  /**
   * 造订单。`sku: null` = 会员/充值单（老数据只有 `plan`），用来验证
   * 「报告漏斗只算报告单，实收算全部单」这条区分。
   */
  async function addOrder(orderId, uid, at, { amountFen, status = 'consumed', sku = 'diagnose', tsKind = 'date' } = {}) {
    const stamp = tsKind === 'number' ? at.getTime() : new Date(at.getTime());
    const doc = {
      orderId,
      uid,
      amountFen,
      status,
      createdAt: stamp,
      paidAt: stamp,
      consumedAt: status === 'consumed' ? stamp : null,
      meta: {},
    };
    if (sku) doc.sku = sku;
    else doc.plan = 'pro30';
    await db.collection('orders').insertOne(doc);
  }

  console.log(`\n=== 指标聚合验证（库 ${MONGO_DB}）===`);

  /* ---------------------------------------------------------------- 场景 1：单日口径 */
  await wipe();
  const D = addDays(dayStart(dayKey()), -10); // D+1 早已过完，留存可判定
  const D1 = addDays(D, 1);
  for (let i = 1; i <= 4; i += 1) await addUser(`m1_u${i}`, D, 'xhs01');
  await addEvent(D, 'profile_complete', 'm1_u1');
  await addEvent(D, 'question_asked', 'm1_u2');
  /*
   * 无 uid 的激活事件：**必须不计入激活**，也不能把 anonId 当成用户去重。
   *
   * 这条是线上"激活恒为 0"事故的回归用例：埋点没带 Authorization 时
   * 服务端 `resolveIdentity` 拿到 null，事件照样落库、`activated` 永远是 0，
   * 而看板上与"还没有用户"完全无法区分。造数时若只造带 uid 的事件，
   * 这类口径错误一次都测不出来。
   */
  await addEvent(D, 'question_asked', null, { ch: 'xhs01' });
  await addEvent(D1, 'login', 'm1_u1'); // 次日仍活跃的只有 u1（事件必须落在 D+1）
  await addEvent(D, 'report_landing_view', 'm1_u1');
  await addEvent(D, 'report_landing_view', 'm1_u2');
  await addEvent(D, 'report_landing_view', null, { ch: 'xhs01' });
  await addEvent(D, 'share_card_save', 'm1_u1');
  await addEvent(D, 'share_card_landing', null, { ch: 'xhs01' });
  await addEvent(D, 'landing_view', null, { ch: 'xhs01' });
  await addEvent(D, 'landing_view', null, { ch: 'xhs01' });
  await addOrder('e2e_o1', 'm1_u1', D, { amountFen: 490 });
  await addOrder('e2e_o2', 'm1_u2', D, { amountFen: 0, status: 'paid' });

  const row = await metrics.aggregateDay(dayKey(D));
  check('新增用户 = 4', row.newUsers, 4);
  check('激活（3 条激活事件里 1 条无 uid，只算带 uid 的 2 人）', row.activated, 2);
  check('次日留存可判定样本 = 4', row.d1Eligible, 4);
  check('次日留存 = 1/4', row.d1Retained, 1);
  check('次日留存率 = 0.25', row.d1Rate, 0.25);
  check('报告页浏览 = 3', row.reportViews, 3);
  check('订单数 = 2', row.reportOrders, 2);
  check('付费单 = 2（含 0 元单）', row.reportPaid, 2);
  check('付费用户去重 = 2', row.paidUsers, 2);
  check('实收只算真钱 = 490 分', row.revenueFen, 490);
  check('0 元单单独计数 = 1', row.zeroPaid, 1);
  check('分享卡生成 = 1', row.shareGenerated, 1);
  check('分享回流 = 1', row.shareLanding, 1);
  check('落地页曝光 = 2', row.landingViews, 2);

  // 报告质量日聚合：趋势的最小单位是「一天生成了几份 / 几份偏短 / 平均多少字」
  await db.collection('reports').insertMany([
    { uid: 'm1_u1', sku: 'diagnose', kind: 'diagnose', status: 'ready', quality: { chars: 800, low: false }, createdAt: new Date(D.getTime() + 3 * 3600 * 1000) },
    { uid: 'm1_u2', sku: 'diagnose', kind: 'diagnose', status: 'ready', quality: { chars: 400, low: true }, createdAt: new Date(D.getTime() + 5 * 3600 * 1000) },
    { uid: 'm1_u3', sku: 'retro', kind: 'retro', status: 'ready', quality: { chars: 1500, low: false }, createdAt: new Date(D.getTime() + 7 * 3600 * 1000) },
  ]);
  const rowQ = await metrics.aggregateDay(dayKey(D));
  check('当天报告份数 = 3', rowQ.reportsGenerated, 3);
  check('其中低质 = 1', rowQ.reportsLowQuality, 1);
  check('当天字数合计 = 2700', rowQ.reportCharsSum, 2700);
  check('按 sku 统计 diagnose = 2 份', rowQ.reportCountBySku.diagnose, 2);

  // 当天（D+1 还没过完）不能给出留存 0，必须是 null
  const todayRow = await metrics.aggregateDay(dayKey());
  check('当天 d1Retained 为 null（不是 0）', todayRow.d1Retained, null);
  check('当天 d1Rate 为 null（不是 0）', todayRow.d1Rate, null);

  // 幂等：重算两次结果一致，且不会插出两条
  const again = await metrics.aggregateDay(dayKey(D));
  check('重算幂等：留存不变', again.d1Retained, 1);
  check('重算幂等：metrics_daily 只一条', await db.collection('metrics_daily').countDocuments({ date: dayKey(D) }), 1);

  /* ------------------------------------------- 场景 1b：混合 ts 类型 + 报告单/实收区分 */
  /*
   * 这三条回归对应的都是"线上数字恒为 0 而测试全绿"的坑：
   *  1. 事件 ts 生产是 Date，第一版脚本造的是毫秒数 → 查询用毫秒比 Date，一条都匹配不上；
   *  2. `orders.paidAt/createdAt` 老数据毫秒、新数据 Date，同一种查询必然漏一半；
   *  3. 会员/充值单没有 sku，混进"报告下单"会让报告漏斗虚高。
   */
  await wipe();
  const Dm = addDays(dayStart(dayKey()), -10);
  await addUser('m1b_u1', Dm, 'xhs01');
  await addUser('m1b_u2', Dm, 'xhs01');
  await addUser('m1b_u3', Dm, 'xhs01');
  await addEvent(Dm, 'landing_view', null, { tsKind: 'date' });
  await addEvent(Dm, 'landing_view', null, { tsKind: 'date' });
  await addEvent(Dm, 'landing_view', null, { tsKind: 'number' });
  await addOrder('e2e_1b_a', 'm1b_u1', Dm, { amountFen: 490, tsKind: 'date' });
  await addOrder('e2e_1b_b', 'm1b_u2', Dm, { amountFen: 990, tsKind: 'number' });
  await addOrder('e2e_1b_c', 'm1b_u3', Dm, { amountFen: 2800, sku: null, tsKind: 'number' });
  const row1b = await metrics.aggregateDay(dayKey(Dm));
  check('混合 ts：毫秒数事件的落地页曝光也算到 = 3', row1b.landingViews, 3);
  check('报告下单只算报告单 = 2（排除会员单）', row1b.reportOrders, 2);
  check('报告支付只算报告单 = 2（排除会员单）', row1b.reportPaid, 2);
  check('报告实收 = 490+990', row1b.reportRevenueFen, 1480);
  check('总实收含会员单 = 4280', row1b.revenueFen, 4280);
  check('付费用户去重 = 3', row1b.paidUsers, 3);

  /* ---------------------------------------------- 场景 1c：跨月（分表月份 + 留存跨月）*/
  /*
   * 事件按月分表，写入侧原来用 UTC 算月份、聚合侧用本地时区：
   * 每月 1 号 00:00–08:00 的事件会进上个月的集合，聚合按本地月去取 → 整段丢失。
   */
  await wipe();
  const trackMod = await import('../src/routes/track.js');
  check(
    '分表月份按本地时区：11-01 00:30(+08:00) → events_202611',
    trackMod.monthCollection(new Date('2026-11-01T00:30:00+08:00')),
    'events_202611',
  );
  check(
    '分表月份按本地时区：10-31 23:30(+08:00) → events_202610',
    trackMod.monthCollection(new Date('2026-10-31T23:30:00+08:00')),
    'events_202610',
  );

  const thisMonthStart = new Date(dayStart(dayKey()).getFullYear(), dayStart(dayKey()).getMonth(), 1);
  const prevMonthEnd = addDays(thisMonthStart, -1); // 上月最后一天，其次日落在本月
  await addUser('m1c_u1', prevMonthEnd, 'xhs01');
  await addEvent(prevMonthEnd, 'profile_complete', 'm1c_u1');
  await addEvent(addDays(prevMonthEnd, 1), 'login', 'm1c_u1');
  const row1c = await metrics.aggregateDay(dayKey(prevMonthEnd));
  check('跨月：上月注册样本 = 1', row1c.d1Eligible, 1);
  check('跨月：次日事件落在下个月的分表里也能查到（留存 = 1）', row1c.d1Retained, 1);

  /* ---------------------------------------------------------------- 场景 2：90 天全部达标 */
  await wipe();
  const from = addDays(dayStart(dayKey()), -89);
  for (let i = 0; i < 90; i += 1) {
    const d = addDays(from, i);
    for (let k = 0; k < 2; k += 1) await addUser(`m2_u${i}_${k}`, d, 'xhs01');
    await addEvent(d, 'profile_complete', `m2_u${i}_0`); // 每天激活 1 人 → 90 人
    if (i < 89) await addEvent(addDays(d, 1), 'login', `m2_u${i}_0`); // 次日活跃 1/2 → 50%
    if (i % 15 === 0 && i < 90) await addOrder(`e2e_m2_${i}`, `m2_u${i}_0`, d, { amountFen: 490 }); // 6 单
  }
  for (let i = 0; i < 6; i += 1) {
    await metrics.recordChannelCost({ date: dayKey(addDays(from, i)), channel: 'xhs01', amountFen: 84, note: 'e2e' }); // 合计 504 分
  }
  await metrics.aggregateRange({ days: 90 });
  const gate2 = await metrics.acceptanceGate({ days: 90 });
  check('90 天场景：覆盖天数 = 90', gate2.coverage, 90);
  check('90 天场景：激活 = 90', gate2.activated, 90);
  check('90 天场景：付费 = 6', gate2.converted, 6);
  check('90 天场景：次日留存 50%', Math.round((gate2.summary.d1Rate || 0) * 1000) / 1000, 0.5);
  check('90 天场景：转化 6/90', Math.round((gate2.checks[1].value || 0) * 1000) / 1000, Math.round((6 / 90) * 1000) / 1000);
  check('90 天场景：三项判定', gate2.checks.map((c) => c.ok), [true, true, true]);
  check('90 天场景：验收通过', gate2.status, 'passed');

  /* ---------------------------------------------------------------- 场景 3：两项不达标 → 失败 */
  await wipe();
  for (let i = 0; i < 90; i += 1) {
    const d = addDays(from, i);
    for (let k = 0; k < 2; k += 1) await addUser(`m3_u${i}_${k}`, d, 'xhs01');
    await addEvent(d, 'profile_complete', `m3_u${i}_0`);
    // 刻意不加次日事件 → 留存 0（第一项不达标）
    if (i % 15 === 0) await addOrder(`e2e_m3_${i}`, `m3_u${i}_0`, d, { amountFen: 490 }); // 转化仍然达标
  }
  // 成本抬高到 CAC > LTV/3（第二项不达标）
  for (let i = 0; i < 6; i += 1) {
    await metrics.recordChannelCost({ date: dayKey(addDays(from, i)), channel: 'xhs01', amountFen: 5000, note: 'e2e-expensive' });
  }
  await metrics.aggregateRange({ days: 90 });
  const gate3 = await metrics.acceptanceGate({ days: 90 });
  check('两项不达标：判定明细', gate3.checks.map((c) => c.ok), [false, true, false]);
  check('两项不达标：结论 = 失败', gate3.status, 'failed');

  /* ---------------------------------------------------------------- 场景 4：数据不足不下结论 */
  await wipe();
  const recent = addDays(dayStart(dayKey()), -4);
  for (let i = 0; i < 5; i += 1) await addUser(`m4_u${i}`, recent, null); // 无归因 → direct
  await addEvent(recent, 'profile_complete', 'm4_u0');
  await metrics.aggregateRange({ days: 5 });
  const gate4 = await metrics.acceptanceGate({ days: 90 });
  check('数据不足：结论 = insufficient', gate4.status, 'insufficient');
  checkTruthy('数据不足：给出原因', gate4.reasons.length >= 2);
  checkTruthy('数据不足：原因含"窗口"', gate4.reasons.some((r) => r.includes('窗口')));
  checkTruthy('数据不足：原因含"激活"', gate4.reasons.some((r) => r.includes('激活')));
  checkTruthy('数据不足：原因含"成本"', gate4.reasons.some((r) => r.includes('成本')));
  check('数据不足：不会误判通过', gate4.status !== 'passed', true);

  // 渠道归因：无 acquisition 的记 direct，且 direct 的 CAC 必须是 null（不是 0）
  const chans = await metrics.channelBreakdown({ days: 90 });
  const direct = chans.find((c) => c.channel === 'direct');
  checkTruthy('无归因用户记入 direct', Boolean(direct) && direct.newUsers === 5);
  check('direct 的 CAC 为 null 而非 0', direct ? direct.cacFen : 'x', null);

  await wipe();
  if (!KEEP) {
    await db.dropDatabase();
    console.log('\n🗑  已删除测试库');
  }

  console.log(`\n通过 ${pass} · 失败 ${fail}`);
  if (fail) console.log(`失败项：${failures.join('、')}`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ 验证脚本异常：', err?.stack || err?.message || err);
  process.exit(1);
});
