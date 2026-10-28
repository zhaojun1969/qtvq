/**
 * 全局常量：档位枚举的唯一来源
 *
 * 计划书里档位有两种写法且无映射说明（`basic/advanced/deep/soul` ↔
 * 缘分一转/心动三转/深度配对/灵魂契合），这里是全项目唯一口径。
 * 任何统计、订单、报告都必须引用本文件，不得再写字面量。
 */
export const TIERS = {
  basic: {
    key: 'basic',
    zh: '缘分一转',
    price: 1,
    dims: ['interest'],
    maxWords: 150,
  },
  advanced: {
    key: 'advanced',
    zh: '心动三转',
    price: 5,
    dims: ['interest', 'personality', 'lifestyle'],
    maxWords: 250,
  },
  deep: {
    key: 'deep',
    zh: '深度配对',
    price: 20,
    dims: ['interest', 'personality', 'lifestyle'],
    maxWords: 600,
  },
  soul: {
    key: 'soul',
    zh: '灵魂契合',
    price: 50,
    dims: ['interest', 'personality', 'lifestyle'],
    maxWords: 1000,
  },
};

export const TIER_ORDER = ['basic', 'advanced', 'deep', 'soul'];

export const DIM_ZH = {
  interest: '兴趣契合',
  personality: '性格契合',
  lifestyle: '生活方式',
};

export function isValidTier(tier) {
  return Object.prototype.hasOwnProperty.call(TIERS, tier);
}

/** 用户资料状态：候选与报告只允许 active */
export const USER_STATUS = {
  ACTIVE: 'active',
  INVISIBLE: 'invisible',
  BANNED: 'banned',
};

export const REPORT_STATUS = {
  PENDING: 'pending',
  READY: 'ready',
  FAILED: 'failed',
};

/* ------------------------------------------------------------------ 报告 SKU */

/**
 * 报告商品（2026-10-27 · 再改造实施书 D5）
 *
 * 与 `TIERS` 的关系要分清，否则会有人把两套价目混用：
 *   · `TIERS`  = **报告深度/字数/维度**（basic 150 字 … soul 1000 字），是"生成规格"；
 *   · `REPORT_SKUS` = **对外售卖的商品**（价格/卖点），是"计价单位"。
 * 一个 SKU 指定它用哪档 TIERS 去生成（`tier` 字段），价格与字数因此互不干扰。
 *
 * 首单价（`introFen`）只对 `diagnose` 且**每个账号限一次** —— 判定依据是
 * 该账号是否已有 diagnose 的已支付/已消费订单（见 `services/report-credits.js`）。
 */
export const REPORT_SKUS = {
  diagnose: {
    key: 'diagnose',
    zh: '避坑诊断报告',
    desc: '把你的处境拆成风险点 / 对照案例 / 行动清单三段',
    priceFen: 990,
    introFen: 490,
    tier: 'advanced',
  },
  retro: {
    key: 'retro',
    zh: '关系复盘报告',
    desc: '还原时间线、识别冲突模式、给挽救或止损的下一步',
    priceFen: 1990,
    tier: 'deep',
  },
  pair: {
    key: 'pair',
    zh: 'AI 配对报告',
    desc: '两人契合度、共鸣点与长期相处的具体建议',
    priceFen: 2990,
    tier: 'deep',
  },
};

export function isValidSku(sku) {
  return Object.prototype.hasOwnProperty.call(REPORT_SKUS, sku);
}

/** 会员每期可用的报告额度份数（实施书 D6：月 1 / 季 3 / 年 12） */
export const PLAN_REPORT_CREDITS = { month: 1, quarter: 3, year: 12 };

/** 会员套餐时长（天），用于计算"当前这一期"的起点 */
export const PLAN_DAYS = { month: 30, quarter: 90, year: 365 };