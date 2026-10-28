/**
 * 指标聚合 CLI（实施书 P4-T4.1）
 *
 * 每日由 systemd timer 调一次（见 deploy/hardening/systemd/qtvq-metrics.*），
 * 也可以手工补算历史上任何一天。
 *
 * 跑法：
 *   cd /opt/qtvq/server && node --env-file=.env scripts/aggregate-metrics.mjs            # 重算最近 3 天
 *   ... aggregate-metrics.mjs --days=30                                                 # 重算最近 30 天
 *   ... aggregate-metrics.mjs --day=2026-10-01                                          # 只重算某一天
 *   ... aggregate-metrics.mjs --verdict                                                 # 只打印 90 天验收门
 *   ... aggregate-metrics.mjs --days=7 --json                                           # 机器可读
 *
 * 为什么默认重算 3 天而不是 1 天：埋点走 sendBeacon，跨零点批量上报很常见；
 * 昨天、前天的数字今天还可能变。重算是幂等的（按天 upsert），多算几天不花什么钱。
 */
import process from 'node:process';

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

async function main() {
  const { connectDB } = await import('../src/config/db.js');
  // 单跑脚本必须显式 connectDB；只有 app.js 启动时才自动连
  await connectDB();
  const metrics = await import('../src/services/metrics.js');

  const wantJson = Boolean(arg('json', false));
  const onlyVerdict = Boolean(arg('verdict', false));
  const day = arg('day', null);
  const days = Number(arg('days', 3)) || 3;

  if (day && !DAY_RE.test(String(day))) {
    console.error(`❌ --day 需要 YYYY-MM-DD，收到 ${day}`);
    process.exit(2);
  }

  // --json 只输出**一份**文档：早先分两次 console.log 打 {rows} 和 {gate}，
  // `--json | jq` 读到第一个对象就结束，gate 永远拿不到
  const out = { ok: true };

  if (!onlyVerdict) {
    const rows = day ? [await metrics.aggregateDay(String(day))] : await metrics.aggregateRange({ days });
    out.rows = rows;
    if (!wantJson) {
      console.log(`聚合完成：${rows.length} 天`);
      for (const r of rows) {
        const d1 = r.d1Retained == null ? '待定' : `${r.d1Retained}/${r.d1Eligible}（${((r.d1Rate || 0) * 100).toFixed(1)}%）`;
        console.log(
          `  ${r.date}  新增 ${r.newUsers}  激活 ${r.activated}  次日留存 ${d1}  报告浏览 ${r.reportViews}  付费单 ${r.reportPaid}（0元 ${r.zeroPaid}）  实收 ¥${(r.revenueFen / 100).toFixed(2)}  分享 ${r.shareGenerated}→${r.shareLanding}  落地 ${r.landingViews}`,
        );
      }
    }
  }

  const gate = await metrics.acceptanceGate({ days: metrics.GATE.windowDays });
  out.gate = gate;
  if (wantJson) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    const label = { passed: '✅ 通过', failed: '❌ 不达标', insufficient: '⏳ 数据不足，不下结论' }[gate.status];
    console.log(`\n90 天验收门：${label}`);
    if (gate.reasons.length) console.log(`  原因：${gate.reasons.join('；')}`);
    for (const c of gate.checks) {
      const mark = c.ok === null ? '·' : c.ok ? '✅' : '❌';
      const val = c.value == null ? '—' : `${(c.value * 100).toFixed(1)}%`;
      console.log(`  ${mark} ${c.label}：${val}（门槛 ${(c.threshold * 100).toFixed(1)}%）· ${c.detail}`);
    }
    console.log(`  覆盖 ${gate.coverage} 天 · 激活 ${gate.activated} 人 · 付费 ${gate.converted} 人`);
  }

  // 连接池会让事件循环常驻，不显式退出脚本会"跑完了却不结束"
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ 聚合失败：', err?.stack || err?.message || err);
  process.exit(1);
});
