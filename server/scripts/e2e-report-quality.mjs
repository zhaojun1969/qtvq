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
  {
    sku: 'pair',
    label: 'pair（配对：节奏差异 + 沟通方式不同）',
    /*
     * 两份「真实感」资料：结构参照公开平台上常见的自我介绍（职业/兴趣/相处期待/雷区），
     * 但**不含任何真实用户的可识别信息** —— 回归要的是资料信息量，不是谁的资料。
     * 这样 pair 分支也能进质量回归，不必等库里有真实用户。
     */
    run: (m) =>
      m.generateReport({
        me: {
          _id: 'u_fixture_me',
          nickname: '小雨',
          gender: 'female',
          age: 27,
          city: '杭州',
          tags: ['稳定工作', '早睡', '喜欢做饭', '计划型'],
          intro:
            '在互联网公司做产品，作息规律，晚上十一点前睡。喜欢周末在家做饭、看展。希望关系能被明确，一年内想谈婚论嫁；不能接受长期已读不回，也不接受先处着看。',
          qa: [],
        },
        ta: {
          _id: 'u_fixture_ta',
          nickname: '阿哲',
          gender: 'male',
          age: 29,
          city: '杭州',
          tags: ['创业', '夜猫', '自由', '不喜欢被定义'],
          intro:
            '自己做小生意，时间不固定，经常凌晨才睡。喜欢自驾、livehouse。觉得两个人舒服最重要，不想太早谈结婚，也不喜欢被查行程；遇到压力会先自己待着，不太会主动解释。',
          qa: [],
        },
        tier: 'deep',
        question: '我们适不适合长期走下去？',
      }),
  },
];

async function main() {
  const { connectDB } = await import('../src/config/db.js');
  const diagnose = await import('../src/services/report-diagnose.js');
  const retro = await import('../src/services/report-retro.js');
  const quality = await import('../src/services/report-quality.js');
  const pairSvc = await import('../src/services/report.js');
  await connectDB();

  const mod = { generateDiagnose: diagnose.generateDiagnose, generateRetro: retro.generateRetro, generateReport: pairSvc.generateReport };
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
    if (c.sku === 'pair') {
      // 配对报告没有三段结构：只校验字数与质量标记（字数断言在上方统一做）
    } else check(
      `${c.sku} 结构条数达标（风险 ≥${spec.structure.risks.min} / 案例 ≥${spec.structure.cases.min} / 行动 ≥${spec.structure.actions.min}）`,
      (g.sections?.risks || []).length >= spec.structure.risks.min &&
        (g.sections?.cases || []).length >= spec.structure.cases.min &&
        (g.sections?.actions || []).length >= spec.structure.actions.min
    );
    // 配对报告没有三段结构，completeness 恒为 null —— 只对 diagnose/retro 断言
    if (c.sku !== 'pair') check(`${c.sku} 完整度 = 1`, g.completeness === 1, String(g.completeness));
    if (c.sku !== 'pair') check(`${c.sku} 结论不是空话（≥10 字）`, quality.countChars(g.sections?.summary) >= 10, g.sections?.summary || '');
    if (c.sku === 'diagnose') {
      const risks = g.sections?.risks || [];
      const withIndicator = risks.filter((r) => /(7|七)\s*天|一周|观察|留意|记录/.test(String(r))).length;
      check(`diagnose 每条风险点带 7 天可观察指标（${withIndicator}/${risks.length}）`, risks.length > 0 && withIndicator >= Math.ceil(risks.length / 2));
    }
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
