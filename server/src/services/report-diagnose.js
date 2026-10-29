/**
 * 避坑诊断报告（diagnose ¥9.9，首单 ¥4.9）—— 实施书 P2-T2.1
 *
 * 输入：用户用自己的话描述处境 + 场景标签（可多选）+ 可选的"最想知道什么"。
 * 输出：**三段式** —— 风险点 / 对照案例 / 行动清单 + 一句核心结论。
 *
 * ── 与配对报告（services/report.js）的关键差异 ────────────────────────────
 * 配对报告有两位用户的资料，契合度由 `dimensions.js` 确定性算出，模型只写正文。
 * 诊断报告**没有第二个用户**、也没有可算的分数，全部内容都来自"用户描述 + 真实案例库"：
 *   · 所以分数相关字段一律为 null（前端不能拿它去渲染契合度）；
 *   · 唯一硬事实是**检索到的真实案例**——这也是它比通用大模型回答值钱的地方：
 *     案例库里是平台自己沉淀的 50 条避坑案例，模型只负责挑与对应。
 *
 * ── 安全 ──────────────────────────────────────────────────────────────────
 * 用户描述属于用户生成内容（可能有辱骂/自伤表述）：
 *   入参在路由层走 `content-safety.assertSafe`；
 *   出参在这里再过一次 `assertSafe`（模型可能回吐不当内容），失败则降级为兜底文案。
 */

import { chat } from './llm.js';
import { formatPitfalls, publicHits, retrievePitfalls } from './pitfalls.js';
import { completenessOf, runStructured, structuredFormatRule } from './report-kit.js';
import { assessQuality, retryHint, QUALITY_SPECS, normalizeLength, specFor } from './report-quality.js';
import { assertSafe } from './content-safety.js';

const SYSTEM = `你是「我心永恒-Q问」的避坑诊断师。你的风格是「避坑 + 直线解决」：
- 不说鸡汤，不给模糊安慰，不评判用户
- 先给结论，再给具体到"今天就能做"的动作
- 必须结合【真实避坑案例】说话，能点名案例就点名，不要编造案例
- 不诊断精神疾病，不替代心理咨询；遇到自伤/暴力倾向时明确建议寻求专业帮助
- 用第二人称直接对用户说话，中文输出`;

/** 场景标签：前端传多选，这里只做白名单收敛，避免被注入长文本 */
export const DIAGNOSE_SCENES = {
  ambiguous: '暧昧期/关系未定义',
  cold: '冷暴力/已读不回',
  money: '涉及金钱往来',
  long_distance: '异地/长期见不到',
  parents: '见家长/彩礼',
  breakup: '分手/复合',
  affair: '怀疑出轨',
  online: '网恋/未见面',
};

export function normalizeScenes(input) {
  const arr = Array.isArray(input) ? input : input ? [input] : [];
  return arr.map((s) => String(s).trim()).filter((s) => DIAGNOSE_SCENES[s]).slice(0, 4);
}

function buildPrompt({ description, scenes, question, hits }) {
  const sceneLine = scenes.length ? scenes.map((s) => DIAGNOSE_SCENES[s]).join('、') : '未标注';
  const caseBlock = hits?.length ? `\n【真实避坑案例】\n${formatPitfalls(hits)}\n` : '';
  return `请为下面这位用户做一次处境诊断。

【用户自述】
${description}

【场景标签】
${sceneLine}

【用户最想知道】
${question || '我现在最大的风险是什么，接下来该怎么做'}
${caseBlock}
【要求】
- 风险点要具体到"什么行为/什么信号"，不要写"可能有问题"这类废话
- **每条风险点最后必须给一个「7 天可观察指标」**：写成「7 天内观察：…」的形式，
  必须是看得见、可计数的（例如回复间隔、主动发起次数、提到未来时长的表述），
  不要写"观察他是否在乎你"这种无法证伪的话
- 对照案例只能引用上面给出的案例，不要自己发明
- 行动清单必须是用户单方面能做的（不依赖对方配合）
- 正文 ${QUALITY_SPECS.diagnose.minChars}–${QUALITY_SPECS.diagnose.maxChars} 字：这是 ¥9.9 的付费报告，
  信息密度要够，但**不要注水**（不复述用户原话、不写通用鸡汤、不为凑字数重复观点）

${structuredFormatRule('diagnose')}`;
}

