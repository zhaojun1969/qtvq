/**
 * Q问 · 本地内容安全检查（跨端唯一来源）
 *
 * 从这里迁出了什么
 * ----------------
 * 原本这套逻辑住在 `server/src/services/content-safety.js` 里，和 Node 的 `fs`、
 * 阿里云/微信外部服务、审核台账混在一个文件。迁出的是**纯函数部分**：
 * 规范化、压扁、词表比对、正则比对、字段处置策略。
 * 留在服务端的是**平台相关部分**：`fs` 读文件、`fetch` 调外部服务、写台账。
 *
 * 为什么值得迁
 * ------------
 * 词表比对是"零成本、无延迟、必过"的第一道闸。放在共享层之后：
 *   · 小程序可以在**发送前**本地先跑一遍（即时反馈，不用等一个来回）；
 *   · Pages Functions 可以在**边缘**先跑一遍（省一次回源）；
 *   · 三端词表永远同一份 —— 不会出现"网页拦了、小程序没拦"。
 *
 * 一处刻意的行为强化
 * ----------------
 * 旧实现用 `fs.readFileSync` 惰性加载，失败时 `catch` 成**空词表**继续跑。
 * 那意味着词表文件损坏 = 所有内容都判 clean，而系统仍报告"审核通过"
 * —— 静默失效的安全控制比没有控制更危险。
 * 现在词表是静态 `import`，损坏会在**启动时**就炸出来，不会退化成一个静默放行的运行时。
 *
 * 状态说明
 * --------
 * 正则对象在模块级只编译一次并复用（5 条），靠 `lastIndex = 0` 复位保证正确。
 * 这对**同步**函数是安全的：本文件所有导出都不含 `await`，不存在并发交叉。
 */

import words from './words.js';

const { categories = {}, patterns: rawPatterns = [], version = 0, updatedAt = '', note = '' } = words;

/** 严重度排序。必须给 'pass' 一个数字：`x > undefined` 恒为 false。 */
export const SEVERITY_ORDER = { pass: 0, review: 1, block: 2 };

/** 去掉零宽字符与全角差异 */
export function normalize(s) {
  return String(s ?? '')
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase();
}

/** 再压掉所有非字母数字汉字，用来对抗 "加 微 信" / "加*微*信" 这类绕过 */
export function squash(s) {
  return normalize(s).replace(/[^0-9a-z\u4e00-\u9fa5]/g, '');
}

/* ------------------------------------------------------------------ 词表构建 */

const dict = (() => {
  const list = [];
  for (const [category, conf] of Object.entries(categories)) {
    for (const w of conf.words || []) {
      list.push({ word: w, category, severity: conf.severity || 'block', squashed: squash(w) });
    }
  }
  const pats = rawPatterns.map((p) => ({
    name: p.name,
    category: p.category,
    severity: p.severity || 'block',
    regex: new RegExp(p.regex, 'gi'),
  }));
  return { words: list, patterns: pats };
})();

/** 词表现状（供 `/v1/safety/status` 与运营台展示） */
export function wordlistMeta() {
  return {
    version,
    updatedAt,
    note,
    categories: Object.keys(categories),
    wordCount: dict.words.length,
    patternCount: dict.patterns.length,
  };
}

/* -------------------------------------------------------------- 字段处置策略 */

/**
 * 不同字段的处置策略。
 *
 * 三类新增类别（2026-10-11 依业务方要求补齐）的处理原则：
 *   · **未成年人**：任何字段一律 block —— 这属于违法内容，没有"转人工"的余地；
 *   · **广告法**：一律 review（不拦用户，只标记待复核）—— 广告法风险主要在**平台自己的宣传文案**，
 *     用户自我介绍里出现"第一/最好"这类词，属于"可能违规"而非"确定违法"，
 *     拦下来会大量误伤正常表达，所以只进复核队列；
 *   · **歧视攻击**：review —— 需要结合语境（引用 vs 攻击），机器判定容易误伤，交人看。
 *
 * 未列出的类别回落到词表自身的 `severity`。
 */
/**
 * 热路径字段：**全类别 review，一律不拦**。
 *
 * 这是本轮特意做的取舍，理由必须写清，否则以后有人会"顺手改回 block"：
 *   · 首页问答里用户是在**叙述处境**，不是在**发布内容**。
 *     「我男朋友约炮了」「我 14 岁，父母离婚了」都会命中涉黄/未成年人词表，
 *     按 block 处理等于**把受害者挡在门外**，而他们恰恰是最需要帮助的人。
 *   · 词表里的「未成年人」类含「高中生」「14岁」这类**身份描述**，
 *     在"发布招嫖信息"语境下是违规证据，在"求助"语境下是受害者特征 —— 词表分不出语境。
 *   · 真正要防的不良**生成**，由输出侧与模型自身策略承担，不该靠拦提问来实现。
 * 因此这里的作用是**留痕可回溯**（台账 + 申诉依据），不是准入控制。
 */
