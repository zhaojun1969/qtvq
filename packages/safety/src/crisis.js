/**
 * 危机转介（自伤 / 自杀风险）识别 —— 跨端纯函数
 *
 * 为什么它**不是**敏感词表的一部分
 * ------------------------------
 * 词表那套结构的语义是「这条内容**违规**，要拦/要审」。危机表述恰恰相反：
 * 用户说「我不想活了」不是在违规，是在**求助**。把它塞进词表会导致两个后果，
 * 而且都是反向的：
 *   · 若 severity=block → 一个正在崩溃的人被系统拒答，等于把他推走；
 *   · 若 severity=review → 进人工复核队列，但复核是**事后**的，危机是**当场**的。
 * 所以这里是独立模块，输出的是「该给什么帮助」，不是「该不该拦」。
 *
 * 判定边界（这是本文件最需要说清的部分）
 * ------------------------------------
 * 只识别**明确的第一人称求死意图**与**明确手段**，不识别「痛苦程度」。
 *   · 报：「我不想活了」「想死」「活不下去」「活着没意思」「想自杀」「割腕」「写了遗书」
 *   · 不报：「累死了」「笑死我了」「我想死你了」（思念）、「我要死了」（夸张口语）、
 *           「我不想死」（求生表达）
 * 取舍的理由：情感咨询场景里「累死了/好绝望」出现频率极高，若都弹心理援助卡片，
 * 卡片会退化成噪音，用户学会无视它 —— 真需要时也就不看了。宁可只覆盖明确表述。
 * 代价是**会漏**：一个说「撑不下去了」的人拿不到卡片。这个漏是有意接受的，
 * 因为漏掉的场景里 AI 回答仍在正常给出，只是少了热线；而误报会让卡片整体失效。
 *
 * 号码来源（不可手改，改前必须重新核实）
 * ------------------------------------
 *   · 12356 —— 国家卫生健康委《关于应用"12356"全国统一心理援助热线电话号码的通知》
 *     （国卫医政函〔2024〕259号）：2025-05-01 0 时前全国接通。权威来源：gov.cn。
 *   · 010-82951332 —— 北京心理危机研究与干预中心 24 小时热线，
 *     来源 crisis.org.cn 官网公告（核实于 2026-10-28）。
 * 这两个号码是**会害人**的那种字段：写错等于把人引到空号。因此：
 *   · 只在本文件出现一次，前端不得各自硬编码（检查器 `check-safety-wiring.mjs` 会判红）；
 *   · 每条都带 `source`，便于下次核实。
 */

/**
 * 求助资源。顺序即展示顺序：全国统一号码在前（覆盖最广、免费），
 * 紧急电话最后（它解决"现在就有生命危险"，不是心理支持）。
 */
export const CRISIS_RESOURCES = [
  {
    name: '全国心理援助热线',
    phone: '12356',
    note: '24 小时 · 免费 · 全国统一',
    source: '国卫医政函〔2024〕259号（gov.cn），2025-05-01 全国开通',
  },
  {
    name: '北京心理危机研究与干预中心',
    phone: '010-82951332',
    note: '24 小时（手机拨打）',
    source: 'crisis.org.cn 官网公告，核实于 2026-10-28',
  },
  {
    name: '紧急救助',
    phone: '120',
    note: '已经受伤或有立即生命危险时先打 120',
    source: '急救电话',
  },
];

/**
 * 危机句式。
 *
 * 每条都必须能被一句话说清「为什么它不容易误伤」，说不清的就不要加。
 * 这里刻意**不用**「死」这种单字词 —— 单字词在中文里几乎全是口语（笑死/累死/死党）。
 */
const PATTERNS = [
  {
    id: 'not-want-live',
    // `(?!得)` 是实测补的：「不想活得太累」「不想活得那么累」是生活方式表达，
    // 而「不想活下去」才是求死。两者只差一个「得/下」，必须在这里分开。
    re: /(不想活(?!得|成|出)|活不下去|活够了|活着(真|好|太)?(没|没有|毫无)(意思|意义|希望))/,
    why: '「活着没意思」是典型求助信号，且不含「死」字，不受口语干扰',
  },
  {
    id: 'want-die',
    // 「想死你了」是思念 —— 后接人称代词时排除。
    // `想(要|去)?死` 覆盖「我想去死」；早期只写 `想死` 会漏掉它（实测漏报）。
    re: /(真的|真|好|很|现在|已经)?想(要|去)?死(?!你|他|她|我)/,
    why: '「想死」后接你/他/她时是「想死你了」的思念用法',
  },
  {
    id: 'about-to-die',
    // 有「去」是意图（我要去死）；没「去」且带「了」是夸张（我要死了/加班要死了）
    re: /(我|俺)(真的|真|现在|已经)?要(去死|死(?!了))/,
    why: '排除「要死了」这一高频夸张口语，但保留「要去死」',
  },
  {
    id: 'plan-die',
    re: /(准备|打算|计划|决定)(要|去)?(死|自杀)/,
    why: '「准备去死」不含「想」字，单靠 want-die 会漏（实测漏报后补）',
  },
  {
    id: 'suicide-intent',
    re: /(想|打算|准备|计划|决定)(要|去)?(自杀|轻生|结束(自己的)?生命|了结(自己|生命)|一了百了)/,
    why: '「自杀/轻生」没有口语歧义',
  },
  {
    id: 'method',
    re: /(割腕|上吊|跳楼|跳桥|烧炭|服毒)/,
    why: '具体手段，几乎只出现在真实危机或求助描述里',
  },
  {
    id: 'suicide-note',
    re: /(写|留|准备|想好|拟)(了|好|下)?遗书/,
    why: '遗书是与自杀强绑定的唯一词汇',
  },
  {
    id: 'overdose',
    // 「吃药」是日常，「吞一把药」不是 —— 必须带量词
    re: /(吞|吃)(了)?(一整?瓶|一把|大量|好多)(安眠药|药片|药)/,
    why: '要求量词，避免把「吃了药」当危机',
  },
];

