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
