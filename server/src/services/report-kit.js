/**
 * 结构化报告的共用骨架（2026-10-27 · 实施书 P2-T2.1/T2.2）
 *
 * diagnose（避坑诊断）与 retro（关系复盘）虽然 prompt 不同，但**生成流程完全一样**：
 *   检索真实避坑案例 → 拼 prompt → 调模型 → 按三段结构解析 → 解析失败就用确定性兜底。
 * 把这段抽出来，两个生成器只负责"提示词与兜底文案"，避免两份代码各自漂移。
 *
 * ── 为什么坚持「结构化 + 可解析」而不是让模型自由发挥 ─────────────────────
 * 报告要落地成分享卡（T2.4）：一句核心结论 + 三条行动清单。
 * 如果正文是一整段散文，卡片就得再让模型总结一次 —— 又多一次调用、又多一次不确定性。
 * 所以这里强制三段式输出，模型不听话时用 `parseSections()` 兜底切分，
 * 再不行就用规则生成的确定性内容。**任何情况下都不返回 500**。
 */

import { QUALITY_SPECS } from './report-quality.js';

/** 从模型输出里抠出三段：风险点 / 对照案例 / 行动清单 */
const SECTION_ALIASES = {
  risks: ['风险点', '风险', '隐患', '坑在哪'],
  cases: ['对照案例', '相关案例', '参考案例', '案例'],
  actions: ['行动清单', '行动建议', '下一步', '该怎么做'],
};
function normalizeHeading(line) {
  // 去掉 markdown 装饰与序号：`## 一、风险点：` → `风险点`
  return String(line || '')
    .replace(/^[#>\s*-]+/, '')
    .replace(/^\d+[.、)）]\s*/, '')
    .replace(/^[一二三四五六七八九十]+[、.)）]\s*/, '')
    .replace(/[*_`]/g, '')
    .replace(/[:：]\s*$/, '')
    .trim();
}

/**
 * 判断一层标题属于哪一段。
 *
 * **必须严格**：历史上这里用 `h.includes(alias)` 做过模糊匹配，结果任何
 * "……案例……" 的正文行都被当成标题吞掉（"冷暴力案例（冷暴力）：已读不回 72 小时"
 * 整条消失，cases 恒为空）。现在只接受：
 *   · 完全等于别名                     → `风险点`
 *   · 以别名开头/结尾且只多 4 个字以内 → `风险点1`、`核心风险点`、`行动清单（5条）`
 * 正文行不会再被误判。
 */
function matchSection(heading) {
  const h = String(heading || '').toLowerCase().replace(/\s+/g, '');
  if (!h) return null;
  for (const [key, aliases] of Object.entries(SECTION_ALIASES)) {
    for (const a of aliases) {
      if (h === a) return key;
      if (h.length <= a.length + 4 && (h.startsWith(a) || h.endsWith(a))) return key;
    }
  }
  return null;
}

/** 这一行是否长得像分段标题（而不是段内正文） */
function headingKeyOf(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;
  const isMarkdown = /^#{1,4}\s/.test(trimmed);
  const cleaned = trimmed.replace(/^[#>\s]+/, '').replace(/[*_`]/g, '').trim();
  const endsWithColon = /[:：]\s*$/.test(cleaned);
  const norm = normalizeHeading(trimmed);
  const key = matchSection(norm);
  if (!key) return null;
  const exact = Object.values(SECTION_ALIASES).flat().includes(norm.toLowerCase());
  // 形似标题才认：markdown 标题 / 结尾冒号 / 整行就是别名本身
  return isMarkdown || endsWithColon || exact ? key : null;
}

function toItems(lines) {
  return lines
    .map((l) => String(l || '').replace(/^\s*[-*·•]\s*/, '').replace(/^\s*\d+[.、)）]\s*/, '').trim())
    .filter(Boolean);
}

/**
 * 把模型正文解析成三段。
 *
 * @returns {{ risks: string[], cases: string[], actions: string[], summary: string }}
 */