/**
 * 否定语境：只在**命中位置之前**的小窗口里找。
 *
 * 这里踩过一次坑，值得记下来：初版用的是单字 `/(不|没|别)/` + 6 字窗口，
 * 结果把这三句全判成「否定」而漏报 —— 而它们都是真实危机表述：
 *   · 「我**是不是**该写遗书」← 窗口里含「不」
 *   · 「**别**拦我，我要去死」 ← 窗口里含「别」
 * 所以现在只认**短语**（不想 / 不会 / 没想过 …），不认单字。
 * `(?<!是)不是` 是为了绕开「是不是」这个疑问句式 —— 它在问，不是在否定。
 */
const NEGATION_WINDOW = 5;
const NEGATION_RE = /(不想|不要|不会|不能|不该|不去|(?<!是)不是|没(想|打|准|有|要|过)|从没|从未|并没|哪有)/;

/**
 * 「死」类口语。仅用于 `about-to-die` 之外的兜底：如果命中片段紧邻这些词，
 * 说明是修辞而非意图（「想死我了」已由 lookahead 处理，这里兜「烦死了想死」这类）。
 */
const IDIOM_RE = /(笑死|累死|困死|饿死|烦死|气死|热死|冷死|吓死|死党|死磕|拼命)/;

/**
 * 判断命中是否是「被否定」的表述。
 *
 * 窗口的右边界不能一律取 `m.index`：`want-die` 命中「想死」时，
 * 否定词「不」在「想」**之前**两个字之外（「我不想死」→ 命中片段是「想死」，
 * 前 5 字窗口只截到「我不」，看不到「想」）。所以窗口要多吃 2 个字。
 *
 * 但 `not-want-live` 命中「不想活」时片段**自带**「不」，此时绝不能扩展窗口
 * ——否则它会被自己身上的「不」永远判成否定，直接失效。用 `selfHasNeg` 区分。
 */
function isNegated(text, m) {
  const start = Math.max(0, m.index - NEGATION_WINDOW);
  const selfHasNeg = /^(不|没)/.test(m[0]);
  const end = selfHasNeg ? m.index : Math.min(text.length, m.index + 2);
  return NEGATION_RE.test(text.slice(start, end));
}

function nearIdiom(text, index, length) {
  const start = Math.max(0, index - 4);
  const end = Math.min(text.length, index + length + 4);
  return IDIOM_RE.test(text.slice(start, end));
}

/**
 * 识别危机表述。
 *
 * @param {string} text 用户输入（原始文本即可，内部做全角/零宽归一）
 * @returns {{level:'none'|'urgent', matched:string[], resources:Array, provider:'local'}}
 */
export function crisisCheck(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return { level: 'none', matched: [], resources: [], provider: 'local' };

  // 与 index.js 的 normalize 同口径：去零宽 + 全角转半角 + 小写。
  // 不在这里 import normalize 是为了让本文件零依赖（可被任一端单独引入）。
  const norm = raw
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase();

  const matched = [];
  for (const p of PATTERNS) {
    const m = p.re.exec(norm);
    if (!m) continue;
    if (isNegated(norm, m)) continue;
    // 「我要死」类已由 lookahead 排除「了」；这里只兜紧邻口语的情况
    if (p.id === 'about-to-die' && nearIdiom(norm, m.index, m[0].length)) continue;
    matched.push(p.id);
  }

  if (!matched.length) return { level: 'none', matched: [], resources: [], provider: 'local' };
  return { level: 'urgent', matched, resources: CRISIS_RESOURCES, provider: 'local' };
}

/**
 * 生成给前端渲染的求助卡片。
 *
 * 放在共享层而不是各端各写一份：这段文案会被**多端同时**展示，
 * 而它最怕的就是漂移 —— 网页改了「24 小时有人接」，小程序还写着旧说法；
 * 或者某个端把「如果你或身边的人」写成「你需要帮助」，替人求助的用户就答错了题。
 *
 * `resources` 只保留展示需要的三个字段（name/phone/note），
 * `source` 是给维护者核实的，不该出现在客户端响应里。
 *
 * @param {{level:string, resources?:Array}} crisis
 * @returns {null | {level:string, title:string, body:string, resources:Array}}
 */
export function buildSupportCard(crisis) {
  if (!crisis || crisis.level !== 'urgent') return null;
  const resources = (crisis.resources || [])
    .filter((r) => r && r.phone)
    .map((r) => ({ name: r.name, phone: r.phone, note: r.note }));
  if (!resources.length) return null;
  return {
    level: 'urgent',
    title: '如果你或身边的人正在经历难以承受的时刻',
    body: '这段对话代替不了专业帮助。下面这些电话都是免费的，24 小时有人接。也可以先告诉一个你信任的人，不用一个人扛。',
    resources,
  };
}

/** 供运营台/健康检查展示：当前识别了几类句式、几个资源（不含号码值也可核） */
export function crisisMeta() {
  return {
    patterns: PATTERNS.map((p) => ({ id: p.id, why: p.why })),
    resources: CRISIS_RESOURCES.map((r) => ({ name: r.name, phone: r.phone })),
  };
}