function reviewOnly() {
  return Object.fromEntries(Object.keys(categories).map((c) => [c, 'review']));
}

export const POLICY = {
  profile: { 涉黄: 'block', 涉赌: 'block', 涉毒: 'block', 诈骗: 'block', 引流: 'block', 辱骂: 'review', 广告法: 'review', 未成年人: 'block', 歧视攻击: 'review' },
  question: { 涉黄: 'block', 涉赌: 'block', 涉毒: 'block', 诈骗: 'block', 引流: 'review', 辱骂: 'review', 广告法: 'review', 未成年人: 'block', 歧视攻击: 'review' },
  moderation: { 涉黄: 'review', 涉赌: 'review', 涉毒: 'review', 诈骗: 'review', 引流: 'review', 辱骂: 'review', 广告法: 'review', 未成年人: 'block', 歧视攻击: 'review' },
  /* 首页问答的热路径：不拦（见上方说明） */
  chat_question: reviewOnly(),
  ai_output: reviewOnly(),
  default: { 涉黄: 'review', 涉赌: 'review', 涉毒: 'review', 诈骗: 'review', 引流: 'review', 辱骂: 'review', 广告法: 'review', 未成年人: 'block', 歧视攻击: 'review' },
};

export function policyFor(field) {
  return POLICY[field] || POLICY.default;
}

/* ------------------------------------------------------------------ 本地检查 */

/**
 * 纯本地检查（同步、无网络）。
 * @param {string} text
 * @param {{field?: string}} opts
 * @returns {{clean:boolean, hits:Array, categories:string[], action:'pass'|'review'|'block', provider:string}}
 */
export function localCheck(text, { field = 'default' } = {}) {
  const raw = String(text ?? '');
  if (!raw.trim()) return { clean: true, hits: [], action: 'pass', provider: 'local' };

  const norm = normalize(raw);
  const sq = squash(raw);
  const policy = policyFor(field);
  const hits = [];

  for (const item of dict.words) {
    const matched = norm.includes(item.word) || (item.squashed && sq.includes(item.squashed));
    if (!matched) continue;
    hits.push({ kind: 'word', word: item.word, category: item.category, severity: policy[item.category] || item.severity });
  }

  for (const p of dict.patterns) {
    // 关键：正则必须同时跑**规范化后的文本**。
    // 词表比对走的是 squash/去零宽后的文本，正则却只跑原文 —— 于是
    // "加ＷＸ详聊"（全角）能绕过 `wx` 正则、却过不了词表（如果词表里有对应词）。
    // 2026-09-17 对抗性测试发现：7 个绕过用例中有 1 个纯属这个不一致造成。
    p.regex.lastIndex = 0;
    const matched = p.regex.exec(raw) || (norm !== raw && p.regex.exec(norm));
    if (!matched) continue;
    hits.push({
      kind: 'pattern',
      word: p.name,
      // 不回显命中内容，避免把用户手机号又写回日志/响应里
      category: p.category,
      severity: policy[p.category] || p.severity,
    });
  }

  // 同一类别只留一条，避免响应里出现几十个重复项
  const seen = new Set();
  const unique = [];
  for (const h of hits) {
    const k = `${h.category}:${h.word}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(h);
  }

  const action = unique.reduce(
    (acc, h) => (SEVERITY_ORDER[h.severity] > SEVERITY_ORDER[acc] ? h.severity : acc),
    'pass',
  );

  return {
    clean: unique.length === 0,
    hits: unique.slice(0, 6),
    categories: [...new Set(unique.map((h) => h.category))],
    action,
    provider: 'local',
  };
}
/* ------------------------------------------------------------ 危机转介（re-export） */

/**
 * 危机识别与求助资源。**与上面的违规词表是两套语义**，原因写在 `crisis.js` 开头：
 * 词表回答「要不要拦」，危机模块回答「该给什么帮助」。
 *
 * 从 index 统一导出，是为了让三端只需要记一个入口 `packages/safety/src/index.js`，
 * 不必知道内部拆了几个文件。
 */
export { crisisCheck, crisisMeta, CRISIS_RESOURCES, buildSupportCard } from './crisis.js';

/**
 * 痛苦表述（第二档）：明确级命中时客户端不展示本档，见 `distress.js` 开头。
 * 与 crisis 分开导出而不是合并成一个 `check()`，是为了让调用方**必须显式**
 * 决定"这一档要显示成什么"—— 合并后很容易被顺手当成 crisis 用，
 * 那就等于把卡片变成了"话多就说你有危险"。
 */
export { distressCheck, distressMeta, buildGentleTip } from './distress.js';
