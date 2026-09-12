/**
 * 钱包与账本
 *
 * 钱的部分只有两条硬要求：**不漏扣、不重复扣**。这里的做法：
 *
 * 1. **原子扣款**：`findOneAndUpdate({_id, balance: {$gte: cost}}, {$inc: {balance: -cost}})`
 *    —— 单文档更新在 MongoDB 里天然原子，**不需要副本集、不需要多文档事务**。
 *    这点很关键：计划书用的是 Redis 锁 + `$inc` 两步，分布式锁还释放不原子；
 *    而单节点 MongoDB 根本跑不了多文档事务，所以只能靠这个写法。
 *
 * 2. **幂等靠唯一索引，不靠应用层判断**：先用 `idempotencyKey` 在 `wallet_ledger`
 *    里占位，重复请求会撞唯一索引。这样并发双击、网络重试都只会扣一次。
 *
 * 3. **扣款与干活分离**：先扣款 → 再生成报告 → 失败则 `refund()` 退回并留痕。
 *    绝不出现「报告没生成但钱扣了」的静默状态。
 */

import { getDB } from '../config/db.js';
import { env } from '../config/env.js';
import { TIERS, isValidTier } from '../constants.js';
import { ApiError, badRequest } from '../lib/http.js';

const WALLET_COL = 'wallet';
const LEDGER_COL = 'wallet_ledger';
const CN_OFFSET_MS = 8 * 3600 * 1000;

/** mongodb 驱动 v6 默认直接返回文档；为兼容旧行为做一次解包 */
function unwrap(res) {
  if (res && typeof res === 'object' && 'value' in res && res.value !== undefined) return res.value;
  return res;
}

function isDuplicateKey(err) {
  return err?.code === 11000 || /duplicate key/i.test(String(err?.message || ''));
}

/** 北京时间当天 0 点（会员「每日免费」按中国时区算，不能用服务器本地时区） */
export function startOfDayCN(now = new Date()) {
  const cn = new Date(now.getTime() + CN_OFFSET_MS);
  cn.setUTCHours(0, 0, 0, 0);
  return new Date(cn.getTime() - CN_OFFSET_MS);
}

