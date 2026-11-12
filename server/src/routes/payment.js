/**
 * 微信支付三件套（**server 侧**，2026-10-27）
 *
 *   POST /v1/payment/wechat/create        下单（native / jsapi / app）
 *   POST /v1/payment/wechat/notify        回调（微信服务器 → 我们）
 *   GET  /v1/payment/wechat/query/:orderId 主动查询（对账/补单）
 *
 * 边界（《再改造技术实施书》§2）：**存量会员支付一行不改**，
 * 这里只服务新栈的报告/转盘订单，订单号前缀 `rpt_` / `whl_`，与 KV 订单不会混。
 *
 * ── 回调路由的三条硬规则 ──────────────────────────────────────────────────
 * 1. **必须用原始请求体验签**。Express 的 `express.json()` 会把它解析成对象，
 *    再 `JSON.stringify` 出来的字符串与原文可能不同（空格/顺序/中文转义），验签必失败。
 *    所以 `app.js` 里给 `express.json` 加了 `verify` 钩子，把原文存到 `req.rawBody`。
 * 2. **一律返回 200 + `{code:'SUCCESS'}`**（除非验签失败要拒）。微信对非 200/FAIL
 *    会重试 8 次，把错误放大成雪崩。
 * 3. **入账幂等靠订单状态机**，不靠"记一个已处理集合"（见 `services/orders.js`）。
 */

import { Router } from 'express';
import { getDB } from '../config/db.js';
import { requireAuth } from '../middleware/auth.js';
import { ok, wrap, badRequest } from '../lib/http.js';
import {
  createNativeOrder,
  createJsapiOrder,
  createAppOrder,
  queryOrder,
  verifyNotify,
  isWechatPayConfigured,
  notifySuccess,
  queryRefund,
  notifyFail,
} from '../services/wechat-pay.js';
import { SKUS, createOrder, getOrder, getOrderOwned, markPaid, listOrders, cancelOrder } from '../services/orders.js';
import { priceFenFor } from '../services/report-credits.js';
import { priceWithCoupon, lockCoupon, consumeCoupon } from '../services/coupons.js';
import { REPORT_SKUS } from '../constants.js';

const router = Router();

/**
 * 商品单价（分）。
 *
 * **必须优先走 `priceFenFor`**：旧实现直接读 `SKUS[sku].price`，于是
 * `/v1/report/skus` 显示首单价 ¥4.9、微信侧却按 ¥9.9 下单 ——
 * 用户看到的价格和实际扣款不一致（这是真 bug，不是显示问题）。
 * 非报告商品（会员等）`priceFenFor` 返回 null，再回落到价目表。
 *
 * 名字刻意不叫 `basePriceFen`：路由里有个同名局部变量存结果，
 * 同名会让 `const basePriceFen = await basePriceFen(...)` 变成 TDZ 自引用
 * （ReferenceError: Cannot access 'basePriceFen' before initialization）。
 */
async function resolvePriceFen(uid, sku) {
  const fromReport = await priceFenFor(uid, sku);
  if (Number.isFinite(fromReport)) return Math.round(fromReport);
  const item = SKUS[sku];
  if (!item || item.price == null) return null;
  return Math.round(item.price * 100);
}

router.get('/skus', (req, res) => ok(res, { skus: SKUS, wechatConfigured: isWechatPayConfigured() }));

/**
 * 支付成功后核销券。查不到锁过的券就是"没用券"（或券已被别的路径核销），不报错。
 * 刻意不在这里抛异常：钱已经收到了，券的问题不能影响回调的成功应答。
 */
async function settleCoupon(orderId) {
  try {
    const r = await consumeCoupon(orderId);
    if (r.consumed) console.log('[payment] 券已核销：', r.couponId, 'order=', orderId);
    return r;
  } catch (err) {
    console.error('[payment] 核销券失败：', orderId, err?.message || err);
    return { consumed: false };
  }
}

router.get(
  '/orders',
  requireAuth,
  wrap(async (req, res) => ok(res, { items: await listOrders(req.uid, req.query.limit) })),
);

