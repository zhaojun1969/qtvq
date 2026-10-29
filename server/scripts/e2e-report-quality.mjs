/**
 * 报告内容质量验收（付费商品口径）
 *
 * 为什么需要它：
 *   2026-10-29 真实付费 ¥9.90 拿到的诊断报告只有 265 字 —— 结构对、完整度 1，但每条
 *   风险点被压到 40 字以内，是提纲不是报告。根因是 `report-kit.js` 里一条**全局**格式
 *   规则（「每条不超过 40 字，最多 5 条」），它本来是给分享卡文案定的。
 *
 *   修法两条：按 SKU 下发字数/条数规格（`services/report-quality.js::QUALITY_SPECS`），
 *   以及"太短就带着上一稿再要一次"的扩写重试。这个脚本验证这两条真的生效：
 *   不是看"有没有报错"，而是量字数与结构条数，并要求 `quality.ok === true`。
 *
 * 跑法（服务器，会真的调模型，每次 1–2 次调用）：
 *   cd /opt/qtvq/server && sudo node --env-file=.env scripts/e2e-report-quality.mjs
 *   ... --quick    # 只跑 diagnose 一例
 *
 * 退出码：0 全过；1 有断言失败。
 */
import process from 'node:process';

const QUICK = process.argv.includes('--quick');
let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}

const CASES = [
  {
    sku: 'diagnose',
    label: 'diagnose（暧昧 + 冷暴力）',
    run: (m) =>
      m.generateDiagnose({
        description: '我们认识三个月，他从不主动约我，但只要我开口他都会答应。最近两周已读不回超过 72 小时，我一直在等一个解释，也不敢问。',
        scenes: ['ambiguous', 'cold'],
        question: '他到底想不想认真？',
      }),
  },
  {
    sku: 'retro',
    label: 'retro（异地 + 反复争吵）',
    run: (m) =>
      m.generateRetro({
        selfView: '我总觉得自己在追着一段关系跑，每次争执后都是我主动去修，久了我开始怀疑是不是我太敏感。',
        partnerView: '他觉得我要求太多、动不动就谈"以后"，他更想活在当下，不想被定义。',
        history: '第一年热恋，第二年异地，第三年他工作变动开始冷下来，最近半年每月至少爆发一次同样的争吵。',
        question: '这段关系还值得挽救吗？',
      }),
  },
];

async function main() {
  const { connectDB } = await import('../src/config/db.js');
  const diagnose = await import('../src/services/report-diagnose.js');
  const retro = await import('../src/services/report-retro.js');
  const quality = await import('../src/services/report-quality.js');
  await connectDB();

  const mod = { generateDiagnose: diagnose.generateDiagnose, generateRetro: retro.generateRetro };
  const cases = QUICK ? CASES.filter((c) => c.sku === 'diagnose') : CASES;

  console.log('\n=== 报告内容质量验收（付费口径）===');
  for (const c of cases) {
    const spec = quality.QUALITY_SPECS[c.sku];
    console.log(`\n【${c.label}】目标 ${spec.minChars}–${spec.maxChars} 字`);
    const started = Date.now();
    const g = await c.run(mod);
    const chars = quality.countChars(g.content);
    const q = g.quality || {};
    console.log(`  实测 ${chars} 字 · 风险 ${(g.sections?.risks || []).length} / 案例 ${(g.sections?.cases || []).length} / 行动 ${(g.sections?.actions || []).length} · 重试 ${q.attempts ?? '?'} 次 · 耗时 ${Math.round((Date.now() - started) / 1000)}s`);

    check(`${c.sku} 不是兜底文案（fallback=false）`, g.fallback === false, `fallback=${g.fallback} llmError=${g.llmError || ''}`);
    check(`${c.sku} 字数落在 ${spec.minChars}–${spec.maxChars}`, chars >= spec.minChars && chars <= spec.maxChars, `实际 ${chars} 字`);
    check(`${c.sku} quality.ok = true`, q.ok === true, JSON.stringify(q.reasons || q));
    check(
      `${c.sku} 结构条数达标（风险 ≥${spec.structure.risks.min} / 案例 ≥${spec.structure.cases.min} / 行动 ≥${spec.structure.actions.min}）`,
      (g.sections?.risks || []).length >= spec.structure.risks.min &&
        (g.sections?.cases || []).length >= spec.structure.cases.min &&
        (g.sections?.actions || []).length >= spec.structure.actions.min
    );
    check(`${c.sku} 完整度 = 1`, g.completeness === 1, String(g.completeness));
    check(`${c.sku} 结论不是空话（≥10 字）`, quality.countChars(g.sections?.summary) >= 10, g.sections?.summary || '');
    // 重试次数必须受规格约束（diagnose 2 次、retro 3 次），防止守卫在死循环里烧钱
    check(`${c.sku} 重试次数不超过规格上限`, (q.attempts ?? 1) <= (spec.maxAttempts || 2), `${q.attempts} > ${spec.maxAttempts || 2}`);
  }

  console.log(`\n通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ 质量验收异常：', err?.stack || err?.message || err);
  process.exit(1);
});
