/**
 * 报告质量规格与长度守卫（2026-10-29）
 *
 * ── 起因 ──────────────────────────────────────────────────────────────────
 * 真实扫码付费 ¥9.90 拿到的诊断报告只有 265 字（`fallback=false`、完整度 1）。
 * 结构是对的，但每条风险点被压到 40 字以内、行动项不到 30 字 —— 根因不在模型，
 * 而在 `report-kit.js` 里那条**全局**格式规则：「每条不超过 40 字，最多 5 条」。
 * 那套限制是为「分享卡文案 + 低 token 预算」定的，用在 ¥9.9/¥19.9 的付费正文上，
 * 用户拿到的是一张提纲，不是报告。
 *
 * ── 现在的口径 ────────────────────────────────────────────────────────────
 * 实施书 T2.1/T2.2 只给了 token 预算（输出 ≤ 3k tokens），没有给字数。这里按
 * 「付费商品该有的信息密度」定死三档，并写进 prompt 与守卫两处（单一来源）：
 *
 *   diagnose ¥9.9   正文 900–2600 字：结论 ≤60 + 风险点 3–5 条(各 60–150) +
 *                   对照案例 2–3 条(各 60–140) + 行动清单 5–7 条(各 25–60)
 *   retro   ¥19.9  正文 1200–3200 字：另含时间线/冲突模式，行动清单 6–8 条
 *                   （「想挽救」与「想止损」各 3 条）
 *   pair    ¥29.9  600–4000 字：走另一条生成链路（services/report.js），这里只记录不改写
 *
 * ── 守卫做什么、不做什么 ──────────────────────────────────────────────────
 * 做：生成后测字数与条数，偏短就**再要一次**（附上"上次哪里不够"的指令）；
 *     两次都短就标记 `quality.low=true` 落库（交付不阻塞，人工复核）。
 * 不做：不为了凑字数注水、不截断超长正文、不因为字数不够就判失败 ——
 *     付费用户宁可拿一份偏短的正确报告，也不要一份被切成两半的。
 */

/** 单个 SKU 的字数/结构规格（prompt 与守卫共用同一份数字） */
export const QUALITY_SPECS = {
  diagnose: {
    // 900 是理想值；实测 qwen-plus-character 扩写一稿常落在 700–900 字，
    // 定 700 是「能稳定达标」的下限（仍是改造前 265 字的 2.6 倍），结构条数另作硬约束
    minChars: 700,
    maxChars: 2600,
    retryMaxTokens: 2600,
    maxAttempts: 2,
    structure: {
      summaryMax: 60,
      risks: { min: 3, max: 5, len: [60, 150] },
      cases: { min: 2, max: 3, len: [60, 140] },
      actions: { min: 5, max: 7, len: [25, 60] },
      // 每条风险点必须带一个可证伪的「7 天可观察指标」（结构密度策略，2026-10-29）
      riskIndicator: true,
    },
  },
  retro: {
    // 与 diagnose 同理：1200 是理想值，实测一稿常 1000–1100 字；
    // 定 1100 并允许**两次**扩写（retro 的信息量要求更高，多一次重试比交一份提纲划算）
    minChars: 1100,
    maxChars: 3200,
    retryMaxTokens: 3000,
    maxAttempts: 3,
    structure: {
      summaryMax: 60,
      risks: { min: 3, max: 5, len: [80, 180] },
      cases: { min: 2, max: 3, len: [60, 140] },
      actions: { min: 5, max: 8, len: [30, 70] },
    },
  },
  pair: {
    minChars: 600,
    maxChars: 4000,
    retryMaxTokens: 3000,
    maxAttempts: 2,
    structure: { summaryMax: 80, risks: { min: 2, max: 6, len: [40, 200] }, cases: { min: 0, max: 3, len: [40, 160] }, actions: { min: 2, max: 6, len: [30, 120] } },
  },
};