router.post(
  '/wechat/create',
  requireAuth,
  wrap(async (req, res) => {
    const { sku, channel = 'native', openid, description } = req.body || {};
    const basePriceFen = await resolvePriceFen(req.uid, sku);
    if (basePriceFen == null) throw badRequest('未知的商品或未定价', 'E_BAD_SKU');
    if (!['native', 'jsapi', 'app'].includes(channel)) throw badRequest('不支持的支付渠道', 'E_BAD_CHANNEL');

    /*
     * 券抵扣（P3-T3.3）：先按"券后价"建单，再把券锁到这张单上。
     * 顺序不能反 —— 锁需要 orderId。若锁失败（券刚被别人抢走），
     * 就把这张已按券后价建的订单作废并让调用方重试，绝不"给了折扣却没有券"。
     */
    const quote = await priceWithCoupon(req.uid, basePriceFen);
    const order = await createOrder({
      uid: req.uid,
      sku,
      amountFen: quote.finalFen,
      channel,
      meta: quote.coupon
        ? { baseFen: basePriceFen, discountFen: quote.discountFen, couponId: quote.coupon.id, couponType: quote.coupon.type }
        : { baseFen: basePriceFen },
    });

    let couponId = null;
    if (quote.coupon) {
      const locked = await lockCoupon(req.uid, order.orderId, basePriceFen);
      if (!locked.locked || locked.discountFen !== quote.discountFen) {
        await cancelOrder(order.orderId, 'coupon_gone');
        throw badRequest('优惠券刚刚被占用，请重新下单', 'E_COUPON_GONE');
      }
      couponId = locked.couponId;
    }
    const amountFen = quote.finalFen;

    // 券面额覆盖全额：不走微信（0 元单微信会拒），直接本地结清并把券核销
    if (amountFen <= 0) {
      await markPaid({ orderId: order.orderId, transactionId: 'coupon:' + (couponId || ''), amountFen: 0 });
      if (couponId) await consumeCoupon(order.orderId);
      return ok(res, {
        orderId: order.orderId,
        amountFen: 0,
        basePriceFen,
        discountFen: quote.discountFen,
        sku,
        channel,
        paidByCoupon: true,
        stub: !isWechatPayConfigured(),
      });
    }

    if (!isWechatPayConfigured()) {
      // 未配置商户号时返回 stub：明确告诉调用方"本地单已建、微信侧未下单"，
      // 而不是抛一个看不懂的错误（与 Workers 版行为一致）。
      return ok(res, {
        orderId: order.orderId,
        amountFen,
        basePriceFen,
        discountFen: quote.discountFen,
        couponId,
        sku,
        channel,
        stub: true,
        message: '微信商户号未配置，已创建本地订单 stub',
      });
    }

    const desc = String(description || SKUS[sku]?.label || REPORT_SKUS[sku]?.zh || 'Q问报告').slice(0, 120);
    const extra = { basePriceFen, discountFen: quote.discountFen, couponId };
    if (channel === 'jsapi') {
      const r = await createJsapiOrder({ orderId: order.orderId, description: desc, amountFen, openid });
      return ok(res, { orderId: order.orderId, amountFen, sku, channel, ...extra, ...r });
    }
    if (channel === 'app') {
      const r = await createAppOrder({ orderId: order.orderId, description: desc, amountFen });
      return ok(res, { orderId: order.orderId, amountFen, sku, channel, ...extra, ...r });
    }
    const r = await createNativeOrder({ orderId: order.orderId, description: desc, amountFen });
    return ok(res, { orderId: order.orderId, amountFen, sku, channel, ...extra, ...r });
  }),
);

/**
 * 微信回调。
 * 注意：**不挂 requireAuth**，也不走统一错误处理 —— 任何异常都必须回 200+FAIL 或 200+SUCCESS，
 * 否则微信会持续重试。这里自己 try/catch，不用 wrap()。
 */
/*
 * 退款回调（2026-10-29）：微信退款到账/失败时会推这里。
 *
 * 为什么仍要保留 15 分钟对账任务：回调可能丢（我们刚经历过支付回调丢单），
 * 回调只是"更快知道"，不是唯一真相。这里验签后直接按 out_refund_no 查一次微信，
 * 用查询结果写库 —— 不解析 resource 里的字段，避免退款通知结构与支付通知不同导致的解析错。
 */
