/**
 * 痛苦表述识别（危机识别的「第二档」）
 *
 * 为什么要有第二档
 * --------------
 * `crisis.js` 只认**明确的第一人称求死意图**与**明确手段**，代价是「我撑不下去了」
 * 拿不到任何东西 —— 而这几乎是求助者最常说的那句话。
 * 想让它也有回应，只有两条路：
 *
 *   A. 放宽 `crisis` 的判定 → 明确级卡片会被大量误触发。卡片占满回答区、
 *      带三个电话号码，误触发一次就足够让人形成"这玩意儿乱弹"的印象，
 *      真需要时也不看了。这条路会毁掉第一档。
 *   B. **另开一档，但换一种呈现** → 本文件。
 *
 * 第二档的全部设计都服务一个目标：**出现得起**。
 *   · 它不遮挡回答、不弹窗、不占满屏，只是一条窄条（软提示）；
 *   · 一次会话只出现一次，用户点「不再提示」永久不再出现；
 *   · 明确级命中时它**不出现**（有卡片就不要再叠一条，视觉上会变成"警报"）。
 *
 * 换句话说：噪音问题从来不是"弹不弹"，是"挡不挡视线"。窄条不挡视线，
 * 所以可以让它的召回放宽到「痛苦程度」这一层。
 *
 * 判定范围（刻意窄，不追求全）
 * --------------------------
 * 只收"承受能力崩塌"与"看不到希望"两类，**不收**泛情绪词：
 *   · 收：「撑不下去了」「扛不住了」「熬不住」「好绝望」「看不到希望」「没救了」
 *   · 不收：「累」「烦」「难过」「想哭」「崩溃」（这些在情感咨询里是**常态**，
 *     收了就等于每条都出现，窄条也会变成壁纸）
 *
 * 号码不在这里
 * -----------
 * 复用 `crisis.js` 的 `CRISIS_RESOURCES`。号码写错等于把人引到空号，
 * 因此全仓只在 `crisis.js` 出现一次，`check-safety-wiring.mjs` 会判红。
 */

import { CRISIS_RESOURCES } from './crisis.js';

const PATTERNS = [
  {
    id: 'capacity-collapse',
    // 「受不了了」后面紧跟人称/指代时是抱怨别人（「我受不了他了」），不是自己撑不住。
    re: /(撑不下去|撑不住|扛不住|顶不住|熬不住|坚持不下去|受不了了(?![他她它你这那]))/,
    why: '「撑/扛/熬不住」是承受能力崩塌，中文里几乎没有别的用法',
  },
  {
    id: 'hopeless',
    re: /(绝望|没有希望|看不到希望|看不到头|没救了|无路可走|走投无路)/,
    why: '「绝望」在情感咨询里确实高频，但它是**程度**而非**手段**，正好属于第二档',
  },
  {
    id: 'meaning-loss',
    // 与 crisis 的「活着没意思」重叠是有意的：危机级命中时第二档不再出现，
    // 所以重叠不会造成重复展示，只保证「活着太累」这类不是求死意图的表述也有人接住。
    re: /(活着(真|太|好|特别)?(累|没意思|没意义)|活得(真|太|好)?累|生无可恋)/,
    why: '「活着太累」不是求死，但显然在受苦；crisis 的 (?!得) 会把它让给本档',
  },
  {
    id: 'isolation',
    re: /(没人(能)?(懂|理解|在乎)我|一个人在?扛|只能自己扛)/,
    why: '孤立感是痛苦表述里最常见的形态之一，且没有口语歧义',
  },
];

/**
 * 否定语境（与 crisis.js 同思路，但窗口更短、只认短语）。
 * 反例必须挡住的：「我没有绝望」「没那么撑不住」「别说什么走投无路」。
 */
const NEGATION_WINDOW = 4;
const NEGATION_RE = /(不想|不会|不能|没有|没|不是|不算|别|哪有|并非)/;

function isNegated(text, m) {
  const start = Math.max(0, m.index - NEGATION_WINDOW);
  return NEGATION_RE.test(text.slice(start, m.index));
}

/**
 * @param {string} text 用户输入
 * @returns {{level:'none'|'distress', matched:string[]}}
 */
export function distressCheck(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return { level: 'none', matched: [] };

  const norm = raw
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase();

  const matched = [];
  for (const p of PATTERNS) {
    const m = p.re.exec(norm);
    if (!m) continue;
    if (isNegated(norm, m)) continue;
    matched.push(p.id);
  }
  if (!matched.length) return { level: 'none', matched: [] };
  return { level: 'distress', matched };
}

/**
 * 生成软提示条数据。
 *
 * 只给一个主号码 + 完整列表：窄条里塞三个号码会立刻变成卡片的视觉重量，
 * 而它的存在意义恰恰是"轻"。想看得更全的人点一下就能展开。
 *
 * @param {{level:string}} distress
 * @returns {null | {level:'distress', text:string, primary:object, resources:Array, dismissible:boolean}}
 */
export function buildGentleTip(distress) {
  if (!distress || distress.level !== 'distress') return null;
  const list = CRISIS_RESOURCES.filter((r) => r && r.phone).map((r) => ({
    name: r.name,
    phone: r.phone,
    note: r.note,
  }));
  if (!list.length) return null;
  return {
    level: 'distress',
    /*
     * 文案对"我"和"他"都成立：判定不区分主体（「他撑不下去了，我该怎么帮他」
     * 也会命中），若写成「这阵子很难熬吧」就会答错题 —— 用户是在替别人问。
     * 替人求助同样是值得给出口的时刻，只是措辞必须两边都不别扭。
     */
    text: '听起来有很难熬的时刻。如果愿意，可以找个人说说话 —— 不用一个人扛。',
    primary: list[0],
    resources: list,
    dismissible: true,
  };
}

/** 供健康检查/运营台展示（不含号码值也能核对条数） */
export function distressMeta() {
  return {
    patterns: PATTERNS.map((p) => ({ id: p.id, why: p.why })),
    resources: CRISIS_RESOURCES.length,
  };
}
