/**
 * 度量系统（实施书 P4-T4.1 / T4.2）
 *
 * 设计原则 —— 先说清楚"为什么不直接在查询时算完就算数"：
 *
 * 1. **口径必须固化成代码，不能散在 SQL/脚本里**。
 *    「次日留存」这种指标有五种常见算法（按注册日 / 按活跃日 / 是否要求激活 / 是否算跨天回流 / 分母去不去重），
 *    每种都能算出一个"看起来合理"的数。这里把口径写死在一处并写进注释，谁看都是同一个数。
 *
 * 2. **当日指标会被晚到数据改写**。埋点走 `sendBeacon`，用户在 23:59 打开页面、凌晨才批量上报很正常；
 *    所以聚合是**按天全量重算 + upsert**，不是增量累加。重算最近 N 天永远安全。
 *
 * 3. **不知道就说不知道**。`d1Retained` 在 D+1 那天结束前是 `null`，不是 0 ——
 *    把"还没来得及发生"记成 0，看板会显示留存断崖式下跌，然后有人去修一个不存在的 bug。
 *
 * 4. **数据不足时不下结论**。90 天验收门在样本量不够（激活 < 30 或窗口不足 90 天）时返回
 *    `insufficient: true`，绝不因为"留存 100%"（分母 2 个人）就宣布改造成功。
 *
 * 时区：一律使用**服务器本地时区**（ECS 为 Asia/Shanghai）的 00:00 作为自然日边界。
 * 埋点 `ts` 是客户端毫秒时间戳，按同样边界归日。
 */
import { getDB } from '../config/db.js';

const DAILY = 'metrics_daily';
const COSTS = 'metrics_costs';
const AUTH_USERS = 'auth_users';
const ORDERS = 'orders';
const EVENTS_PREFIX = 'events_';

/** 激活口径：完成资料 或 首次提问（与实施书 §P4 一致，二者任一即算激活） */
const ACTIVATION_EVENTS = ['profile_complete', 'question_asked'];

/**
 * 报告类订单的 sku 白名单（T4.1 的「报告下单/支付」只算这些）。
 *
 * `orders` 里还躺着会员/充值单（老数据只有 `plan` 没有 `sku`），
 * 把它们算进「报告下单」会让报告转化漏斗虚高 3 倍。
 */
const REPORT_SKUS = ['diagnose', 'retro', 'pair'];

/**
 * ── 营收口径（唯一真相 = `orders` 集合）────────────────────────────────────
 *
 * 客户端还会上报 `report_paid` / `membership_purchase` 两个事件，它们
 * **只表示"客户端看到一次付费成功"**，用于支付/转化漏斗与端到端排障。
 *
 * 本文件里所有钱与付费人数（`revenueFen` / `reportRevenueFen` / `reportPaid` /
 * `paidUsers` / `zeroPaid`）**一律从 `orders` 聚合**，从不读这两个事件 ——
 * 一旦两边都算，同一笔钱会在"事件侧"和"订单侧"各计一次，账实不符且无处可查。
 *
 * 下面的检查器把这条约束机器化：`tools/scripts/check-activation-wiring.mjs`
 * 会拒绝 `metrics.js` 里出现 `e.event === 'report_paid'` 这类写法。
 * 事件与订单的对照关系只能是"同一笔、两个视角"，不能是"两笔、各算一次"。
 */

/** 验收门门槛（实施书 §T4.2） */
export const GATE = {
  d1Retention: 0.25, // 次日留存 ≥ 25%
  conversion: 0.03, // 免费 → 付费转化 ≥ 3%
  cacLtvDivisor: 3, // CAC < LTV ÷ 3
  minActivated: 30, // 样本量下限：激活用户少于此数不下结论
  windowDays: 90,
};

const pad = (n) => String(n).padStart(2, '0');

/** 本地时区的 YYYY-MM-DD */
export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** YYYY-MM-DD → 本地时区当天 00:00 */
export function dayStart(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function addDays(date, n) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + n);
  return d;
}

/**
 * 事件分表的月份名 —— **必须和 `routes/track.js::monthCollection` 同一套时区**。
 * 这里用服务器本地时区（ECS 是 Asia/Shanghai），写入侧也必须是本地；否则每月 1 号
 * 00:00–08:00 的事件会被写进上个月的集合，而聚合按本地月去取，整段丢失且无报错。
 */
