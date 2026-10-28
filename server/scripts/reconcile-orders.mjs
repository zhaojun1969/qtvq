/**
 * 订单对账 / 补单：**微信付了钱但回调没到**时把本地订单补成已支付。
 *
 * 为什么必须有它（2026-10-29 真实事故）：
 *   扫码付了 ¥4.90，微信侧 `trade_state=SUCCESS`、`transaction_id=4500…`，
 *   而本地订单一直是 `created` —— 因为 `.env` 里的 `WECHAT_PAY_NOTIFY_URL` 还指着
 *   `https://qtvq.cn/api/payment/wechat/notify`，而 nginx 的 `/api/` 是**反代到
 *   Cloudflare Pages** 的，落点根本不在自建 Node 上（access.log 里能看到 nginx 200，
 *   但那是 Pages 接的）。用户钱付了、报告没出，这是最坏的一种失败：
 *   **没有任何错误**，只有用户投诉。
 *
 *   回调是"尽力而为"的投递，不能当成唯一真相。真相在微信侧，所以要有主动对账：
 *     定期把 `created` 且超过 N 分钟的订单拿去问微信，SUCCESS 就补成 paid，CLOSED 就作废。
 *
 * 跑法（服务器 root，要读商户私钥）：
 *   cd /opt/qtvq/server
 *   sudo node --env-file=.env scripts/reconcile-orders.mjs                  # 扫最近 24h 的待付订单
 *   sudo node --env-file=.env scripts/reconcile-orders.mjs --order-id=rpt_xxx   # 只补一张
 *   ... --minutes=5 --limit=50 --dry-run
 *
 * 退出码：0 = 正常（含"没有需要补的"）；1 = 有查询失败（留给 timer 的 journal 看）
 */
import process from 'node:process';

const arg = (name, def = null) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const i = hit.indexOf('=');
  return i === -1 ? true : hit.slice(i + 1);
};

const ONLY = arg('order-id', null);
const MINUTES = Number(arg('minutes', 0));
const LIMIT = Number(arg('limit', 100));
const DRY = process.argv.includes('--dry-run');

async function main() {
  const { connectDB, getDB } = await import('../src/config/db.js');
  const { getOrder, markPaid, cancelOrder } = await import('../src/services/orders.js');
  const { queryOrder, isWechatPayConfigured } = await import('../src/services/wechat-pay.js');

  if (!isWechatPayConfigured()) {
    console.error('❌ 微信支付未配置，无法对账');
    process.exit(2);
  }
  await connectDB();
  const db = getDB();

  const filter = ONLY ? { orderId: String(ONLY) } : { status: 'created' };
  if (!ONLY && MINUTES > 0) {
    filter.createdAt = { $lte: new Date(Date.now() - MINUTES * 60_000) };
  }
  // 只补新栈订单（rpt_/whl_）：存量会员单在 KV 侧结算，不在这里动
  if (!ONLY) filter.orderId = { $regex: '^(rpt_|whl_)' };

  const orders = await db.collection('orders').find(filter).sort({ createdAt: -1 }).limit(LIMIT).toArray();
  if (!orders.length) {
    console.log('没有需要核对的订单');
    process.exit(0);
  }
  console.log(`核对 ${orders.length} 张待付订单${DRY ? '（dry-run，不改状态）' : ''}`);

  let settled = 0;
  let closed = 0;
  let failed = 0;
  for (const o of orders) {
    try {
      const q = await queryOrder(o.orderId);
      const state = q?.tradeState;
      if (state === 'SUCCESS') {
        const amountFen = Number(q.amountTotal);
        if (!DRY) {
          await markPaid({ orderId: o.orderId, transactionId: q.transactionId, amountFen });
        }
        settled += 1;
        console.log(`  ✅ ${o.orderId} ${o.sku} ¥${(Number(o.amountFen) / 100).toFixed(2)} → paid（微信 ${state}，txn ${q.transactionId}）`);
        continue;
      }
      if (state === 'CLOSED' || state === 'REVOKED' || state === 'PAYERROR') {
        if (!DRY) await cancelOrder(o.orderId, 'wechat_' + state.toLowerCase());
        closed += 1;
        console.log(`  ⚪ ${o.orderId} → ${state}（本地作废）`);
        continue;
      }
      // NOTPAY / USERPAYING：还在等用户付，什么都没发生
      console.log(`  ·  ${o.orderId} 微信侧 ${state}，继续等`);
    } catch (err) {
      failed += 1;
      // 订单不存在（ORDER_NOT_EXIST）：说明微信侧没建单成功，别无限等
      const msg = err?.message || String(err);
      console.log(`  ❌ ${o.orderId} 查询失败：${msg}`);
      if (/ORDER_NOT_EXIST|订单不存在/.test(msg) && !DRY) {
        await cancelOrder(o.orderId, 'wechat_order_not_exist');
        console.log(`     → 已在本地作废（微信侧没有这张单）`);
      }
    }
  }

  console.log(`\n补单 ${settled} · 作废 ${closed} · 异常 ${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ 对账失败：', err?.stack || err?.message || err);
  process.exit(1);
});
