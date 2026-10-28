/**
 * 报告券（实施书 P3-T3.3）
 *
 * 两种来源，一个集合：
 *   · `invite` —— 邀请人奖励：被邀请人注册成功 → 邀请人得一张 ¥4.9 无门槛券；
 *   · 首单价（¥4.9 的诊断报告）**不落这张表** —— 它由 `report-credits.introAvailable()`
 *     按"从没付过诊断单"实时算出来。首单价是**定价规则**，不是一张券，别混为一谈。
 *
 * 为什么需要"短锁"：下单与支付之间存在时间差。下单时就把券标成已用，
 * 用户放弃支付就白丢一张券（客诉来源）；完全不加锁，用户开两个窗口能用同一张券下两单。
 * 折中是 `lockedInOrderId + lockedAt`，超过 `LOCK_MS` 自动失效 ——
 * "放弃支付的券 30 分钟后自己回来"，30 分钟内并发下单只能成一单。
 */
import { ObjectId } from 'mongodb';
import { getDB } from '../config/db.js';

const COL = 'coupons';
const DEFAULT_INVITE_FEN = 490;
const DEFAULT_TTL_MS = 30 * 24 * 3600 * 1000;
const LOCK_MS = 30 * 60 * 1000;

export const COUPON_TYPE = { invite: 'invite' };
export { LOCK_MS };

const now = () => Date.now();
const col = () => getDB().collection(COL);

function toOid(id) {
  try {
    return new ObjectId(String(id));
  } catch {
    return null;
  }
}

export async function ensureCouponIndexes() {
  try {
    // 幂等闸门：同一个人对同一个被邀请人只发一次（并发注册也不会发两张）
    await col().createIndex({ inviteKey: 1 }, { unique: true, sparse: true });
    await col().createIndex({ uid: 1, type: 1, usedInOrderId: 1 });
    await col().createIndex({ uid: 1, expiresAt: 1 });
  } catch (err) {
    if (!/already exists|IndexOptionsConflict|IndexKeySpecsConflict/i.test(String(err?.message || err))) {
      console.error('[coupons] 建索引失败：', err?.message || err);
    }
  }
}

/**
 * 发券。`inviteKey` 存在时天然幂等（唯一索引冲突 → 已发过）。
 * @returns {{ok:boolean, duplicate?:boolean, couponId?:string, valueFen?:number, expiresAt?:number, error?:string}}
 */
export async function issueCoupon({
  uid,
  type = COUPON_TYPE.invite,
  valueFen = DEFAULT_INVITE_FEN,
  ttlMs = DEFAULT_TTL_MS,
  inviteKey = null,
  meta = null,
}) {
  if (!uid) return { ok: false, error: 'E_NO_UID' };
  const fen = Math.round(Number(valueFen));
  if (!Number.isFinite(fen) || fen <= 0) return { ok: false, error: 'E_BAD_VALUE' };

  await ensureCouponIndexes();
  const doc = {
    uid: String(uid),
    type,
    valueFen: fen,
    usedInOrderId: null,
    usedAt: null,
    lockedInOrderId: null,
    lockedAt: null,
    inviteKey: inviteKey || undefined,
    meta: meta || null,
    createdAt: now(),
    expiresAt: now() + Math.max(60_000, Number(ttlMs) || DEFAULT_TTL_MS),
  };
  try {
    const r = await col().insertOne(doc);
    return { ok: true, couponId: String(r.insertedId), valueFen: fen, expiresAt: doc.expiresAt };
  } catch (err) {
    if (err?.code === 11000) return { ok: false, duplicate: true };
    console.error('[coupons] 发券失败：', err?.message || err);
    return { ok: false, error: 'E_DB' };
  }
}

/** 邀请奖励：被邀请人注册成功时调用。自己邀请自己直接拒绝。 */
export async function grantInviteCoupon({ inviterUid, inviteeUid, valueFen = DEFAULT_INVITE_FEN }) {
  const inviter = String(inviterUid || '').trim();
  const invitee = String(inviteeUid || '').trim();
  if (!inviter || !invitee) return { ok: false, error: 'E_NO_UID' };
  if (inviter === invitee) return { ok: false, error: 'E_SELF_INVITE' };
  return issueCoupon({
    uid: inviter,
    type: COUPON_TYPE.invite,
    valueFen,
    inviteKey: `${inviter}:${invitee}`,
    meta: { inviteeUid: invitee, reason: 'invite_registered' },
  });
}

