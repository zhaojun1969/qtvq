/**
 * 配对报告生成（路线 B 的核心）
 *
 * 与计划书的关键差异（都是刻意的）：
 * 1. 分数由 `dimensions.js` 确定性算出，模型只写正文 —— 同一对用户重复生成结果稳定；
 * 2. 把现有 50+ 条避坑案例作为报告的「知识底座」注入 Prompt —— 这是本项目相对
 *    市面上任何转盘配对产品唯一不可复制的资产；
 * 3. 模型不可用时降级为**基于规则与案例的确定性报告**，绝不返回 500；
 * 4. 只把必要字段发给模型，不包含手机号 / 实名 / 支付信息。
 */
import { TIERS } from '../constants.js';
import { chat } from './llm.js';
import { scoreDimensions } from './dimensions.js';
import { formatPitfalls, publicHits, retrievePitfalls } from './pitfalls.js';
import { cosine } from './embed.js';

const SYSTEM = `你是「我心永恒-Q问」的配对分析师。你的风格是「避坑 + 直线解决」：
- 不说鸡汤，不给模糊安慰
- 先给判断，再给具体可执行的下一步
- 明确指出这段关系里最可能的坑与代价
- 不评判、不PUA、不教操控话术
- 用第二人称直接对用户说话，中文输出，不要出现"根据数据"这类机械表达
- 不要输出标题，直接写正文`;

function tierInstruction(tierKey) {
  const t = TIERS[tierKey] || TIERS.deep;
  const base = `篇幅控制在 ${t.maxWords} 字左右。`;
  if (tierKey === 'basic') return `${base}只给一句总体判断 + 1 条最该做的事。`;
  if (tierKey === 'advanced') return `${base}包含兴趣与性格两点的具体观察，给出 2 条可执行建议。`;
  if (tierKey === 'deep') return `${base}分兴趣、性格、生活方式三方面分析，给出 3 条具体沟通建议，并指出 1 个最需要留意的风险。`;
  return `${base}包含心理层面的契合与摩擦点、长期关系潜力判断、潜在风险、5 条深度沟通建议，语言温暖但有洞察力。`;
}

/** 只挑必要字段，绝不带 phone / idHash / passwordHash */
export function toPromptUser(u = {}) {
  const parts = [`昵称：${u.nickname || '未填'}`];
  if (u.gender) parts.push(`性别：${u.gender === 'male' ? '男' : u.gender === 'female' ? '女' : u.gender}`);
  if (u.age) parts.push(`年龄：${u.age}`);
  if (u.city) parts.push(`城市：${u.city}`);
  if (u.job) parts.push(`职业：${u.job}`);
  if (u.height) parts.push(`身高：${u.height}`);
  if (Array.isArray(u.tags) && u.tags.length) parts.push(`兴趣标签：${u.tags.join('、')}`);
  if (u.intro) parts.push(`自我介绍：${u.intro}`);
  if (Array.isArray(u.qa) && u.qa.length) {
    parts.push(`问答记录：${u.qa.slice(0, 10).map((x) => `Q:${x.question} A:${x.answer}`).join(' | ')}`);
  }
  return parts.join('\n');
}

function buildUserPrompt({ me, ta, score, hits, question, tier }) {
  const dimLines = Object.entries(score.scores)
    .map(([k, v]) => `${score.labels[k]}：${(v * 100).toFixed(0)}%（依据：${score.basis[k] || '资料有限'}）`)
    .join('\n');

  const pitfallBlock = hits?.length
    ? `\n【可参考的真实避坑案例】\n${formatPitfalls(hits)}\n`
    : '';

  return `请为下面两位用户生成配对报告。

【用户A（提问者）】
${toPromptUser(me)}

【用户B（配对对象）】
${toPromptUser(ta)}

【算法给出的契合度】
${dimLines}
综合契合度：${(score.overall * 100).toFixed(0)}%
${pitfallBlock}
【用户想重点了解】
${question || '这段关系值不值得投入，以及下一步该怎么做'}

【要求】
${tierInstruction(tier)}`;
}

/** 模型不可用时的确定性兜底报告：仍然基于真实分数与真实案例 */
function fallbackContent({ score, hits, tier }) {
  const lines = [];
  const dims = Object.entries(score.scores).map(([k, v]) => `${score.labels[k]} ${(v * 100).toFixed(0)}%`);
  lines.push(`你们的综合契合度是 ${(score.overall * 100).toFixed(0)}%（${dims.join('、')}）。`);
  const weakest = Object.entries(score.scores).sort((a, b) => a[1] - b[1])[0];
  if (weakest) lines.push(`最需要经营的一项是「${score.labels[weakest[0]]}」（${(weakest[1] * 100).toFixed(0)}%）。`);
  if (hits?.length) {
    lines.push('');
    lines.push('结合平台上的真实案例，建议先看这几条：');
    for (const h of hits) {
      lines.push(`· ${h.title}——${(h.steps || '').split('\n')[0] || '见案例详情'}`);
    }
  }
  lines.push('');
  lines.push(tier === 'basic' ? '下一步：把资料补全（兴趣标签 + 一句话自我介绍），分数会明显更准。' : '下一步：先把最弱的那一项用一次具体行动验证，再决定要不要加投入。');
  lines.push('');
  lines.push('（说明：本次未能调用到语言模型，以上为基于算法分数与平台案例库生成的确定性报告。）');
  return lines.join('\n');
}

/**
 * @param {object} params
 * @param {object} params.me    我方用户文档
 * @param {object} params.ta    对方用户文档
 * @param {string} params.tier  档位 key
 * @param {string} [params.question]
 * @param {Array}  [params.myQa] / [params.taQa] 问答记录（可选）
 */
export async function generateReport({ me, ta, tier, question, myQa = [], taQa = [] }) {
  const t = TIERS[tier] || TIERS.deep;

  const enrichedMe = { ...me, qa: myQa };
  const enrichedTa = { ...ta, qa: taQa };

  const score = scoreDimensions(me, ta, t.dims);

  const queryText = [
    Array.isArray(me.tags) ? me.tags.join(' ') : '',
    Array.isArray(ta.tags) ? ta.tags.join(' ') : '',
    me.intro || '',
    ta.intro || '',
    question || '',
  ]
    .filter(Boolean)
    .join(' ');

  const { hits, method } = await retrievePitfalls(queryText, tier === 'basic' ? 2 : 3);

  const result = await chat({
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: buildUserPrompt({ me: enrichedMe, ta: enrichedTa, score, hits, question, tier }) },
    ],
    temperature: 0.85,
    maxTokens: Math.max(400, Math.round(t.maxWords * 1.8)),
  });

  const fallback = !result.text;
  const content = fallback ? fallbackContent({ score, hits, tier }) : result.text;

  return {
    tier,
    scores: score.scores,
    overall: score.overall,
    basis: score.basis,
    labels: score.labels,
    content,
    pitfalls: publicHits(hits),
    retrieval: method,
    fallback,
    model: result.model,
    provider: result.provider,
    ...(fallback ? { llmError: result.error || null } : {}),
  };
}

/** 供分享页使用的脱敏快照：只保留展示必需的字段 */
export function publicProfile(u = {}) {
  return {
    uid: u._id,
    nickname: u.nickname || '匿名用户',
    avatar: u.avatar || null,
    gender: u.gender || null,
    age: u.age || null,
    city: u.city || null,
    tags: Array.isArray(u.tags) ? u.tags.slice(0, 6) : [],
    intro: u.intro || '',
  };
}

/** 复核用：给定两段向量直接算余弦（不调模型） */
export function pairSimilarity(a, b) {
  return cosine(a, b);
}
