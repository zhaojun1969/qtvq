/**
 * 报告/转盘订单（**server 侧**，2026-10-27）
 *
 * 《再改造技术实施书》P0-T0.1 / P1-T1.1：支付订单必须在 server 栈上，
 * 与 KV 里的存量会员订单**完全分开**（后者由 Cloudflare Functions 维护，一行不改）。
 *
 * ── 状态机 ────────────────────────────────────────────────────────────────
 *   created ──(微信回调/查询确认 paid)──> paid ──(消耗额度生成)──> consumed
 *      │                                    │
 *      └──(超时未付)──> closed               └──(生成失败/退款)──> refunded
 *
 * ── 幂等（钱的部分唯一重要的事）───────────────────────────────────────────
 * 微信会把同一条回调**重试 8 次**，所以"入账"必须是条件更新：
 *   `findOneAndUpdate({orderId, status:'created'}, {$set:{status:'paid'}})`
 * 只有第一次能匹配到，后续匹配 0 条 —— 因此不会重复给钱包加钱。
 * 再用 `wallet.credit(orderId 作为 idempotencyKey)` 做第二道闸：即使进程在
 * "改单成功、加钱之前"崩了，重启后补偿也不会重复加。
 */

import crypto from 'node:crypto';
import { getDB } from '../config/db.js';
import { credit, refund } from './wallet.js';

const COL = 'orders';

/** 报告 SKU（P1 会替换成 constants 里的统一表；此处先给出 P0 需要的最小集） */
export const SKUS = {
  diagnose: { price: 9.9, label: '避坑诊断报告' },
  retro: { price: 19.9, label: '关系复盘报告' },
  pair: { price: 29.9, label: 'AI 配对报告' },
  topup: { price: null, label: '缘值充值' },
};