router.post('/wechat/refund-notify', async (req, res) => {
  try {
    const raw = req.rawBody || JSON.stringify(req.body || {});
    const v = verifyNotify(req.headers, raw);
    if (!v.ok) return res.status(401).json(notifyFail(v.error || '验签失败'));
    const outRefundNo = String(v.outRefundNo || '');
    const orderId = outRefundNo.replace(/-r\d+$/, '');
    if (!orderId) return res.json(notifySuccess());
    const q = await queryRefund(outRefundNo);
    await getDB()
      .collection('orders')
      .updateOne(
        { orderId },
        { $set: { refundStatus: String(q.status || 'UNKNOWN'), wxRefundId: q.refund_id || null, refundCheckedAt: new Date() } },
      );
    return res.json(notifySuccess());
  } catch (err) {
    console.error('[pay] 退款回调异常：', err?.message || err);
    return res.status(500).json(notifyFail('处理失败'));
  }
});

router.post('/wechat/notify', async (req, res) => {
  try {
    const rawBody = req.rawBody || '';
    const result = verifyNotify(req.headers, rawBody);
    if (!result.ok) {
      console.error('[payment] 回调校验失败：', result.error);
      return res.status(200).json(notifyFail(result.error));
    }

    const settled = await markPaid({
      orderId: result.outTradeNo,
      transactionId: result.transactionId,
      amountFen: result.amountTotal,
    });

    if (settled.notFound) {
      // 不是本栈的订单：可能是存量会员订单（KV）的回调。回 SUCCESS 避免微信重试，
      // 但记一条日志 —— 若这类日志持续出现，说明两套订单号前缀撞了。
      console.warn('[payment] 回调订单不属于 server 栈：', result.outTradeNo);
      return res.status(200).json(notifySuccess());
    }
    if (settled.mismatch) {
      // 金额不符：不回 FAIL，避免微信把同一条错误重复推 8 次；
      // 订单已标记 amountMismatch，等人工对账。
      console.error('[payment] 金额不符，已记录待人工处理：', result.outTradeNo);
      return res.status(200).json(notifySuccess());
    }

    // 钱到账即核销券。settled 才核销 —— 重复回调不会二次核销（核销本身也是幂等的）
    if (settled.settled) await settleCoupon(result.outTradeNo);

    return res.status(200).json(notifySuccess());
  } catch (err) {
    console.error('[payment] 回调处理异常：', err?.message || err);
    // 仍回 200：异常已在服务端记录，让微信停止重试，由对账任务兜底
    return res.status(200).json(notifySuccess());
  }
});

router.get(
  '/wechat/query/:orderId',
  requireAuth,
  wrap(async (req, res) => {
    /* E.81 属主限定查询：订单不存在与他人订单统一 400，不泄漏存在性 */
    const order = await getOrderOwned(req.params.orderId, req.uid);
    if (!order) throw badRequest('订单不存在或无权查看', 'E_NO_ORDER');

    // 本地是终态就不必再问微信
    if (order.status === 'paid' || order.status === 'consumed' || order.status === 'refunded') {
      return ok(res, { orderId: order.orderId, status: order.status, local: true });
    }

    const remote = await queryOrder(order.orderId);
    // 主动查询发现已支付但回调没到（丢通知）：这里补入账，与回调走同一幂等路径
    if (remote.ok && remote.tradeState === 'SUCCESS') {
      const settled = await markPaid({
        orderId: order.orderId,
        transactionId: remote.transactionId,
        amountFen: remote.amountTotal,
      });
      if (settled.settled) await settleCoupon(order.orderId);
      return ok(res, {
        orderId: order.orderId,
        status: settled.order?.status || 'paid',
        settled: settled.settled,
        duplicate: !!settled.duplicate,
        remote,
      });
    }

    return ok(res, { orderId: order.orderId, status: order.status, remote });
  }),
);

export default router;