/** 模型不可用：仍然基于真实案例给确定性报告，绝不 500 */
function fallbackSections({ scenes, hits }) {
  const risks = [];
  if (scenes.includes('money')) risks.push('涉及金钱往来时，先确认对方身份可核实（视频、共同好友、线下见面），未核实前不转账。');
  if (scenes.includes('cold')) risks.push('持续已读不回超过 72 小时，属于明确的沟通拒绝，继续追问只会加剧失衡。');
  if (scenes.includes('online')) risks.push('未线下见面的关系无法验证真实性，任何投资、借贷、代付都要先拒绝。');
  if (scenes.includes('ambiguous')) risks.push('关系长期不定义，实质是对方保留选择权；用时间换承诺是亏的。');
  if (!risks.length) risks.push('先把你观察到的具体行为写下来（时间、原话、频率），再判断是模式还是偶发。');

  const cases = (hits || []).slice(0, 3).map((h) => `${h.title}（${h.category}）：${(h.lesson || '').slice(0, 40)}`);
  const actions = [
    '今天写下三条你不能接受的行为底线，越具体越好。',
    '用一句不带指责的话提出你的需求，并给一个明确期限。',
    '把这次沟通的结果告诉一个可信的朋友，避免只在自己的判断里循环。',
  ];
  const summary = cases.length ? '先对照真实案例看模式，再用一次明确沟通试探对方意愿。' : '先把事实写清楚，再决定投入还是止损。';
  return { summary, risks, cases, actions };
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
 * @param {{description: string, scenes?: string[], question?: string}} params
 * @returns {Promise<object>} 与 generateReport 同构的返回（分数类字段为 null）
 */
export async function generateDiagnose({ description, scenes = [], question = '', length = 'long' }) {
  const lengthProfile = normalizeLength(length);
  const scenesNorm = normalizeScenes(scenes);
  const desc = String(description || '').trim().slice(0, 1200);

  const queryText = [desc, scenesNorm.map((s) => DIAGNOSE_SCENES[s]).join(' '), question].filter(Boolean).join(' ');
  const { hits, method } = await retrievePitfalls(queryText, 3);

  const spec = specFor('diagnose', lengthProfile);
  const basePrompt = buildPrompt({ description: desc, scenes: scenesNorm, question: String(question || '').slice(0, 300), hits });

  /*
   * 多轮生成：先按规格写；字数/条数不够就**带着上一稿再要一次**（最多 maxAttempts 次）。
   * 每次重试只放宽 token 预算、不降低标准 —— 宁可交付一份偏短的正确报告
   * （标记 quality.low 供人工复核），也不要为了凑字数把内容注水。
   */
  let gen = null;
  let quality = null;
  let attempts = 0;
  while (attempts < (spec.maxAttempts || 2)) {
    attempts += 1;
    gen = await runStructured({
      chat,
      system: SYSTEM,
      prompt: attempts === 1 ? basePrompt : `${basePrompt}\n\n${retryHint('diagnose', quality, gen?.text || '')}`,
      maxTokens: spec.retryMaxTokens,
      temperature: 0.7,
    });
    quality = assessQuality({ sku: 'diagnose', content: toContent(gen.sections || {}), sections: gen.sections, spec });
    if (gen.fallback || quality.ok) break;
  }

  let sections = gen.sections;
  let fallback = gen.fallback;
  let safeError = null;

  // 出参内容安全：模型可能回吐不当内容，拦下就降级
  if (!fallback && gen.text) {
    try {
      await assertSafe(gen.text, { field: 'diagnose_output', label: '诊断报告' });
    } catch (err) {
      safeError = String(err?.message || err).slice(0, 200);
      fallback = true;
    }
  }

  if (fallback || !sections || completenessOf(sections) < 0.6) {
    sections = fallbackSections({ scenes: scenesNorm, hits });
    fallback = true;
  }

  return {
    kind: 'diagnose',
    lengthProfile,
    quality: { ...quality, attempts },
    tier: 'advanced',
    // 诊断报告没有"契合度"这类分数：显式给 null，前端据此不渲染分数区
    scores: null,
    overall: null,
    basis: null,
    labels: null,
    content: toContent(sections),
    sections,
    completeness: completenessOf(sections),
    pitfalls: publicHits(hits),
    retrieval: method,
    scenes: scenesNorm,
    fallback,
    model: gen.model,
    provider: gen.provider,
    ...(fallback ? { llmError: safeError || gen.llmError || null } : {}),
  };
}
