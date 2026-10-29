/**
 * 退款对账：把 refundStatus=PROCESSING 的订单查到终态（SUCCESS / CLOSED / ABNORMAL）。
 *
 * 为什么需要：微信退款是**异步**的，接口返回 PROCESSING 只代表受理成功。
 * 2026-10-29 两笔真实退款演练都停在 PROCESSING —— 没有对账就永远不知道钱到没到账，
 * 客诉时也拿不出证据。这个脚本与 qtvq-reconcile.timer（支付补单）同一思路：
 * 以微信侧为真相，本地只做投影。
 *
 * 跑法（服务器 root）：
 *   cd /opt/qtvq/server && sudo node --env-file=.env scripts/reconcile-refunds.mjs
 *   ... --minutes=0 --limit=50 --dry-run
 *
 * 退出码：0 正常；1 有查询失败。
 */
import process from 'node:process';

const arg = (name, def = null) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const i = hit.indexOf('=');
  return i === -1 ? true : hit.slice(i + 1);
};
const LIMIT = Number(arg('limit', 50));
const DRY = process.argv.includes('--dry-run');

async function main() {
  const { connectDB, getDB } = await import('../src/config/db.js');
  const { queryRefund, isWechatPayConfigured } = await import('../src/services/wechat-pay.js');
  if (!isWechatPayConfigured()) { console.error('❌ 微信支付未配置，无法对账退款'); process.exit(2); }
  await connectDB();
  const db = getDB();

  const rows = await db
    .collection('orders')
    .find({ status: 'refunded', refundStatus: { $in: ['PROCESSING', 'local_only', null] } })
    .sort({ refundedAt: -1 })
    .limit(LIMIT)
    .toArray();

  if (!rows.length) { console.log('没有待对账的退款'); process.exit(0); }
  console.log(`待对账退款 ${rows.length} 笔${DRY ? '（dry-run）' : ''}`);

  let done = 0, failed = 0;
  for (const o of rows) {
    const outRefundNo = (o.orderId || '') + '-r1';
    try {
      const q = await queryRefund(outRefundNo);
      const status = String(q.status || 'UNKNOWN');
      const final = ['SUCCESS', 'CLOSED', 'ABNORMAL'].includes(status);
      if (!DRY) {
        await db.collection('orders').updateOne(
          { orderId: o.orderId },
          { $set: { refundStatus: status, wxRefundId: q.refund_id || o.wxRefundId || null, refundCheckedAt: new Date() } },
        );
      }
      if (final) done += 1;
      console.log(`  ${final ? '✅' : '·'} ${o.orderId} ${o.sku || ''} ¥${(Number(o.amountFen) / 100).toFixed(2)} → ${status}${q.amount ? ' payer_refund=' + q.amount.payer_refund : ''}`);
    } catch (err) {
      failed += 1;
      console.log(`  ❌ ${o.orderId} 查询失败：${err?.message || err}`);
    }
  }
  console.log(`\n终态 ${done} · 仍处理中 ${rows.length - done - failed} · 异常 ${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error('❌ 退款对账失败：', err?.stack || err?.message || err); process.exit(1); });