function monthColl(date) {
  return `${EVENTS_PREFIX}${date.getFullYear()}${pad(date.getMonth() + 1)}`;
}

/**
 * 时间区间过滤 —— 同时兼容「数字毫秒」与「Date」两种存储。
 *
 * 为什么不能只写一种：线上 `orders.createdAt/paidAt` 现在就是混着的（老脚本写毫秒数，
 * 新代码写 `new Date()`），而 MongoDB 的 `$gte/$lt` 是**跨 BSON 类型按类型序**比较的
 * （数字 < 日期）。于是 `{paidAt: {$gte: someDate}}` 匹配不到任何毫秒数行，
 * `{ts: {$gte: 1792...}}` 又匹配不到任何 Date 行 —— 两种写法都会静默漏数据，
 * 看板上表现为「某一项永远是 0」，不报错、不告警。
 * 实测：库里有 3 条 `landing_view`（ts 是 Date），聚合出来 `landingViews: 0`。
 *
 * 所以区间查询一律走这里：两种类型各给一段区间，用 `$or` 合起来，谁也别漏。
 * 代价是可能扫两段索引区间，相对「看板数字错」完全可以接受。
 */
function tsRange(field, start, end) {
  const lo = start instanceof Date ? start : new Date(start);
  const hi = end instanceof Date ? end : new Date(end);
  return {
    $or: [{ [field]: { $gte: lo, $lt: hi } }, { [field]: { $gte: lo.getTime(), $lt: hi.getTime() } }],
  };
}

/**
 * 取 [start, end) 区间的事件。
 *
 * 跨月的两天（比如 12-31 到 01-01）必须查两张表 —— 只查 start 所在月，
 * 次月 1 号的留存会被算成 0，而且这个 0 会一直躺在历史里。
 */
async function eventsBetween(start, end) {
  const db = getDB();
  const names = [...new Set([monthColl(start), monthColl(new Date(end.getTime() - 1))])].sort();
  const out = [];
  for (const name of names) {
    const exists = await db.listCollections({ name }, { nameOnly: true }).toArray();
    if (!exists.length) continue;
    const rows = await db
      .collection(name)
      .find(tsRange('ts', start, end))
      .project({ _id: 0, event: 1, uid: 1, ch: 1, ts: 1 })
      .toArray();
    out.push(...rows);
  }
  return out;
}

export async function ensureMetricsIndexes() {
  const db = getDB();
  await db.collection(DAILY).createIndex({ date: 1 }, { unique: true });
  await db.collection(COSTS).createIndex({ channel: 1, date: 1 });
  await db.collection(COSTS).createIndex({ date: -1 });
}

/**
 * 聚合某一天。
 *
 * 返回的对象同时写进 `metrics_daily`：
 *  - newUsers      当日新注册（auth_users.createdAt 落在当天，权威口径）
 *  - activated     当日产生激活行为的 uid 数（去重）
 *  - d1Eligible    D+1 已经过完的当日注册数（"能被判定"的样本）
 *  - d1Retained    d1Eligible 里次日仍有任意行为的 uid 数；D+1 没结束则为 null
 *  - reportViews   报告页浏览（事件 report_landing_view）
 *  - reportOrders  当日新建**报告**订单数（只算 sku ∈ diagnose/retro/pair）
 *  - reportPaid    当日完成支付的**报告**订单数（paidAt 落在当天）
 *  - reportRevenueFen  报告单实收（分）
 *  - paidUsers     当日付费的 uid 数（去重，转化率用这个）—— **含会员/充值单**，
 *                  验收门的「免费→付费转化」口径是"至少有一笔已支付订单"，不限商品
 *  - zeroPaid      当日 0 元成交（券全额抵扣）单数，单独记 —— 它不是真实营收
 *  - revenueFen    当日实收（分，全部商品，不含 0 元单）；与 `channelBreakdown` 的 LTV 同口径
 *  - shareGenerated / shareLanding   分享卡生成 / 回流
 *  - landingViews  内容落地页曝光
 */
