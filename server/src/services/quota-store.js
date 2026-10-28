/**
 * 客户端额度与会员状态 —— **境内 Mongo 版**（2026-10-26）
 *
 * ── 为什么要有这一份 ───────────────────────────────────────────────────────
 * 原实现（`functions/lib/quota-store.js`）把额度热数据放在 **Cloudflare KV**：
 * `client:<id>` → `{ timestamps, subscription }`。
 * 那是为了"境内数据不出境"做的折中（KV 只留非 PII 的两项，明细在境内 Mongo）。
 *
 * 但它带来一个更贵的问题：**额度判定只存在于境外**。
 * 于是 `/api/quota` 和 `/api/chat` 都必须跑在 Cloudflare，每次调用都要跨境：
 * 实测客户端 P50 641ms / P95 6.7s（最坏 30.6s），而同一台机器上的 `/v1/*` 是 15ms。
 *
 * 本轮把这两项搬回境内 Mongo，Node 成为**唯一写入方**：
 *   · 集合 `client_quota`，`_id` 直接用 clientId 字符串 → 单文档原子更新，不需要事务；
 *   · 订阅状态也在这里（`subscription`），付费开通必须写这里才算数；
 *   · 明细仍读 `client_billing`（Node 早已是它的 owner，不必再跨境调用自己）。
 *
 * ── 迁移注意 ───────────────────────────────────────────────────────────────
 * 付费会员的 `subscription.activeUntil` 必须完整搬过来。
 * 迁移脚本见 `tools/scripts/migrate-kv-quota.mjs`：读 KV → 写本集合。
 * **不能"重置"**：重置会让付费用户凭空失效。
 */

import { getDB } from '../config/db.js';

const COLLECTION = 'client_quota';
const DAILY_ASK_LIMIT = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;

export const PLANS = {
  month: { label: '月卡', price: 29, days: 30 },
  quarter: { label: '季卡', price: 79, days: 90 },
  year: { label: '年卡', price: 299, days: 365 },
};

export function validClientId(clientId) {
  return typeof clientId === 'string' && clientId.length > 0 && clientId.length <= 64;
}

function col() {
  return getDB().collection(COLLECTION);
}

function prune(timestamps, now) {
  const cutoff = now - WINDOW_MS;
  return (timestamps || []).filter((t) => Number.isFinite(t) && t > cutoff);
}

/** 读额度记录；不存在时返回空记录（不写库，避免只读请求产生写放大） */
export async function loadRecord(clientId) {
  if (!validClientId(clientId)) return null;
  const doc = await col().findOne({ _id: clientId });
  return {
    timestamps: Array.isArray(doc?.timestamps) ? doc.timestamps : [],
    subscription: doc?.subscription || null,
  };
}

/** 写额度记录（单文档 upsert，天然原子） */
export async function saveRecord(clientId, rec) {
  if (!validClientId(clientId)) return false;
  const now = Date.now();
  await col().updateOne(
    { _id: clientId },
    {
      $set: {
        timestamps: prune(rec?.timestamps, now),
        subscription: rec?.subscription || null,
        updatedAt: now,
      },
    },
    { upsert: true },
  );
  return true;
}

function buildQuota(rec, billing, now = Date.now()) {
  const timestamps = prune(rec?.timestamps, now);
  const unlimited = Number(rec?.subscription?.activeUntil || 0) > now;
  const used = timestamps.length;
  const oldest = timestamps.length ? Math.min(...timestamps) : null;
  return {
    unlimited,
    used,
    remaining: unlimited ? null : Math.max(0, DAILY_ASK_LIMIT - used),
    limit: DAILY_ASK_LIMIT,
    resetAt: oldest ? oldest + WINDOW_MS : null,
    subscription: rec?.subscription || null,
    paymentPending: billing?.paymentPending || null,
    topupPending: billing?.topupPending || null,
    paymentHistory: Array.isArray(billing?.paymentHistory) ? billing.paymentHistory.slice(0, 20) : [],
    plans: PLANS,
    storage: 'mongo-cn',
  };
}

