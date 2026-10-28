/**
 * 收款入账：把「微信侧已确认收款」的订单落库 → 开通会员 → 通知运营（邮件）。
 *
 * 抽出来给两条路径共用，避免逻辑漂移：
 *   1) 微信回调 notify（异步、理论上最及时，但依赖外网可达 + 验签配置正确）
 *   2) 前端轮询 status/query 时的主动查询自愈（不依赖回调，是「付了钱网站没反应」的兜底）
 *
 * 幂等：markOrderPaid 内部已有 `status === 'paid'` 短路，重复调用不会重复开通或重复发信。
 */

import { activatePayment } from './quota-store.js';
import { markOrderPaid, listPendingOrders } from './order-store.js';
import { sendNoticeMail } from './mail.js';
import { queryWechatOrder } from './wechat-pay.js';

/**
 * 缘值充值入账：调用 Node 侧运营接口给钱包加钱。
 *
 * 为什么走 HTTP 而不是直连数据库：钱包在 Node 的 MongoDB 里，Pages 侧只有 KV。
 * 两边**共用同一个用户 id**（Node 的 users._id 就是 Cloudflare 的 uid，见 server/src/config/db.js），
 * 所以只要把 uid 传过去即可，无需映射表。
 *
 * 幂等：Node 的 /v1/admin/users/:uid/credit 支持 `ref`，内部生成
 * `admin_credit:${ref}` 作为幂等键 —— 所以用订单号当 ref，微信回调重试或前端轮询重复触发
 * 都不会重复入账（这是"自动到账"能不能做的关键前提）。
 */