export function parseSections(text) {
  const raw = String(text || '').trim();
  if (!raw) return { risks: [], cases: [], actions: [], summary: '' };

  const lines = raw.split('\n');
  const buckets = { risks: [], cases: [], actions: [] };
  let current = null;
  let summaryLine = '';
  let sawHeading = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const key = headingKeyOf(trimmed);
    if (key) {
      current = key;
      sawHeading = true;
      continue;
    }
    // 开头的第一句非标题内容，当作"核心结论"
    if (!current && !summaryLine) {
      summaryLine = trimmed.replace(/^\*\*|\*\*$/g, '').trim();
      continue;
    }
    if (current) buckets[current].push(trimmed);
  }

  const out = {
    risks: toItems(buckets.risks).slice(0, 6),
    cases: toItems(buckets.cases).slice(0, 5),
    actions: toItems(buckets.actions).slice(0, 6),
    summary: summaryLine.slice(0, 120),
  };

  /*
   * 模型没按格式写（整段散文、一个小标题都没有）时的兜底：
   * 取前三句当风险点、后三句当行动，至少保证页面不会空白。
   *
   * 注意只在 `!sawHeading` 时兜底：如果模型给了 `## 风险点` 却只写了这一段，
   * 那是**真的缺段**，要如实反映到完整度上（否则缺段会被兜底填满，
   * 完整度永远 ≥0.77，验收就失去意义）。
   */
  if (!sawHeading) {
    const sentences = raw
      .split(/(?<=[。！？\n])/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 6);
    out.risks = sentences.slice(0, 3);
    out.actions = sentences.slice(-3);
    if (!out.summary) out.summary = sentences[0]?.slice(0, 120) || '';
  }
  return out;
}

/**
 * 结构化输出是否"够完整"。用于验收（≥0.9）与决定是否判为兜底。
 *
 * 三段齐全（各至少 1 条）算满分；缺一段扣 1/3；summary 缺失再扣 0.1。
 */
export function completenessOf(sections) {
  const has = (arr) => Array.isArray(arr) && arr.length > 0;
  let score = 0;
  if (has(sections?.risks)) score += 1 / 3;
  if (has(sections?.cases)) score += 1 / 3;
  if (has(sections?.actions)) score += 1 / 3;
  if (sections?.summary) score += 0.1;
  return Math.min(1, Number(score.toFixed(2)));
}

/**
 * 三段式输出的格式要求（拼进 prompt）。
 *
 * 2026-10-29 修正：原来这里是一条**全局**规则 ——「每条不超过 40 字，最多 5 条」。
 * 它是按"分享卡文案 + 低 token 预算"定的，却被用在 ¥9.9/¥19.9 的付费正文上，
 * 结果真实付费用户拿到的诊断报告只有 265 字（每条风险点 20–40 字），是提纲不是报告。
 * 现在按 SKU 分别下发（数字与 `report-quality.js::QUALITY_SPECS` 同一份，不各写一套）。
 */
export function structuredFormatRule(sku = 'diagnose') {
  const s = QUALITY_SPECS[sku]?.structure || QUALITY_SPECS.diagnose.structure;
  return `【输出格式（必须严格遵守，不要加任何前言或结尾客套）】
第一行：一句话核心结论（不超过 ${s.summaryMax} 字，直接点出关系性质或最大风险）
## 风险点
- ${s.risks.min}–${s.risks.max} 条，每条 ${s.risks.len[0]}–${s.risks.len[1]} 字。每条按「具体信号（时间/频率/原话/频率）→ 为什么危险 → 对上你描述里的哪一句」来写
## 对照案例
- ${s.cases.min}–${s.cases.max} 条，每条 ${s.cases.len[0]}–${s.cases.len[1]} 字，必须点名上面给出的真实案例，并写清「你们像在哪、它后来怎么样了」
## 行动清单
- ${s.actions.min}–${s.actions.max} 条，每条 ${s.actions.len[0]}–${s.actions.len[1]} 字，只写用户单方面能做的动作，带时限（今天 / 3 天内 / 7 天内）与完成标准`;
}

/** 兼容旧引用：默认按 diagnose 下发 */
export const STRUCTURED_FORMAT_RULE = structuredFormatRule('diagnose');

/**
 * 调模型并解析三段。模型不可用时返回 `fallback` 标记，由调用方给确定性文案。
 *
 * @param {{ chat, system, prompt, maxTokens, temperature }} args
 * @returns {Promise<{ text: string|null, sections: object|null, fallback: boolean, model: any, provider: any, llmError: string|null }>}
 */
export async function runStructured({ chat, system, prompt, maxTokens = 1600, temperature = 0.7 }) {
  const result = await chat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    temperature,
    maxTokens,
  });

  if (!result?.text) {
    return {
      text: null,
      sections: null,
      fallback: true,
      model: result?.model || null,
      provider: result?.provider || null,
      llmError: result?.error || null,
    };
  }

  const text = String(result.text).trim();
  return {
    text,
    sections: parseSections(text),
    fallback: false,
    model: result.model,
    provider: result.provider,
    llmError: null,
  };
}
