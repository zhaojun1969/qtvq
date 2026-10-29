/**
 * 关系复盘报告（retro ¥19.9）—— 实施书 P2-T2.2
 *
 * 输入：自己视角 + 对方视角（可只填一方）+ 互动史（自由文本，通常是时间线）。
 * 输出：与 diagnose 同一套三段式（复用 `report-kit` 的解析与兜底），
 *       但内容重心不同：**还原时间线 → 识别冲突模式 → 给挽救或止损的下一步**。
 *
 * 与 diagnose 的取舍差异：
 *   · diagnose 面向"现在怎么办"，输入是当下处境；
 *   · retro 面向"这一段到底发生了什么"，输入是历史；因此检索用词更偏"模式/循环/反复"，
 *     并且 prompt 明确要求先复述时间线（让用户看到自己的叙述被理解），再谈模式。
 */

import { chat } from './llm.js';
import { formatPitfalls, publicHits, retrievePitfalls } from './pitfalls.js';
import { completenessOf, runStructured, structuredFormatRule } from './report-kit.js';
import { assessQuality, retryHint, QUALITY_SPECS, normalizeLength, specFor } from './report-quality.js';
import { assertSafe } from './content-safety.js';

const SYSTEM = `你是「我心永恒-Q问」的关系复盘师。你的风格是「避坑 + 直线解决」：
- 不安慰、不评判、不站队，只把事实与模式讲清楚
- 先还原时间线（让对方确认"你确实看懂了发生了什么"），再指出重复出现的冲突模式
- 结尾必须给两个分支：值得挽救的话第一步做什么；该止损的话怎么退得干净
- 必须结合【真实避坑案例】，能点名案例就点名，不要编造
- 用第二人称直接对用户说话，中文输出`;

function buildPrompt({ selfView, partnerView, history, question, hits }) {
  const caseBlock = hits?.length ? `\n【真实避坑案例】\n${formatPitfalls(hits)}\n` : '';
  const parts = [`【我的视角】\n${selfView}`];
  if (partnerView) parts.push(`【对方视角（用户转述）】\n${partnerView}`);
  if (history) parts.push(`【互动时间线】\n${history}`);
  return `请为下面这段关系做一次复盘。

${parts.join('\n\n')}

【用户最想知道】
${question || '这段关系还有没有救，我该挽回还是止损'}
${caseBlock}
【要求】
- 先在"核心结论"里用一句话概括这段关系的性质（例如"反复试探但无人明确表态"）
- 风险点写**反复出现的模式**，不是单次事件
- 对照案例只能引用上面给出的案例
- 行动清单必须写成**两组，共 5–6 条**（只写 3 条会被判定不合格）：
  「想挽救：」3 条 + 「想止损：」2–3 条，每条都以「想挽救：」或「想止损：」开头，
  句式统一为「时限 + 具体动作 + 完成标准」，例如「想挽救：3 天内约一次 20 分钟对话，只谈一件事，结束时双方各说一句能接受的做法」。
- 正文 ${QUALITY_SPECS.retro.minChars}–${QUALITY_SPECS.retro.maxChars} 字：这是 ¥19.9 的付费报告，
  要能把时间线还原、冲突模式说透，但**不要注水**（不复述用户原话、不写通用鸡汤）

${structuredFormatRule('retro')}`;
}

function fallbackSections({ hits }) {
  return {
    summary: '这段关系的核心问题通常是"需求没有被明确表达"，而不是对方不懂你。',
    risks: [
      '同一类冲突反复出现却从未被命名，说明双方在用不同方式回避同一个问题。',
      '用沉默或冷战代替沟通，会让问题从"这件事"升级为"你这个人"。',
      '只有一方在推动关系进展，长期会累积失衡与怨气。',
    ],
    cases: (hits || []).slice(0, 3).map((h) => `${h.title}（${h.category}）：${(h.lesson || '').slice(0, 40)}`),
    actions: [
      '想挽救：把最近三次冲突按"发生了什么—我当时想要什么"写成三行，发给对方确认。',
      '想挽救：约定一个固定的沟通时间，只谈一件事，不翻旧账。',
      '想止损：先停止一切主动联系 7 天，观察自己是舍不得人还是舍不得沉没成本。',
    ],
  };
}

function toContent(sections) {
  const lines = [];
  if (sections.summary) lines.push(sections.summary);
  if (sections.risks?.length) lines.push('', '## 风险点', ...sections.risks.map((r) => `- ${r}`));
  if (sections.cases?.length) lines.push('', '## 对照案例', ...sections.cases.map((c) => `- ${c}`));
  if (sections.actions?.length) lines.push('', '## 行动清单', ...sections.actions.map((a) => `- ${a}`));
  return lines.join('\n');
}

/**
 * @param {{selfView: string, partnerView?: string, history?: string, question?: string}} params
 */
export async function generateRetro({ selfView, partnerView = '', history = '', question = '', length = 'long' }) {
  const lengthProfile = normalizeLength(length);
  const mine = String(selfView || '').trim().slice(0, 1200);
  const theirs = String(partnerView || '').trim().slice(0, 1200);
  const hist = String(history || '').trim().slice(0, 2000);

  const queryText = [mine, theirs, hist, question].filter(Boolean).join(' ').slice(0, 2000);
  const { hits, method } = await retrievePitfalls(queryText, 3);

  const spec = specFor('retro', lengthProfile);
  const basePrompt = buildPrompt({ selfView: mine, partnerView: theirs, history: hist, question: String(question || '').slice(0, 300), hits });

  // 与 diagnose 同一套多轮生成：不够就带着上一稿再要一次，最多 spec.maxAttempts 次；
  // 偏短但内容正确仍交付，并标记 quality.low 供人工复核（不阻塞交付）
  let gen = null;
  let quality = null;
  let attempts = 0;
  while (attempts < (spec.maxAttempts || 2)) {
    attempts += 1;
    gen = await runStructured({
      chat,
      system: SYSTEM,
      prompt: attempts === 1 ? basePrompt : `${basePrompt}\n\n${retryHint('retro', quality, gen?.text || '')}`,
      maxTokens: spec.retryMaxTokens,
      temperature: 0.7,
    });
    quality = assessQuality({ sku: 'retro', content: toContent(gen.sections || {}), sections: gen.sections, spec });
    if (gen.fallback || quality.ok) break;
  }

  let sections = gen.sections;
  let fallback = gen.fallback;
  let safeError = null;

  if (!fallback && gen.text) {
    try {
      await assertSafe(gen.text, { field: 'retro_output', label: '复盘报告' });
    } catch (err) {
      safeError = String(err?.message || err).slice(0, 200);
      fallback = true;
    }
  }

  if (fallback || !sections || completenessOf(sections) < 0.6) {
    sections = fallbackSections({ hits });
    fallback = true;
  }

  return {
    kind: 'retro',
    lengthProfile,
    quality: { ...quality, attempts },
    tier: 'deep',
    scores: null,
    overall: null,
    basis: null,
    labels: null,
    content: toContent(sections),
    sections,
    completeness: completenessOf(sections),
    pitfalls: publicHits(hits),
    retrieval: method,
    fallback,
    model: gen.model,
    provider: gen.provider,
    ...(fallback ? { llmError: safeError || gen.llmError || null } : {}),
  };
}