async function creditWalletForTopup(env, order) {
  const base = String(env.NODE_API_BASE || '').replace(/\/$/, '');
  const adminKey = String(env.NODE_ADMIN_KEY || '');
  if (!base || !adminKey) {
    // 不能静默失败：钱已经收了，必须让运营知道要人工补账
    console.error('[payment-activate] 充值已支付但未配置 NODE_API_BASE / NODE_ADMIN_KEY，无法自动入账：', order.orderId);
    return { ok: false, error: '自动入账未配置（NODE_API_BASE / NODE_ADMIN_KEY），请人工入账：' + order.orderId };
  }
  if (!order.uid) {
    console.error('[payment-activate] 充值订单缺少 uid，无法自动入账：', order.orderId);
    return { ok: false, error: '订单缺少 uid，请人工入账：' + order.orderId };
  }

  try {
    const res = await fetch(`${base}/v1/admin/users/${encodeURIComponent(order.uid)}/credit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': adminKey,
        /*
         * ★ 必须带 User-Agent —— 这是 2026-10-11 吞钱事故的真正根因。
         *
         * 本项目的 nginx 安全加固会 444（静默断连）拦截"空 UA / 爬虫框架 UA"的请求。
         * 而 `fetch()` 在 Workers 里默认**不带 User-Agent**，于是 Pages 发往
         * `https://qtvq.cn/v1/admin/.../credit` 的入账请求**在 nginx 就被断掉了**：
         *   access.log 实测：Cloudflare 源 IP（172.71.x / 104.22.x / 162.158.x）
         *   "POST /v1/admin/users/<uid>/credit HTTP/2.0" → **444 0**
         * 表现就是"订单已 paid、钱包永不加钱"（那个 444 在 Node 侧什么都看不到，连日志都没有）。
         * 加一个明确的 UA 即可放行；管理端本身另有 X-Admin-Key 保护，所以这不削弱安全性。
         */
        'User-Agent': 'qtvq-payment-activate/1.0 (+https://qtvq.cn)',
      },
      body: JSON.stringify({
        amount: Number(order.amountFen) / 100,
        ref: order.orderId,
        reason: '微信在线充值（自动到账）',
        // 写进流水的机器可读原因码：'topup' 让用户的缘值明细显示「缘值充值」，
        // 而不是与运营手工入账混在一起显示成「人工入账」。
        // 服务端对未知值会回落成 admin_credit，所以这里传错也不会写坏数据。
        ledgerReason: 'topup',
        // 支付系统专用：用户在 Pages 侧注册，Node 侧可能还没有资料文档。
        // 手工入账不传该标志，仍然要求用户已存在（防错充）。
        createIfMissing: true,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error || data?.message || `HTTP ${res.status}`;
      console.error('[payment-activate] 充值入账被拒：', order.orderId, msg);
      return { ok: false, error: `入账失败：${msg}` };
    }
    console.log('[payment-activate] 充值已入账：', order.orderId, 'uid=', order.uid, 'amount=', order.amountFen / 100);
    return { ok: true, credited: data };
  } catch (err) {
    console.error('[payment-activate] 充值入账请求异常：', order.orderId, err);
    return { ok: false, error: `入账请求异常：${err?.message || err}` };
  }
}

/**
 * @param {object} env
 * @param {object|string} orderRef 订单对象或 orderId
 * @param {{platformTradeNo?: string, paidAt?: number, source?: string}} opts
 * @returns {Promise<{ok: boolean, order?: object, alreadyPaid?: boolean, error?: string}>}
 */
export async function activatePaidOrder(env, orderRef, opts = {}) {
  const orderId = typeof orderRef === 'string' ? orderRef : orderRef?.orderId;
  if (!orderId) return { ok: false, error: '缺少 orderId' };

  const paid = await markOrderPaid(env, orderId, {
    platformTradeNo: opts.platformTradeNo || '',
    paidAt: opts.paidAt || Date.now(),
  });
  if (paid.error) return { ok: false, error: paid.error };

  const { order, alreadyPaid } = paid;

  /*
   * ⚠️ 缘值充值必须"每次调用都自愈"，不能只在首次入账。
   *
   * 2026-10-11 事故（毛敏两笔 ¥1 被吞）：本函数 :81 先把订单标成 paid，:92 才去入账；
   * 入账一旦失败（瞬时网络抖动 / 上游 502 / 密钥不符），订单**已经是 paid**，
   * 而此后每一次重试（微信回调重试、前端轮询、自愈查单）都会命中下面的
   * `alreadyPaid` 短路 → **永远不会再尝试入账** → 永久丢账、用户那边只看到"已支付"却没有余额与记录。
   *
   * 修法：topup 订单**无论是否 alreadyPaid 都调用一次** `creditWalletForTopup`。
   * Node 侧的入账以 `ref = orderId` 幂等（见本文件开头注释），所以重复调用不会重复加钱，
   * 但"上次没加上"的情况会被自动补上 —— 短路从"永不重试"变成"每次自愈"。
   *
   * 正确性的另一半（顺序）仍待做：先幂等入账、成功后再 markOrderPaid。
   * 在那之前，这个自愈分支已经能保证"最终一定入账"，不会再静默吞钱。
   */
  if (order.plan === 'topup') {
    const credited = await creditWalletForTopup(env, order);
    if (!credited.ok) return { ok: false, error: credited.error, order };
    if (alreadyPaid) {
      // 上一次没入账、这次补上了（或本来就已入账，Node 幂等返回 credited:0）
      console.log('[payment-activate] 充值自愈补账完成：', order.orderId, 'uid=', order.uid);
      return { ok: true, order, alreadyPaid: true, repaired: true, credited: credited.credited };
    }
    try {
      const cny = (Number(order.amountFen || 0) / 100).toFixed(2);
      await sendNoticeMail(env, {
        subject: `[Q问收款] 缘值充值 ¥${cny} 已到账并自动入账`,
        text: [
          `客户在线支付充值 ¥${cny}，已**自动**加到其钱包余额，无需人工核实${opts.source ? `（${opts.source}确认）` : ''}。`,
          '',
          `订单号：${order.orderId}`,
          `金额：¥${cny}`,
          `用户 uid：${order.uid || '(缺失)'}`,
          `客户标识：${order.clientId}`,
          `微信交易号：${opts.platformTradeNo || order.platformTradeNo || '—'}`,
          `时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
        ].join('\n'),
      });
    } catch (err) {
      console.error('[payment-activate] 充值到账通知发送失败：', err);
    }
    return { ok: true, order, alreadyPaid: false, topup: true };
  }

  // 非充值（会员开通）：alreadyPaid 短路保持原样 —— 激活本身是幂等的，且不会丢钱
  if (alreadyPaid) return { ok: true, order, alreadyPaid: true };

  const activated = await activatePayment(env, order.clientId, order.plan);
  if (!activated) return { ok: false, error: '会员激活失败', order };

  // 通知失败必须吞掉：它不能影响入账结果，否则微信重试或前端轮询会看到失败而误判。
  try {
    const cny = (Number(order.amountFen || 0) / 100).toFixed(2);
    const how = opts.source ? `（${opts.source}确认）` : '';
    await sendNoticeMail(env, {
      subject: `[Q问收款] ¥${cny} 已到账 · ${order.planLabel || order.plan} · 会员已自动开通`,
      text: [
        `微信在线支付成功，会员已自动开通，无需人工核实${how}。`,
        '',
        `订单号：${order.orderId}`,
        `套餐：${order.planLabel || order.plan}（${order.plan}）`,
        `金额：¥${cny}`,
        `客户标识：${order.clientId}`,
        `微信交易号：${opts.platformTradeNo || order.platformTradeNo || '—'}`,
        `时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
        '',
        '本条为系统自动通知；全部订单可在运营台「在线订单」查看。',
      ].join('\n'),
    });
  } catch (err) {
    console.error('[payment-activate] 付款通知邮件发送失败：', err);
  }

  return { ok: true, order, alreadyPaid: false };
}

/**
 * 客户打开账户页 / 主站同步额度时调用：把这个客户所有未激活的微信订单拿去问微信真实状态，
 * 确认已收款就补开通。这是「付了钱、页面一关、回调又没到」场景的兜底，不依赖任何人工操作。
 *
 * @returns {Promise<{checked: number, activated: number}>}
 */
export async function reconcileClientPendingOrders(env, clientId) {
  const out = { checked: 0, activated: 0 };
  if (!clientId) return out;

  let items = [];
  try {
    ({ items } = await listPendingOrders(env, clientId));
  } catch {
    return out;
  }

  for (const order of items) {
    if (!String(order.channel || '').startsWith('wechat')) continue;
    out.checked += 1;
    try {
      const q = await queryWechatOrder(env, order.orderId);
      if (!q.ok || q.tradeState !== 'SUCCESS') continue;
      if (Number(q.amountTotal) !== Number(order.amountFen)) {
        console.error('[reconcile] 金额不一致，未自动开通：', order.orderId, order.amountFen, q.amountTotal);
        continue;
      }
      const r = await activatePaidOrder(env, order, {
        platformTradeNo: q.transactionId,
        source: '账户页查询',
      });
      if (r.ok && !r.alreadyPaid) out.activated += 1;
      else if (!r.ok) console.error('[reconcile] 入账失败：', order.orderId, r.error);
    } catch (err) {
      console.error('[reconcile] 查询订单失败：', order.orderId, err);
    }
  }

  return out;
}