export async function aggregateDay(key) {
  const db = getDB();
  const start = dayStart(key);
  const end = addDays(start, 1);

  const [newUsers, dayEvents, nextEvents, ordersCreated, reportPaidOrders, allPaid] = await Promise.all([
    db.collection(AUTH_USERS).countDocuments(tsRange('createdAt', start, end)),
    eventsBetween(start, end),
    eventsBetween(end, addDays(end, 1)),
    db.collection(ORDERS).countDocuments({ sku: { $in: REPORT_SKUS }, ...tsRange('createdAt', start, end) }),
    db
      .collection(ORDERS)
      .find({ sku: { $in: REPORT_SKUS }, ...tsRange('paidAt', start, end) })
      .project({ _id: 0, uid: 1, amountFen: 1 })
      .toArray(),
    // 实收/付费用户走全商品口径；membership 单没有 sku，不能拿 sku 过滤
    db
      .collection(ORDERS)
      .find({ status: { $in: ['paid', 'consumed'] }, ...tsRange('paidAt', start, end) })
      .project({ _id: 0, uid: 1, amountFen: 1 })
      .toArray(),
  ]);

  const activatedUids = new Set();
  const shareGenerated = new Set();
  let reportViews = 0;
  let shareLanding = 0;
  let landingViews = 0;
  for (const e of dayEvents) {
    if (ACTIVATION_EVENTS.includes(e.event) && e.uid) activatedUids.add(e.uid);
    if (e.event === 'report_landing_view') reportViews += 1;
    if (e.event === 'share_card_landing') shareLanding += 1;
    if (e.event === 'landing_view') landingViews += 1;
    if (e.event === 'share_card_save') shareGenerated.add(e.uid || e.anonId || `anon:${shareGenerated.size}`);
  }

  // 次日留存：分子要"次日有任何行为"，所以需要 D+1 的事件，而 D+1 只有在 end <= now 时才完整
  const registeredUids = await db
    .collection(AUTH_USERS)
    .find(tsRange('createdAt', start, end))
    .project({ _id: 0, userId: 1 })
    .toArray();
  const nextActive = new Set(nextEvents.map((e) => e.uid).filter(Boolean));
  const d1Knowable = addDays(end, 1) <= new Date();
  const d1Eligible = registeredUids.length;
  const d1Retained = d1Knowable ? registeredUids.filter((u) => nextActive.has(u.userId)).length : null;

  const paidUids = new Set();
  let revenueFen = 0;
  let zeroPaid = 0;
  for (const o of allPaid) {
    if (o.uid) paidUids.add(o.uid);
    const amount = Number(o.amountFen || 0);
    if (amount > 0) revenueFen += amount;
    else zeroPaid += 1;
  }
  const reportRevenueFen = reportPaidOrders.reduce((a, o) => a + Number(o.amountFen || 0), 0);

  const row = {
    date: key,
    newUsers,
    activated: activatedUids.size,
    d1Eligible,
    d1Retained,
    d1Rate: d1Retained == null || !d1Eligible ? null : d1Retained / d1Eligible,
    reportViews,
    reportOrders: ordersCreated,
    reportPaid: reportPaidOrders.length,
    reportRevenueFen,
    paidUsers: paidUids.size,
    zeroPaid,
    revenueFen,
    shareGenerated: shareGenerated.size,
    shareLanding,
    landingViews,
    updatedAt: new Date(),
  };

  await db.collection(DAILY).updateOne({ date: key }, { $set: row }, { upsert: true });
  return row;
}

/** 重算 [from, to]（含端点）。默认最近 days 天（含今天）。 */
export async function aggregateRange({ days = 7, from = null, to = null } = {}) {
  await ensureMetricsIndexes();
  const toDate = to ? dayStart(to) : dayStart(dayKey());
  const fromDate = from ? dayStart(from) : addDays(toDate, -(days - 1));
  const rows = [];
  for (let d = new Date(fromDate.getTime()); d <= toDate; d = addDays(d, 1)) {
    rows.push(await aggregateDay(dayKey(d)));
  }
  return rows;
}