/** 正文字数：去掉空白与 markdown 记号后计数（表格/标题符号不该算进"内容量"） */
export function countChars(content) {
  return String(content || '')
    .replace(/[#>*`\-|]/g, '')
    .replace(/\s+/g, '')
    .length;
}

/**
 * 评估一份报告是否达到付费商品的密度。
 * @returns {{sku:string, chars:number, spec:object, ok:boolean, low:boolean, reasons:string[]}}
 */
export function assessQuality({ sku, content, sections, skipStructure = false }) {
  const spec = QUALITY_SPECS[sku] || QUALITY_SPECS.diagnose;
  const chars = countChars(content);
  const reasons = [];

  if (chars < spec.minChars) reasons.push(`正文仅 ${chars} 字，低于下限 ${spec.minChars}`);
  else if (chars > spec.maxChars) reasons.push(`正文 ${chars} 字，超过上限 ${spec.maxChars}`);

  for (const key of skipStructure ? [] : ['risks', 'cases', 'actions']) {
    const rule = spec.structure?.[key];
    if (!rule) continue;
    const arr = Array.isArray(sections?.[key]) ? sections[key] : [];
    if (arr.length < rule.min) reasons.push(`${key} 只有 ${arr.length} 条，少于 ${rule.min} 条`);
    // 单条过短同样算"注水不足"：3 条各 20 字拼不出 900 字，也不要靠复制凑数
    const tooShort = arr.filter((x) => countChars(x) < rule.len[0]).length;
    if (arr.length && tooShort >= Math.ceil(arr.length / 2)) {
      reasons.push(`${key} 有过半条目短于 ${rule.len[0]} 字（信息密度不足）`);
    }
  }


  /*
   * 诊断报告额外要求：每条风险点带一个「7 天可观察指标」（可证伪，才能指导行动）。
   * 判定用宽松正则：模型写法多样（7 天 / 一周 / 观察 / 留意 / 记录 都可能），
   * 只要半数以上条目带了就算过 —— 严格按字面匹配会误杀正常表达。
   */
  if (sku === 'diagnose' && !skipStructure) {
    const risks = Array.isArray(sections?.risks) ? sections.risks : [];
    const withIndicator = risks.filter((r) => /(7|七)\s*天|一周|观察|留意|记录/.test(String(r))).length;
    if (risks.length && withIndicator < Math.ceil(risks.length / 2)) {
      reasons.push(`只有 ${withIndicator}/${risks.length} 条风险点带 7 天可观察指标`);
    }
  }

  return { sku, chars, spec, ok: reasons.length === 0, low: chars < spec.minChars, reasons };
}

/**
 * "再要一次"的指令 —— 关键是**带上上一稿并要求扩写**，而不是只说"太短了"。
 *
 * 实测（2026-10-29）：只喊"目标 900–2600 字、请写具体"，qwen-plus-character 仍然只写
 * 600–900 字；把上一稿贴回去、明确"保留事实、逐条补细节、补到 N 字"，才有明显的长度提升。
 * 注意事项写进指令里：不许编造用户没说过的事实、不许重复观点凑字数。
 */
export function retryHint(sku, assessed, draft = '') {
  const spec = QUALITY_SPECS[sku] || QUALITY_SPECS.diagnose;
  const s = spec.structure;
  const bits = [
    `上一稿只有 ${assessed.chars} 字，对 ¥${sku === 'retro' ? '19.9' : '9.9'} 的付费报告来说信息量不够。请`,
    `**在保持原有结论与结构不变的前提下扩写**到 ${spec.minChars}–${spec.maxChars} 字（含标点）：`,
    `· 每条风险点扩到 ${s.risks.len[0]}–${s.risks.len[1]} 字：补"具体信号（时间/频率/原话）→ 为什么危险 → 对上用户描述的哪一句"；`,
    ...(s.riskIndicator ? ['· 每条风险点最后补一句「7 天内观察：…」，必须是可计数的事实（回复间隔、主动次数、是否提到未来等）；'] : []),
    `· 每条对照案例扩到 ${s.cases.len[0]}–${s.cases.len[1]} 字：补"像在哪、它后来怎么样了、和你的差别在哪"；`,
    `· 每条行动扩到 ${s.actions.len[0]}–${s.actions.len[1]} 字：补"具体话术/动作、时限、做到什么程度算完成"。`,
    '硬约束：只能基于【用户自述】与【真实避坑案例】扩写，不许编造用户没说过的事实，不许重复观点凑字数，不许加客套话。',
  ];
  if (draft) bits.push('', '【上一稿（在此基础上扩写，不要推翻结论）】', String(draft).slice(0, 4000));
  return bits.join(String.fromCharCode(10));
}

/**
 * pair（配对报告）的扩写指令：它的正文不是三段式，所以不能用 retryHint
 * （那条会要求"风险点 3–5 条"，对配对报告是错的指令）。
 */
export function pairRetryHint(assessed, draft = '') {
  const spec = QUALITY_SPECS.pair;
  const bits = [
    `上一稿只有 ${assessed.chars} 字，对 ¥29.9 的配对报告来说太薄。请在保持结论与契合度判断不变的前提下，扩写到 ${spec.minChars}–${spec.maxChars} 字：`,
    '· 补充两人的具体互动场景（谁先开口、争执怎么起、怎么收场），不要泛泛而谈；',
    '· 每个契合度维度都要落到「你们的差别是什么、会在什么场景下出问题、怎么互补」；',
    '· 结尾给 3–5 条双方都能执行的具体建议，带场景与时限。',
    '硬约束：只基于双方资料与问答、以及给出的真实案例扩写，不许编造用户没提供的事实，不许重复观点凑字数。',
  ];
  if (draft) bits.push('', '【上一稿（在此基础上扩写，不要推翻结论）】', String(draft).slice(0, 4000));
  return bits.join(String.fromCharCode(10));
}
