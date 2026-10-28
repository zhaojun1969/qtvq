/**
 * 支付订单 KV 存储（与 quota-store 共用 QTVQ_KV）
 */

import { PLANS, validClientId } from './quota-store.js';

const ORDER_PREFIX = 'order:';
// 「该客户还有哪些订单没付」的索引。
// 存在的理由：回调可能到不了（公钥没配好/验签失败/外网不可达），那样客户付完钱页面一关就没人再查了。
// 有了这个索引，客户下次打开账户页（GET /api/quota）时就能主动向微信问一次真实状态并自愈开通。
const PENDING_PREFIX = 'pending:';
const PENDING_TTL_SECONDS = 3 * 24 * 3600;
const memoryOrders = new Map();

function getKv(env) {
  return env?.QTVQ_KV || null;
}

/* ---------------------------------------------------------------- 境内化（G1） */

/*
 * 2026-10-26 · 订单数据境内化（方案见 docs/订单数据境内化双写方案.md）
 *
 * KV 由 Cloudflare **全球网络**承载，键可能被复制到境外节点。订单对象里的
 * `openid`、`trace.phone`、`trace.ip`、`trace.userAgent` 属于可识别个人身份的信息，
 * 存于其上即构成《个人信息保护法》意义上的数据出境。
 *
 * 分工（刻意保持读路径不变，把风险面压到最小）：
 *   · **KV**：只放剥离 PII 的投影 —— 支付逻辑真正用到的字段（orderId/clientId/plan/
 *     amount/status/paidAt/uid）一个不少，所以 webhook、轮询、自愈全都不用改；
 *   · **境内 Mongo**：完整记录，运营查询与审计从这里取（`/v1/admin/orders`）。
 *
 * 为什么不做成"Mongo 唯一存储"：那会让单台 ECS 成为收钱路径的单点，
 * 宕机即无法下单。合规改造不能拿支付可用性去换，详见方案 §2。
 */

/**
 * 剥离 PII，得到可以放在境外的投影。
 *
 * 导出是为了让迁移脚本（`tools/scripts/migrate-orders-kv-to-mongo.mjs`）复用**同一份**逻辑：
 * 脚本自己再写一遍剥离规则的话，两边迟早不一致，而"哪份能出境"这件事上不一致是合规事故。
 */
export function projectForKv(order) {
  if (!order || typeof order !== 'object') return order;
  const { openid: _openid, trace, ...rest } = order;
  // trace 只留 uid（非 PII），保留对象形状，避免调用方 `order.trace?.uid` 取不到值
  const safeTrace = trace && typeof trace === 'object' ? { uid: trace.uid ?? null } : null;
  return { ...rest, trace: safeTrace };
}

const NODE_SYNC_TIMEOUT_MS = 3000;

/**
 * 把**完整**订单（含 PII）同步到境内 Node 服务。
 *
 * 永不抛异常、永不阻断主流程：订单成不成立由 KV 写入结果决定。
 *
 * 为什么带一次重试：实测（2026-10-26）首次同步偶发超时（冷连接：DNS + TLS + nginx + Node），
 * 而**下单时的这一次是 PII 唯一一次完整进入境内的机会** —— 之后 `saveOrder` 读到的
 * 都是 KV 里的投影（已无 PII）。漏了不构成合规问题（PII 反而没出境），
 * 但运营就永远看不到这单是谁下的，所以值得重试一次。
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function syncOrderToNode(env, order) {
  const base = String(env?.NODE_API_BASE || '').replace(/\/+$/, '');
  const adminKey = String(env?.NODE_ADMIN_KEY || '');
  if (!base || !adminKey || !order?.orderId) return { ok: false, reason: 'not-configured' };

  let lastReason = 'unknown';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const res = await fetch(`${base}/v1/admin/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': adminKey,
          /* 必须带 UA：本站 nginx 对空 UA 返回 444 静默断连（2026-10-11 入账事故的根因） */
          'User-Agent': 'qtvq-order-ingest/1.0 (+https://qtvq.cn)',
        },
        body: JSON.stringify(order),
        signal: AbortSignal.timeout(NODE_SYNC_TIMEOUT_MS),
      });
      if (res.ok) return { ok: true };
      lastReason = `http-${res.status}`;
      // 4xx 是请求本身的问题（如字段非法），重试没意义
      if (res.status >= 400 && res.status < 500) break;
    } catch (err) {
      lastReason = err?.name === 'TimeoutError' ? 'timeout' : 'network';
    }
  }
  console.error(`[order-store] 境内同步失败 ${order.orderId}: ${lastReason}`);
  return { ok: false, reason: lastReason };
}