export async function listDaily({ days = 30 } = {}) {
  const db = getDB();
  const from = dayKey(addDays(dayStart(dayKey()), -(days - 1)));
  return db.collection(DAILY).find({ date: { $gte: from } }).sort({ date: 1 }).project({ _id: 0 }).toArray();
}

/**
 * 区间汇总（看板顶部卡片用）。
 *
 * 注意留存是"分子求和 ÷ 分母求和"，不是"日均留存率的平均" ——
 * 后者会被低样本的日子拉偏（某天 2 个人里留 1 个 = 50%，不该与 200 人里留 60 个等价）。
 */
export function summarize(rows) {
  const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const known = rows.filter((r) => r.d1Retained != null && r.d1Eligible > 0);
  const d1Num = known.reduce((a, r) => a + Number(r.d1Retained || 0), 0);
  const d1Den = known.reduce((a, r) => a + Number(r.d1Eligible || 0), 0);
  return {
    days: rows.length,
    newUsers: sum('newUsers'),
    activated: sum('activated'),
    d1Retained: d1Num,
    d1Eligible: d1Den,
    d1Rate: d1Den ? d1Num / d1Den : null,
    reportViews: sum('reportViews'),
    reportOrders: sum('reportOrders'),
    reportPaid: sum('reportPaid'),
    reportRevenueFen: sum('reportRevenueFen'),
    zeroPaid: sum('zeroPaid'),
    revenueFen: sum('revenueFen'),
    shareGenerated: sum('shareGenerated'),
    shareLanding: sum('shareLanding'),
    landingViews: sum('landingViews'),
  };
}

/* ------------------------------------------------------------------ 渠道成本 */

/** 记一笔渠道成本（投放/激励）。CAC 的分子只能靠人填，代码猜不出来。 */
export async function recordChannelCost({ date, channel, amountFen, note = null }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw Object.assign(new Error('日期格式应为 YYYY-MM-DD'), { code: 'E_BAD_DATE' });
  if (!channel) throw Object.assign(new Error('缺少渠道码'), { code: 'E_BAD_CHANNEL' });
  const amount = Math.round(Number(amountFen));
  if (!Number.isFinite(amount) || amount < 0) throw Object.assign(new Error('金额（分）非法'), { code: 'E_BAD_AMOUNT' });
  await getDB().collection(COSTS).insertOne({ date: String(date), channel: String(channel), amountFen: amount, note, createdAt: new Date() });
  return { date, channel, amountFen: amount };
}

export async function listChannelCosts({ days = 90 } = {}) {
  const from = dayKey(addDays(dayStart(dayKey()), -(days - 1)));
  return getDB().collection(COSTS).find({ date: { $gte: from } }).sort({ date: -1 }).project({ _id: 0 }).toArray();
}

/* ------------------------------------------------------------------ 渠道与验收 */

/**
 * 分渠道归因 + 营收（CAC / LTV 的原料）。
 *
 * 渠道来自 `auth_users.acquisition.channel`；没有归因的算 `direct`（自然流量），
 * 它没有投放成本，CAC 天然为 0 —— 但也不能拿它去平均那些花了钱的渠道。
 */