/** 可用券（未用、未过期、未被有效锁占用），面额大的在前 */
export async function listAvailableCoupons(uid) {
  if (!uid) return [];
  const rows = await col()
    .find({ uid: String(uid), usedInOrderId: null, expiresAt: { $gt: now() } })
    .sort({ valueFen: -1, expiresAt: 1 })
    .limit(20)
    .toArray();
  const t = now();
  return rows
    .filter((c) => !c.lockedInOrderId || t - Number(c.lockedAt || 0) > LOCK_MS)
    .map((c) => ({ id: String(c._id), type: c.type, valueFen: c.valueFen, expiresAt: c.expiresAt }));
}

export async function bestCoupon(uid) {
  const list = await listAvailableCoupons(uid);
  return list[0] || null;
}

/**
 * 把券换算成实付价。券面额大于价格时只抵到 0（不倒找零），返回实际抵扣额。
 */
export async function priceWithCoupon(uid, priceFen) {
  const price = Math.max(0, Math.round(Number(priceFen) || 0));
  const coupon = await bestCoupon(uid);
  if (!coupon) return { coupon: null, discountFen: 0, finalFen: price };
  const discountFen = Math.min(coupon.valueFen, price);
  return { coupon, discountFen, finalFen: price - discountFen };
}

/**
 * 锁券（下单时调用）。条件更新保证两人不会抢到同一张。
 * @returns {{locked:boolean, couponId?:string, discountFen?:number, finalFen?:number}}
 */
export async function lockCoupon(uid, orderId, priceFen) {
  const price = Math.max(0, Math.round(Number(priceFen) || 0));
  for (const c of await listAvailableCoupons(uid)) {
    const oid = toOid(c.id);
    if (!oid) continue;
    const discountFen = Math.min(c.valueFen, price);
    if (discountFen <= 0) continue;
    const r = await col().findOneAndUpdate(
      {
        _id: oid,
        usedInOrderId: null,
        expiresAt: { $gt: now() },
        $or: [{ lockedInOrderId: null }, { lockedAt: { $lt: now() - LOCK_MS } }],
      },
      { $set: { lockedInOrderId: String(orderId), lockedAt: now() } },
      { returnDocument: 'after' },
    );
    if (r) return { locked: true, couponId: c.id, discountFen, finalFen: price - discountFen, valueFen: c.valueFen };
  }
  return { locked: false, discountFen: 0, finalFen: price };
}

/** 支付成功：正式核销。幂等（重复回调只生效一次）。 */
export async function consumeCoupon(orderId) {
  const r = await col().findOneAndUpdate(
    { lockedInOrderId: String(orderId), usedInOrderId: null },
    { $set: { usedInOrderId: String(orderId), usedAt: now(), lockedInOrderId: null, lockedAt: null } },
    { returnDocument: 'after' },
  );
  return { consumed: !!r, couponId: r ? String(r._id) : null };
}

/** 订单失败：把还没核销的锁解开 */
export async function releaseCoupon(orderId) {
  const r = await col().updateMany({ lockedInOrderId: String(orderId), usedInOrderId: null }, { $set: { lockedInOrderId: null, lockedAt: null } });
  return { released: (r?.modifiedCount || 0) > 0 };
}

/** 退款：已核销的券退回可用状态（数字商品失败不该吞用户一张券） */
export async function refundCoupon(orderId) {
  const r = await col().updateMany(
    { usedInOrderId: String(orderId) },
    { $set: { usedInOrderId: null, usedAt: null, lockedInOrderId: null, lockedAt: null } },
  );
  return { refunded: (r?.modifiedCount || 0) > 0 };
}

/** 管理/排障用：某人手上所有券（含已用已过期） */
export async function listCouponsForAdmin(uid, limit = 50) {
  const rows = await col().find({ uid: String(uid) }).sort({ createdAt: -1 }).limit(limit).toArray();
  return rows.map((c) => ({
    id: String(c._id),
    type: c.type,
    valueFen: c.valueFen,
    usedInOrderId: c.usedInOrderId,
    lockedInOrderId: c.lockedInOrderId,
    meta: c.meta,
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
  }));
}