function toYuan(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export async function ensureWallet(uid) {
  const db = getDB();
  const now = new Date();
  return unwrap(
    await db.collection(WALLET_COL).findOneAndUpdate(
      { _id: String(uid) },
      {
        $setOnInsert: {
          balance: env.welcomeBalance,
          totalIn: env.welcomeBalance,
          totalOut: 0,
          createdAt: now,
        },
        $set: { updatedAt: now },
      },
      { upsert: true, returnDocument: 'after' },
    ),
  );
}

export async function getWallet(uid) {
  const w = await ensureWallet(uid);
  return {
    uid: String(uid),
    balance: toYuan(w?.balance),
    totalIn: toYuan(w?.totalIn),
    totalOut: toYuan(w?.totalOut),
    welcome: env.welcomeBalance,
    updatedAt: w?.updatedAt || null,
  };
}

export async function getBalance(uid) {
  const w = await ensureWallet(uid);
  return toYuan(w?.balance);
}

/** 记一笔「不花钱」的消耗（免费档位 / 会员每日免费），用于审计与每日次数统计 */
async function recordFree(uid, { reason, ref, idempotencyKey, meta, balance }) {
  const db = getDB();
  const doc = {
    uid,
    direction: 'none',
    amount: 0,
    reason,
    ref: ref || null,
    meta: meta || null,
    status: 'done',
    balanceAfter: balance,
    createdAt: new Date(),
  };
  if (idempotencyKey) {
    await db.collection(LEDGER_COL).updateOne(
      { idempotencyKey },
      { $set: { ...doc, idempotencyKey } },
      { upsert: true },
    );
  } else {
    await db.collection(LEDGER_COL).insertOne(doc);
  }
}

/**
 * 扣款（amount 为 0 时只记账不扣钱）
 * @returns {Promise<{replayed:boolean, charged:number, balance:number, entry?:object}>}
 */
export async function spend(uid, amount, { reason, ref = null, idempotencyKey = null, meta = null } = {}) {
  const db = getDB();
  const cost = toYuan(amount);
  await ensureWallet(uid);

  // ---- 幂等闸门 ----
  if (idempotencyKey) {
    const existed = await db.collection(LEDGER_COL).findOne({ idempotencyKey });
    if (existed) return replay(db, uid, existed);

    try {
      await db.collection(LEDGER_COL).insertOne({
        uid,
        direction: cost > 0 ? 'out' : 'none',
        amount: cost,
        reason,
        ref,
        meta: meta || null,
        idempotencyKey,
        status: 'pending',
        balanceAfter: null,
        createdAt: new Date(),
      });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      const doc = await db.collection(LEDGER_COL).findOne({ idempotencyKey });
      return replay(db, uid, doc);
    }
  }

  // ---- 不花钱的路径 ----
  if (cost <= 0) {
    const balance = await getBalance(uid);
    await recordFree(uid, { reason, ref, idempotencyKey, meta, balance });
    return { replayed: false, charged: 0, balance };
  }

  // ---- 原子条件扣款 ----
  const updated = unwrap(
    await db.collection(WALLET_COL).findOneAndUpdate(
      { _id: String(uid), balance: { $gte: cost } },
      { $inc: { balance: -cost, totalOut: cost }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' },
    ),
  );

  if (!updated) {
    const balance = await getBalance(uid);
    if (idempotencyKey) {
      await db
        .collection(LEDGER_COL)
        .updateOne({ idempotencyKey }, { $set: { status: 'failed', failReason: 'INSUFFICIENT_BALANCE', balanceAfter: balance } });
    }
    throw new ApiError(
      402,
      `余额不足：本次需要 ¥${cost.toFixed(2)}，当前余额 ¥${balance.toFixed(2)}`,
      'E_INSUFFICIENT_BALANCE',
    );
  }

  const balance = toYuan(updated.balance);
  if (idempotencyKey) {
    await db.collection(LEDGER_COL).updateOne({ idempotencyKey }, { $set: { status: 'done', balanceAfter: balance } });
  } else {
    await db.collection(LEDGER_COL).insertOne({
      uid,
      direction: 'out',
      amount: cost,
      reason,
      ref,
      meta: meta || null,
      status: 'done',
      balanceAfter: balance,
      createdAt: new Date(),
    });
  }
  return { replayed: false, charged: cost, balance };
}

function replay(db, uid, entry) {
  if (!entry) return { replayed: true, charged: 0, balance: 0 };
  if (entry.status === 'pending') {
    throw new ApiError(409, '上一次同样的请求还在处理中，请勿重复提交', 'E_DUPLICATE_IN_FLIGHT');
  }
  return {
    replayed: true,
    charged: 0,
    balance: entry.balanceAfter,
    entry,
    failed: entry.status === 'failed',
    failReason: entry.failReason || null,
  };
}

/** 退回（报告生成失败时调用）。用 `refund:{ref}` 作为幂等键，重复调用不会多退 */
export async function refund(uid, amount, { reason = 'refund', ref = null, meta = null } = {}) {
  const db = getDB();
  const back = toYuan(amount);
  if (back <= 0) return { refunded: 0, balance: await getBalance(uid) };

  const idempotencyKey = ref ? `refund:${ref}` : null;
  if (idempotencyKey) {
    const existed = await db.collection(LEDGER_COL).findOne({ idempotencyKey });
    if (existed) return { refunded: 0, balance: existed.balanceAfter, replayed: true };
  }

  const updated = unwrap(
    await db.collection(WALLET_COL).findOneAndUpdate(
      { _id: String(uid) },
      { $inc: { balance: back, totalIn: back }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after', upsert: true },
    ),
  );
  const balance = toYuan(updated?.balance);

  const doc = {
    uid,
    direction: 'in',
    amount: back,
    reason,
    ref,
    meta: meta || null,
    status: 'done',
    balanceAfter: balance,
    createdAt: new Date(),
  };
  try {
    await db.collection(LEDGER_COL).insertOne(idempotencyKey ? { ...doc, idempotencyKey } : doc);
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
  }
  return { refunded: back, balance };
}

/** 入账（新用户赠送 / 运营人工充值） */
export async function credit(uid, amount, { reason = 'credit', operator = null, ref = null, idempotencyKey = null, meta = null } = {}) {
  const db = getDB();
  const add = toYuan(amount);
  if (add <= 0) throw badRequest('充值金额必须大于 0', 'E_BAD_AMOUNT');

  if (idempotencyKey) {
    const existed = await db.collection(LEDGER_COL).findOne({ idempotencyKey });
    if (existed) return { credited: 0, balance: existed.balanceAfter, replayed: true };
  }

  await ensureWallet(uid);
  const updated = unwrap(
    await db.collection(WALLET_COL).findOneAndUpdate(
      { _id: String(uid) },
      { $inc: { balance: add, totalIn: add }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' },
    ),
  );
  const balance = toYuan(updated?.balance);

  const doc = {
    uid,
    direction: 'in',
    amount: add,
    reason,
    ref,
    operator,
    meta: meta || null,
    status: 'done',
    balanceAfter: balance,
    createdAt: new Date(),
  };
  try {
    await db.collection(LEDGER_COL).insertOne(idempotencyKey ? { ...doc, idempotencyKey } : doc);
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
  }
  return { credited: add, balance };
}

/** 今日已用掉的「会员每日免费」次数 */
export async function freeUsedToday(uid, reason = 'member_daily_free') {
  return getDB()
    .collection(LEDGER_COL)
    .countDocuments({ uid, reason, status: 'done', createdAt: { $gte: startOfDayCN() } });
}

/**
 * 报价：只算不扣。返回本次该收多少、为什么免/收。
 * @param {{uid:string, tier:string, membership?:{active:boolean}}} params
 */
export async function quote({ uid, tier, membership }) {
  if (!isValidTier(tier)) throw badRequest(`无效档位：${tier}`, 'E_BAD_TIER');
  const t = TIERS[tier];
  const base = { tier, tierZh: t.zh, price: t.price, enforce: env.enforceBilling };

  if (!env.enforceBilling) {
    return { ...base, amount: 0, reason: 'billing_disabled', label: '计费未开启（灰度）' };
  }
  if (env.freeTiers.includes(tier)) {
    return { ...base, amount: 0, reason: 'free_tier', label: '体验档免费' };
  }
  if (membership?.active) {
    const used = await freeUsedToday(uid);
    if (used < env.memberDailyFree) {
      return {
        ...base,
        amount: 0,
        reason: 'member_daily_free',
        label: `会员每日免费（今日还可免 ${Math.max(0, env.memberDailyFree - used)} 次）`,
      };
    }
  }
  return { ...base, amount: t.price, reason: 'tier_price', label: '按档位计费' };
}

/** 流水（倒序） */
export async function listLedger(uid, limit = 30) {
  const items = await getDB()
    .collection(LEDGER_COL)
    .find({ uid }, { projection: { meta: 0 } })
    .sort({ createdAt: -1 })
    .limit(Math.min(100, Math.max(1, limit)))
    .toArray();
  return items.map((x) => ({
    id: String(x._id),
    _id: undefined,
    direction: x.direction,
    amount: toYuan(x.amount),
    reason: x.reason,
    ref: x.ref || null,
    status: x.status,
    balanceAfter: x.balanceAfter,
    createdAt: x.createdAt,
  }));
}

export const LEDGER_REASONS = {
  TIER_PRICE: 'tier_price',
  FREE_TIER: 'free_tier',
  MEMBER_DAILY_FREE: 'member_daily_free',
  REFUND: 'refund',
  ADMIN_CREDIT: 'admin_credit',
  WELCOME: 'welcome',
};