export async function channelBreakdown({ days = GATE.windowDays } = {}) {
  const db = getDB();
  const from = addDays(dayStart(dayKey()), -(days - 1));
  const users = await db
    .collection(AUTH_USERS)
    .find(tsRange('createdAt', from, addDays(dayStart(dayKey()), 1)))
    .project({ _id: 0, userId: 1, acquisition: 1 })
    .toArray();

  const channelOf = new Map();
  for (const u of users) channelOf.set(u.userId, u.acquisition?.channel || 'direct');

  const uids = users.map((u) => u.userId);
  const paidByUid = new Map();
  if (uids.length) {
    const paid = await db
      .collection(ORDERS)
      .find({ uid: { $in: uids }, status: { $in: ['paid', 'consumed'] } })
      .project({ _id: 0, uid: 1, amountFen: 1 })
      .toArray();
    for (const o of paid) paidByUid.set(o.uid, (paidByUid.get(o.uid) || 0) + Number(o.amountFen || 0));
  }

  const costs = await listChannelCosts({ days });
  const costByChannel = new Map();
  for (const c of costs) costByChannel.set(c.channel, (costByChannel.get(c.channel) || 0) + Number(c.amountFen || 0));

  const byChannel = new Map();
  for (const u of users) {
    const ch = channelOf.get(u.userId);
    const row = byChannel.get(ch) || { channel: ch, newUsers: 0, paidUsers: 0, revenueFen: 0, costFen: 0 };
    row.newUsers += 1;
    const paid = paidByUid.get(u.userId) || 0;
    if (paid > 0) {
      row.paidUsers += 1;
      row.revenueFen += paid;
    }
    byChannel.set(ch, row);
  }
  for (const [ch, cost] of costByChannel) {
    const row = byChannel.get(ch) || { channel: ch, newUsers: 0, paidUsers: 0, revenueFen: 0, costFen: 0 };
    row.costFen = cost;
    byChannel.set(ch, row);
  }

  const rows = [...byChannel.values()]
    .map((r) => ({
      ...r,
      conversion: r.newUsers ? r.paidUsers / r.newUsers : null,
      // CAC 只对"花了钱的渠道"有意义；成本为 0 时是 null，不是 0 —— 0 会被误读成"获客免费"
      cacFen: r.costFen > 0 && r.newUsers > 0 ? Math.round(r.costFen / r.newUsers) : null,
      ltvFen: r.newUsers > 0 ? Math.round(r.revenueFen / r.newUsers) : null,
    }))
    .sort((a, b) => b.newUsers - a.newUsers);
  return rows;
}

/**
 * 90 天验收门（实施书 §T4.2）。
 *
 * 三项判据：①②必看，③只在有成本数据时才有意义。
 * 「任意两项不达标即失败」——所以这里同时返回每项判定与总判定，
 * 让看板能显示"哪一项把它拖垮了"，而不是只给一个红绿灯。
 *
 * 返回 status：
 *   passed       三项里不达标 ≤ 1
 *   failed       不达标 ≥ 2（唯一能宣布"改造失败"的状态）
 *   insufficient 窗口不足 90 天 / 激活 < 30 / 没有成本数据 —— 一律不下结论
 */