export function newOrderId(prefix = 'rpt') {
  // 微信要求 out_trade_no ≤ 32 字符、且同一商户号下唯一
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

export function yuanToFen(yuan) {
  return Math.round(Number(yuan) * 100);
}

/** 建单前确保唯一索引（并发下重复建索引会抛，吞掉即可） */
export async function ensureOrderIndexes() {
  const db = getDB();
  try {
    await db.collection(COL).createIndex({ orderId: 1 }, { unique: true });
    await db.collection(COL).createIndex({ uid: 1, status: 1 });
    await db.collection(COL).createIndex({ createdAt: -1 });
  } catch (err) {
    // 索引已存在（IndexOptionsConflict/IndexKeySpecsConflict）不算错误
    if (!/already exists|IndexOptionsConflict|IndexKeySpecsConflict/i.test(String(err?.message || err))) {
      console.error('[orders] 建索引失败：', err?.message || err);
    }
  }
}

export async function createOrder({ uid, sku, amountFen, channel, meta = null }) {
  await ensureOrderIndexes();
  const orderId = newOrderId(sku === 'wheel' ? 'whl' : 'rpt');
  const doc = {
    orderId,
    uid: String(uid),
    sku,
    amountFen: Math.round(Number(amountFen)),
    channel,
    status: 'created',
    wxTransactionId: null,
    paidAt: null,
    consumedAt: null,
    refundedAt: null,
    notifyCount: 0,
    meta,
    createdAt: new Date(),
  };
  await getDB().collection(COL).insertOne(doc);
  return doc;
}

export async function getOrder(orderId) {
  return getDB().collection(COL).findOne({ orderId: String(orderId) });
}

/**
 * 标记已支付（幂等）。
 *
 * @returns {{settled:boolean, duplicate:boolean, order:object|null, credited?:number, mismatch?:boolean}}
 */
export async function markPaid({ orderId, transactionId, amountFen }) {
  const db = getDB();
  const order = await getOrder(orderId);
  if (!order) return { settled: false, duplicate: false, order: null, notFound: true };

  // 金额不符：不改状态，只记一次告警。返回 success 给微信（否则它会重试 8 次），
  // 由运营在后台对账处理 —— 让微信重试一百次也不会把错的金额变成对的。
  if (Number.isFinite(amountFen) && Number(amountFen) !== Number(order.amountFen)) {
    await db
      .collection(COL)
      .updateOne(
        { orderId: String(orderId) },
        {
          $inc: { notifyCount: 1 },
          $set: { amountMismatch: { expected: order.amountFen, got: Number(amountFen), at: new Date() } },
        },
      );
    console.error(
      `[orders] 金额不符，拒绝入账：${orderId} 期望 ${order.amountFen} 分，回调 ${amountFen} 分`,
    );
    return { settled: false, duplicate: false, order, mismatch: true };
  }

  // 幂等闸门：只有 status='created' 才能被改成 paid
  const updated = await db.collection(COL).findOneAndUpdate(
    { orderId: String(orderId), status: 'created' },
    {
      $set: { status: 'paid', wxTransactionId: transactionId || null, paidAt: new Date() },
      $inc: { notifyCount: 1 },
    },
    { returnDocument: 'after' },
  );

  if (!updated) {
    // 已有终态：重复回调、或已 consumed/refunded
    const current = await getOrder(orderId);
    await db.collection(COL).updateOne({ orderId: String(orderId) }, { $inc: { notifyCount: 1 } });
    return { settled: false, duplicate: true, order: current };
  }

  // 第二道幂等闸：入账以 orderId 作为幂等键，崩溃后重放也不会重复加钱
  let credited = 0;
  /*
   * ⚠️ 只有**缘值充值单**（sku=topup）才给钱包入账。
   *
   * 2026-10-29 真实事故：这段代码原先对所有订单都 `credit()`，于是扫码付 ¥4.90
   * 买一份避坑诊断报告，钱包又被打回 ¥4.90 —— 用户既拿到报告、余额还变多了，
   * 等于报告免费，反复操作就是无限刷。
   * 报告/转盘这类订单的"交付物"是报告本身（订单被消费即可），不该再折成余额。
   * 充值单才是"钱换成余额"，那笔钱必须入账。
   */
  const isTopup = String(updated.sku || '') === 'topup' || String(updated.plan || '') === 'topup';
  // 0 元单（券全额抵扣）没有钱可入账，直接跳过 —— 否则 wallet.credit 会抛
  // E_BAD_AMOUNT，日志里还会留下一条误导人的"入账失败需人工补入账"。
  if (isTopup && Number(updated.amountFen) > 0) {
    try {
      const r = await credit(updated.uid, Number(updated.amountFen) / 100, {
        reason: 'wechat_pay',
        ref: String(orderId),
        idempotencyKey: `wx:${orderId}`,
        meta: { sku: updated.sku, channel: updated.channel, transactionId: transactionId || null },
      });
      credited = r?.credited || 0;
    } catch (err) {
      console.error('[orders] 入账失败（订单已是 paid，需人工补入账）：', orderId, err?.message || err);
      return { settled: true, duplicate: false, order: updated, credited: 0, creditError: String(err?.message || err) };
    }
  }

  return { settled: true, duplicate: false, order: updated, credited };
}

/** 消耗订单（生成报告时调用）：paid → consumed。幂等，重复调用返回 duplicate */
export async function consumeOrder(orderId) {
  const updated = await getDB()
    .collection(COL)
    .findOneAndUpdate(
      { orderId: String(orderId), status: 'paid' },
      { $set: { status: 'consumed', consumedAt: new Date() } },
      { returnDocument: 'after' },
    );
  if (!updated) return { consumed: false, order: await getOrder(orderId) };
  return { consumed: true, order: updated };
}

/**
 * 作废订单（仅 created → canceled）。
 * 用途：同一用户并发下单时，后建的那张会因为抢不到券而被作废 ——
 * 绝不能让它带着折扣价继续存在，否则用户可以用作废单再走一次支付流程。
 * 已支付/已消费的订单不走这里（那要走 refundOrder）。
 */
export async function cancelOrder(orderId, reason = 'abandoned') {
  const updated = await getDB()
    .collection(COL)
    .findOneAndUpdate(
      { orderId: String(orderId), status: 'created' },
      { $set: { status: 'canceled', canceledAt: new Date(), cancelReason: String(reason).slice(0, 64) } },
      { returnDocument: 'after' },
    );
  if (!updated) return { canceled: false, order: await getOrder(orderId) };
  return { canceled: true, order: updated };
}

/** 退款：consumed/paid → refunded，并把钱退回钱包（幂等键 refund:<orderId>） */
/**
 * 退款（2026-10-29 修正）：**先调微信退款，成功后才改本地状态**。
 *
 * 原来的实现只把本地订单改成 refunded 就返回成功 —— 用户看到"已退款"，钱还在我们账上。
 * 现在顺序是：调微信 refund → 受理成功(SUCCESS/PROCESSING) → 本地置 refunded 并记 refundId；
 * 微信侧失败 → 本地保持原状态，返回 error，交给调用方告警/人工处理（不假装退成功）。
 * 退款是异步到账：状态 PROCESSING 也算受理，真实到账看 queryRefund。
 */
export async function refundOrder(orderId, reason = 'report_failed') {
  const db = getDB();
  const current = await getOrder(orderId);
  if (!current) return { refunded: false, notFound: true };
  if (current.status === 'refunded') return { refunded: false, duplicate: true, order: current };

  // ① 先向微信申请退款：失败就保持本地状态，绝不"账上退款"
  const { createRefund } = await import('./wechat-pay.js');
  let wxRefund = null;
  try {
    wxRefund = await createRefund({
      orderId: current.orderId,
      transactionId: current.wxTransactionId,
      amountFen: Number(current.amountFen),
      totalFen: Number(current.amountFen),
      reason,
    });
    if (wxRefund && !wxRefund.stub && !['SUCCESS', 'PROCESSING'].includes(String(wxRefund.status))) {
      return { refunded: false, order: current, error: `微信退款未受理（status=${wxRefund.status}）` };
    }
  } catch (err) {
    console.error(`[orders] 微信退款失败 ${orderId}：`, err?.message || err);
    return { refunded: false, order: current, error: String(err?.message || err) };
  }
  const updated = await db.collection(COL).findOneAndUpdate(
    { orderId: String(orderId), status: { $in: ['paid', 'consumed'] } },
    { $set: { status: 'refunded', refundedAt: new Date(), refundReason: reason, wxRefundId: wxRefund?.refundId || null, refundStatus: wxRefund?.status || 'local_only' } },
    { returnDocument: 'after' },
  );
  if (!updated) return { refunded: false, order: await getOrder(orderId) };

  /*
   * 钱包回补：**只有缘值充值单**需要（钱本来是换成余额的）。
   * 报告/转盘单的交付物是内容本身，支付时就没进钱包（见 markPaid 的 topup-only 口径），
   * 退款时更不该往钱包里加钱 —— 否则「买报告 → 生成失败 → 退款」会变成「白拿一份报告 + 余额变多」。
   */
  const topupOrder = String(updated.sku || '') === 'topup' || String(updated.plan || '') === 'topup';
  if (!topupOrder) return { refunded: true, order: updated, walletRefunded: false };
  try {
    await refund(updated.uid, Number(updated.amountFen) / 100, {
      reason: 'refund',
      ref: String(orderId),
      meta: { orderId, reason },
    });
  } catch (err) {
    console.error('[orders] 退款失败（订单已标 refunded，需人工处理）：', orderId, err?.message || err);
    return { refunded: true, order: updated, refundError: String(err?.message || err) };
  }
  return { refunded: true, order: updated };
}

/** 我的订单列表（不含敏感字段） */
export async function listOrders(uid, limit = 20) {
  return getDB()
    .collection(COL)
    .find({ uid: String(uid) }, { projection: { _id: 0 } })
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(limit) || 20, 100))
    .toArray();
}
