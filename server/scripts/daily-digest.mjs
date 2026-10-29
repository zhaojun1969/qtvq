/**
 * 每日运营简报（2026-10-29）
 *
 * 为什么是邮件而不是再加一个页面：告警邮件/运营台都在"等人主动看"。每天 09:00 一封
 * 汇总（昨日营收/订单/质量/退款/验收门），运营只需读一封信就知道有没有事。
 *
 * 数据全部来自已有聚合（metrics_daily / orders / reports），不新增计算口径。
 * 跑法：cd /opt/qtvq/server && sudo node --env-file=.env scripts/daily-digest.mjs [--dry-run]
 */
import process from 'node:process';

const DRY = process.argv.includes('--dry-run');

async function main() {
  const { connectDB, getDB } = await import('../src/config/db.js');
  const metrics = await import('../src/services/metrics.js');
  const { isMailConfigured, sendNoticeMail } = await import('../src/services/mail.js');
  await connectDB();
  const db = getDB();

  const yesterday = metrics.dayKey(new Date(Date.now() - 86400000));
  await metrics.aggregateDay(yesterday);
  const row = await db.collection('metrics_daily').findOne({ date: yesterday });
  const gate = await metrics.acceptanceGate({ days: metrics.GATE.windowDays });

  const orders = await db.collection('orders').countDocuments({ status: { $in: ['paid', 'consumed'] }, paidAt: { $gte: new Date(Date.now() - 86400000) } });
  const refundBad = await db.collection('orders').countDocuments({ status: 'refunded', refundStatus: { $in: ['ABNORMAL', 'CLOSED'] } });
  const lowQuality = await db.collection('reports').countDocuments({ 'quality.low': true, createdAt: { $gte: new Date(Date.now() - 86400000) } });

  const lines = [
    '日期：' + yesterday,
    '新注册 ' + row.newUsers + ' · 激活 ' + row.activated + ' · 次日留存 ' + (row.d1Rate == null ? '待定' : (row.d1Rate * 100).toFixed(1) + '%'),
    '报告单 ' + row.reportOrders + ' · 报告付费 ' + row.reportPaid + ' · 报告实收 ¥' + (row.reportRevenueFen / 100).toFixed(2) + ' · 全部实收 ¥' + (row.revenueFen / 100).toFixed(2),
    '落地曝光 ' + row.landingViews + ' · 报告浏览 ' + row.reportViews + ' · 分享 ' + row.shareGenerated + '→' + row.shareLanding,
    '昨日已支付订单 ' + orders + ' 笔 · 低质报告 ' + lowQuality + ' 份 · 异常退款 ' + refundBad + ' 笔',
    '90 天验收门：' + gate.status + (gate.reasons.length ? '（' + gate.reasons.join('；') + '）' : ''),
  ];

  const subject = 'Q问运营简报 ' + yesterday + ' · 实收 ¥' + (row.revenueFen / 100).toFixed(2) + (refundBad ? ' · 异常退款 ' + refundBad : '');
  if (DRY) { console.log(subject); lines.forEach((l) => console.log('  ' + l)); process.exit(0); }
  if (!isMailConfigured()) { console.error('❌ 邮件未配置'); process.exit(2); }
  await sendNoticeMail({ title: subject, lines });
  console.log('已发送：' + subject);
  process.exit(0);
}

main().catch((err) => { console.error('❌ 简报失败：', err?.stack || err?.message || err); process.exit(1); });