/** 读境内付款明细（Node 自己就是 owner，直接查集合，不再自我 HTTP 调用） */
async function loadBilling(clientId) {
  if (!validClientId(clientId)) return null;
  // client_billing 用的是 ObjectId 主键 + 独立 clientId 字段（历史原因）
  const doc = await getDB().collection('client_billing').findOne({ clientId });
  return doc || null;
}

/**
 * @param {string} clientId
 * @param {{withBilling?: boolean}} opts 热路径（每次提问）用 `withBilling: false`，少一次查询
 */
export async function getQuota(clientId, { withBilling = true } = {}) {
  if (!validClientId(clientId)) return null;
  const rec = await loadRecord(clientId);
  const billing = withBilling ? await loadBilling(clientId) : null;
  return buildQuota(rec, billing);
}

/** 额度判定：`followUp`（追问）不计次，与 Pages 版语义一致 */
export async function canAsk(clientId, followUp) {
  if (followUp) return { ok: true };
  const q = await getQuota(clientId, { withBilling: false });
  if (!q) return { ok: false, error: '无效的客户端标识' };
  if (q.unlimited || q.remaining > 0) return { ok: true };
  return { ok: false, code: 'QUOTA_EXCEEDED', quota: q };
}

/**
 * 记录一次提问。
 *
 * 用 `$push` + `$pull` 两步而不是读-改-写：并发下读-改-写会把同时发生的两次提问
 * 合并成一次（少计），而少计等于白送额度。这里先 push 再按窗口剪切，
 * 两次操作都是单文档原子，最多多留一条过期时间戳（会被下次 prune 掉）。
 */
export async function recordAsk(clientId) {
  if (!validClientId(clientId)) return false;
  const now = Date.now();
  await col().updateOne(
    { _id: clientId },
    { $push: { timestamps: now }, $set: { updatedAt: now } },
    { upsert: true },
  );
  await col().updateOne(
    { _id: clientId },
    { $pull: { timestamps: { $lte: now - WINDOW_MS } } },
  );
  return true;
}

/**
 * 开通会员（付款核实后调用）。
 *
 * 与 Pages 版语义一致：在原到期时间与当前时间中取较晚者再加天数 ——
 * 否则"续费"会从当前时间重算，用户已付的剩余天数被吞掉。
 */
export async function activatePayment(clientId, planId) {
  const plan = PLANS[planId];
  if (!plan || !validClientId(clientId)) return false;

  const rec = await loadRecord(clientId);
  const base = Math.max(Date.now(), Number(rec?.subscription?.activeUntil || 0));
  const subscription = {
    plan: planId,
    label: plan.label,
    activeUntil: base + plan.days * 24 * 60 * 60 * 1000,
    activatedAt: Date.now(),
  };
  await saveRecord(clientId, { ...rec, subscription });

  // 付款待核实 → 历史。写失败不回滚会员（已经开通），但要报错让运营知道要手工清理。
  try {
    const billing = await loadBilling(clientId);
    if (billing?.paymentPending) {
      const history = [
        { ...billing.paymentPending, status: 'active', activatedAt: Date.now() },
        ...(Array.isArray(billing.paymentHistory) ? billing.paymentHistory : []),
      ].slice(0, 20);
      await getDB()
        .collection('client_billing')
        .updateOne({ clientId }, { $set: { paymentHistory: history, paymentPending: null, updatedAt: Date.now() } });
    }
  } catch (err) {
    console.error('[quota] 会员已开通但付款明细未同步：', clientId, err?.message || err);
    return false;
  }
  return true;
}

/** 注销账号时清除额度记录（付款明细由 admin 侧脱敏保留，不在这里删） */
export async function clearClientRecord(clientId) {
  if (!validClientId(clientId)) return false;
  await col().deleteOne({ _id: clientId });
  return true;
}

export { DAILY_ASK_LIMIT };