export async function acceptanceGate({ days = GATE.windowDays, now = new Date() } = {}) {
  const db = getDB();
  const from = addDays(dayStart(dayKey(now)), -(days - 1));
  const rows = await db.collection(DAILY).find({ date: { $gte: dayKey(from) } }).project({ _id: 0 }).toArray();
  const summary = summarize(rows.sort((a, b) => (a.date < b.date ? -1 : 1)));

  const windowStart = await db.collection(DAILY).find({}).sort({ date: 1 }).limit(1).project({ _id: 0, date: 1 }).toArray();
  const firstDate = windowStart[0]?.date || null;

  /*
   * 「覆盖天数」只算**当天有任何信号**的日子，不是 metrics_daily 的行数。
   *
   * 起因（2026-10-29）：有人为了"让看板有数"补算了 90 天，于是 90 行全零的空壳
   * 让覆盖度从 6 天跳到 90 天，验收门立刻从"窗口不足"变成"可以下结论"——
   * 而实际上线后才 6 天有真实流量。空壳行是补算出来的，不是观测出来的。
   * 所以这里按"有没有真实信号"来数，补算的零行不算观测天数。
   */
  const SIGNAL_KEYS = ['newUsers', 'activated', 'reportViews', 'landingViews', 'reportOrders', 'reportPaid', 'shareGenerated', 'shareLanding'];
  const hasSignal = (r) => SIGNAL_KEYS.some((k) => Number(r[k]) > 0);
  const coverage = rows.filter(hasSignal).length;
  const windowRows = rows.length;
  const enoughWindow = coverage >= GATE.windowDays;

  /*
   * 转化：窗口内激活过、且至少有一笔真实付费的 uid ÷ 激活 uid
   *
   * 事件按**月**分表，90 天窗口会横跨 3～4 个月。第一版只查了 `monthColl(from)`
   * 和 `monthColl(now)` 两**头**的月份，中间月份整段漏掉：窗口 07-31～10-28 时
   * 8、9 月的激活全部消失，分母从 90 掉到 29，转化率被放大 3 倍 ——
   * 而看板里这一项正是"要不要继续投"的判据，错得毫无声响。
   * 所以必须从 from 所在月逐月推到 now。
   */
  const activatedSet = new Set();
  const months = new Set();
  for (let m = new Date(from.getFullYear(), from.getMonth(), 1); m <= now; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
    months.add(monthColl(m));
  }
  for (const name of months) {
    const exists = await db.listCollections({ name }, { nameOnly: true }).toArray();
    if (!exists.length) continue;
    const hits = await db
      .collection(name)
      .find({ event: { $in: ACTIVATION_EVENTS }, uid: { $ne: null }, ...tsRange('ts', from, addDays(dayStart(dayKey(now)), 1)) })
      .project({ _id: 0, uid: 1 })
      .toArray();
    for (const h of hits) activatedSet.add(h.uid);
  }
  const orderedUids = new Set(
    (
      await db
        .collection(ORDERS)
        .find({ status: { $in: ['paid', 'consumed'] }, amountFen: { $gt: 0 }, ...tsRange('paidAt', from, addDays(dayStart(dayKey(now)), 1)) })
        .project({ _id: 0, uid: 1 })
        .toArray()
    ).map((o) => o.uid),
  );
  const activated = activatedSet.size;
  const converted = [...activatedSet].filter((u) => orderedUids.has(u)).length;
  const conversion = activated ? converted / activated : null;

  // 获客效率：全渠道均值 —— 总成本 ÷ 总归因新增，对比 总营收 ÷ 归因新增 ÷ 3
  const channels = await channelBreakdown({ days });
  const attributed = channels.filter((c) => c.channel !== 'direct');
  const attributedUsers = attributed.reduce((a, c) => a + c.newUsers, 0);
  const attributedCost = attributed.reduce((a, c) => a + c.costFen, 0);
  const attributedRevenue = attributed.reduce((a, c) => a + c.revenueFen, 0);
  const cacFen = attributedUsers > 0 && attributedCost > 0 ? Math.round(attributedCost / attributedUsers) : null;
  const ltvFen = attributedUsers > 0 ? Math.round(attributedRevenue / attributedUsers) : null;
  const efficiencyOk = cacFen != null && ltvFen != null && cacFen < ltvFen / GATE.cacLtvDivisor;

  const checks = [
    {
      key: 'd1Retention',
      label: '次日留存',
      value: summary.d1Rate,
      threshold: GATE.d1Retention,
      detail: `${summary.d1Retained}/${summary.d1Eligible}（${coverage} 天）`,
      ok: summary.d1Rate == null ? null : summary.d1Rate >= GATE.d1Retention,
    },
    {
      key: 'conversion',
      label: '免费→付费转化',
      value: conversion,
      threshold: GATE.conversion,
      detail: `${converted}/${activated} 激活用户至少付过一单`,
      ok: conversion == null ? null : conversion >= GATE.conversion,
    },
    {
      key: 'efficiency',
      label: '获客效率 CAC < LTV/3',
      value: cacFen != null && ltvFen != null ? cacFen / Math.max(ltvFen, 1) : null,
      threshold: 1 / GATE.cacLtvDivisor,
      detail: cacFen == null ? '未录入渠道成本' : `CAC ¥${(cacFen / 100).toFixed(2)} · LTV ¥${(ltvFen / 100).toFixed(2)}`,
      ok: cacFen == null ? null : efficiencyOk,
    },
  ];

  const judged = checks.filter((c) => c.ok !== null);
  const failed = judged.filter((c) => c.ok === false).length;
  let status = 'insufficient';
  const reasons = [];
  if (!enoughWindow) reasons.push(`度量窗口仅 ${coverage}/${GATE.windowDays} 天有真实数据（补算的零值日不算）`);
  if (activated < GATE.minActivated) reasons.push(`激活用户仅 ${activated} 人（需 ≥ ${GATE.minActivated}）`);
  if (cacFen == null) reasons.push('未录入渠道成本，无法计算 CAC');
  if (!reasons.length) status = failed >= 2 ? 'failed' : 'passed';

  return {
    status,
    reasons,
    checks,
    summary,
    coverage,
    windowRows,
    firstDate,
    activated,
    converted,
    sampleOk: activated >= GATE.minActivated && enoughWindow,
    generatedAt: new Date(),
  };
}
