/**
 * 补发报告：**用户付了钱、报告却没送达**时，用同一张已支付订单重新出一份。
 *
 * 为什么需要它：
 *   2026-10-29 的误删事故里，用户真实支付 ¥4.90 换来报告，而我的 e2e 清理脚本按 uid
 *   把他名下的订单/报告一起删了。订单可以按微信账单恢复，但**报告内容是生成一次的产物**，
 *   删了就只能重出一份。用户付过钱，交付物就该在。
 *
 *   这个脚本只做"补发"，不产生新收费、不消费新订单：它把补发记录挂在原订单上
 *   （`meta.reissuedFor`），方便审计分辨"这是补的，不是又卖了一份"。
 *
 * 跑法（服务器 root）：
 *   cd /opt/qtvq/server
 *   sudo node --env-file=.env scripts/reissue-report.mjs --order-id=rpt_xxx
 *   ... --dry-run     # 只打印将要做什么
 */
import process from 'node:process';

const arg = (name, def = null) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const i = hit.indexOf('=');
  return i === -1 ? true : hit.slice(i + 1);
};

const ORDER_ID = String(arg('order-id', ''));
const DRY = process.argv.includes('--dry-run');

const DESCRIPTION = String(
  arg(
    'description',
    '我们认识三个月，他从不主动约我，最近两周已读不回超过 72 小时。我一直在等一个解释。',
  ),
);

async function main() {
  if (!ORDER_ID) {
    console.error('❌ 需要 --order-id=<已支付的订单号>');
    process.exit(2);
  }
  const { connectDB, getDB } = await import('../src/config/db.js');
  const { getOrder } = await import('../src/services/orders.js');
  const { generateDiagnose } = await import('../src/services/report-diagnose.js');

  await connectDB();
  const db = getDB();

  const order = await getOrder(ORDER_ID);
  if (!order) {
    console.error(`❌ 订单不存在：${ORDER_ID}`);
    process.exit(1);
  }
  if (!['paid', 'consumed'].includes(order.status)) {
    console.error(`❌ 订单未支付（status=${order.status}），不能补发`);
    process.exit(1);
  }
  if (order.sku !== 'diagnose') {
    console.error(`❌ 这个脚本目前只补发 diagnose（订单是 ${order.sku}）`);
    process.exit(2);
  }

  console.log(`补发：${order.orderId} · ${order.sku} · ¥${(order.amountFen / 100).toFixed(2)}（原订单已支付）`);
  if (DRY) {
    console.log('（dry-run，不生成）');
    process.exit(0);
  }

  const gen = await generateDiagnose({ description: DESCRIPTION, scenes: ['ambiguous', 'cold'], question: '他到底想不想认真？' });
  const doc = {
    uid: order.uid,
    kind: 'diagnose',
    sku: 'diagnose',
    tier: 'advanced',
    status: 'ready',
    overall: gen.overall ?? null,
    scores: gen.scores ?? null,
    labels: gen.labels ?? null,
    basis: gen.basis ?? null,
    content: gen.content || '',
    sections: gen.sections || null,
    completeness: gen.completeness ?? null,
    pitfalls: gen.pitfalls || [],
    retrieval: gen.retrieval || null,
    scenes: gen.scenes || null,
    fallback: Boolean(gen.fallback),
    llmError: gen.llmError || null,
    model: gen.model || null,
    provider: gen.provider || null,
    createdAt: new Date(),
    generatedAt: new Date(),
    meta: { reissuedFor: order.orderId, reason: 'test-cleanup-mishap', noCharge: true },
  };
  const r = await db.collection('reports').insertOne(doc);
  await db.collection('audit_logs').insertOne({
    action: 'reports.reissue',
    actor: 'agent',
    detail: { reportId: String(r.insertedId), orderId: order.orderId, uid: order.uid, noCharge: true },
    createdAt: new Date(),
  });
  console.log(`已补发报告：${r.insertedId}`);
  console.log(`摘要：${String(doc.sections?.summary || doc.content).slice(0, 100)}`);
  console.log(`完整度：${doc.completeness} · 风险 ${(doc.sections?.risks || []).length} · 行动 ${(doc.sections?.actions || []).length} · 案例 ${(doc.sections?.cases || []).length}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ 补发失败：', err?.stack || err?.message || err);
  process.exit(1);
});