function orderKey(orderId) {
  return `${ORDER_PREFIX}${orderId}`;
}

function pendingKey(clientId, orderId) {
  return `${PENDING_PREFIX}${clientId}:${orderId}`;
}

function newOrderId() {
  return `ord_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function yuanToFen(yuan) {
  return Math.round(Number(yuan) * 100);
}

export function getPlan(planId) {
  return PLANS[planId] || null;
}

/**
 * 缘值充值订单（方案 A：在线支付任意金额，自动到账）。
 *
 * 与会员套餐的区别：
 *   - 金额由用户输入（¥1–¥2000），不是固定套餐价；
 *   - 付款成功后**加钱包余额**，而不是"开通会员"（结算分支见 payment-activate.js）；
 *   - 必须带 uid：Node 侧钱包的 `_id` 复用的正是 Cloudflare 体系的 uid（u_xxx），
 *     见 server/src/config/db.js 的注释 —— 所以入账不需要任何映射表。
 */
export const TOPUP_PLAN_ID = 'topup';
export const TOPUP_MIN = 1;
export const TOPUP_MAX = 2000;

export function validateTopupAmount(amountYuan) {
  const n = Number(amountYuan);
  if (!Number.isFinite(n) || n < TOPUP_MIN) return `充值金额至少 ¥${TOPUP_MIN}`;
  if (n > TOPUP_MAX) return `单次充值不得超过 ¥${TOPUP_MAX}`;
  if (Math.round(n * 100) !== Math.round(n * 100 * 100) / 100) return '金额最多两位小数';
  return null;
}

export async function createTopupOrder(env, { clientId, amountYuan, uid, channel, openid = null, trace = null }) {
  if (!validClientId(clientId)) return { error: '无效的 clientId' };
  const bad = validateTopupAmount(amountYuan);
  if (bad) return { error: bad };
  if (!uid) return { error: '请先登录后再充值（需要账号才能入账）' };

  const amount = Math.round(Number(amountYuan) * 100) / 100;
  const orderId = newOrderId();
  const now = Date.now();
  const order = {
    orderId,
    clientId,
    uid: String(uid),
    plan: TOPUP_PLAN_ID,
    planLabel: '缘值充值',
    amount,
    amountFen: Math.round(amount * 100),
    channel: channel || 'wechat_native',
    openid: openid || null,
    trace: trace || null,
    status: 'pending',
    platformTradeNo: null,
    prepayId: null,
    codeUrl: null,
    createdAt: now,
    paidAt: null,
  };

  const kv = getKv(env);
  if (kv) {
    await kv.put(orderKey(orderId), JSON.stringify(projectForKv(order)));
    try {
      await kv.put(pendingKey(clientId, orderId), orderId, { expirationTtl: PENDING_TTL_SECONDS });
    } catch (err) {
      console.error('[order-store] 写待付索引失败：', err);
    }
  } else {
    memoryOrders.set(orderId, order);
  }
  await syncOrderToNode(env, order);
  return { order };
}

export async function createOrder(env, { clientId, planId, channel, openid = null, trace = null }) {
  const plan = getPlan(planId);
  if (!plan || !validClientId(clientId)) return { error: '无效的 clientId 或套餐' };

  const orderId = newOrderId();
  const now = Date.now();
  const order = {
    orderId,
    clientId,
    plan: planId,
    planLabel: plan.label,
    amount: plan.price,
    amountFen: yuanToFen(plan.price),
    channel: channel || 'wechat_native',
    openid: openid || null,
    // 可识别信息（下单时的手机号/IP/浏览器）：运营核对"这是哪个用户"时必需。
    // 以前订单里只有一个 clientId，运营根本无法判断该给谁开通（业务方 2026-09-18 反馈）。
    trace: trace || null,
    status: 'pending',
    platformTradeNo: null,
    prepayId: null,
    codeUrl: null,
    createdAt: now,
    paidAt: null,
  };

  const kv = getKv(env);
  if (kv) {
    await kv.put(orderKey(orderId), JSON.stringify(projectForKv(order)));
    try {
      await kv.put(pendingKey(clientId, orderId), orderId, { expirationTtl: PENDING_TTL_SECONDS });
    } catch (err) {
      // 索引写失败不影响下单本身
      console.error('[order-store] 写待付索引失败：', err);
    }
  } else {
    memoryOrders.set(orderId, order);
  }

  await syncOrderToNode(env, order);
  return { order };
}

export async function getOrder(env, orderId) {
  if (!orderId || typeof orderId !== 'string') return null;
  const kv = getKv(env);
  if (kv) {
    const raw = await kv.get(orderKey(orderId));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return memoryOrders.get(orderId) || null;
}

async function saveOrder(env, order) {
  const kv = getKv(env);
  if (kv) {
    await kv.put(orderKey(order.orderId), JSON.stringify(projectForKv(order)));
  } else {
    memoryOrders.set(order.orderId, order);
  }
  await syncOrderToNode(env, order);
}

export async function updateOrder(env, orderId, patch) {
  const order = await getOrder(env, orderId);
  if (!order) return null;
  Object.assign(order, patch);
  await saveOrder(env, order);
  return order;
}

/** 幂等：已 paid 则直接返回 */
export async function markOrderPaid(env, orderId, { platformTradeNo, paidAt = Date.now() } = {}) {
  const order = await getOrder(env, orderId);
  if (!order) return { error: '订单不存在' };
  if (order.status === 'paid') return { order, alreadyPaid: true };

  order.status = 'paid';
  order.platformTradeNo = platformTradeNo || order.platformTradeNo;
  order.paidAt = paidAt;
  await saveOrder(env, order);
  await removePendingIndex(env, order.clientId, order.orderId);
  return { order, alreadyPaid: false };
}

async function removePendingIndex(env, clientId, orderId) {
  const kv = getKv(env);
  if (!kv || !clientId || !orderId) return;
  try {
    await kv.delete(pendingKey(clientId, orderId));
  } catch (err) {
    console.error('[order-store] 清理待付索引失败：', err);
  }
}

/**
 * 该客户 3 天内还没激活的订单（KV 不可用时返回空，不影响主流程）。
 * @returns {Promise<{items: object[]}>}
 */
export async function listPendingOrders(env, clientId) {
  const kv = getKv(env);
  if (!kv || !validClientId(clientId)) return { items: [] };

  const items = [];
  try {
    const list = await kv.list({ prefix: `${PENDING_PREFIX}${clientId}:` });
    for (const { name } of list.keys) {
      const orderId = await kv.get(name);
      if (!orderId) continue;
      const order = await getOrder(env, orderId);
      if (order && order.status !== 'paid') items.push(order);
      else if (order) await removePendingIndex(env, clientId, orderId);
    }
  } catch (err) {
    console.error('[order-store] 读取待付索引失败：', err);
    return { items: [] };
  }
  return { items };
}

/**
 * 工作人员：最近在线支付订单。
 *
 * 2026-10-26 起**优先读境内 Mongo**：KV 里的订单已剥离 PII，
 * 而运营核对所需要的正是那些字段（业务方 2026-09-18 反馈"基本的微信名和时间 IP 地址都没有，
 * 无法确定是哪个用户"）。KV 退化为兜底：Node 不可用时仍能列出订单骨架（无 PII），
 * 至少不会让运营台整页空白。
 */
export async function listRecentOrders(env, { limit = 50 } = {}) {
  const base = String(env?.NODE_API_BASE || '').replace(/\/+$/, '');
  const adminKey = String(env?.NODE_ADMIN_KEY || '');
  if (base && adminKey) {
    try {
      const res = await fetch(`${base}/v1/admin/orders?limit=${Math.min(200, limit)}`, {
        headers: {
          'X-Admin-Key': adminKey,
          'User-Agent': 'qtvq-order-query/1.0 (+https://qtvq.cn)',
        },
        signal: AbortSignal.timeout(NODE_SYNC_TIMEOUT_MS),
      });
      if (res.ok) {
        const j = await res.json();
        return { items: j?.data?.items || [], storage: 'mongo-cn' };
      }
      console.error('[order-store] 境内订单列表读取失败 HTTP', res.status, '（回退 KV）');
    } catch (err) {
      console.error('[order-store] 境内订单列表读取异常（回退 KV）：', err?.message || err);
    }
  }

  const kv = getKv(env);
  if (!kv) {
    const items = [...memoryOrders.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return { items: items.slice(0, limit), storage: 'memory' };
  }
  const list = await kv.list({ prefix: ORDER_PREFIX });
  const items = [];
  for (const { name } of list.keys) {
    const raw = await kv.get(name);
    if (!raw) continue;
    try {
      items.push(JSON.parse(raw));
    } catch {
      /* skip */
    }
  }
  items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return { items: items.slice(0, limit), storage: 'kv-no-pii' };
}

export { PLANS };
