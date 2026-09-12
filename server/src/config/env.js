/**
 * 环境配置（唯一读取 process.env 的地方）
 */
import 'dotenv/config';

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function list(v, d) {
  if (!v) return d;
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 3000),
  allowDevLogin: process.env.ALLOW_DEV_LOGIN === '1',

  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/qtvq',
  mongoDb: process.env.MONGO_DB || 'qtvq',

  legacyApiBase: (process.env.LEGACY_API_BASE || 'https://qtvq-api.pages.dev').replace(/\/$/, ''),
  jwtSecret: process.env.JWT_SECRET || '',
  jwtTtl: process.env.JWT_TTL || '30d',

  embedProvider: process.env.EMBED_PROVIDER || 'dashscope',
  llmProvider: process.env.LLM_PROVIDER || 'dashscope',
  embedDims: num(process.env.EMBED_DIMS, 1024),

  dashscope: {
    key: process.env.DASHSCOPE_API_KEY || '',
    base: (process.env.DASHSCOPE_BASE || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, ''),
    embedModel: process.env.EMBED_MODEL || 'text-embedding-v3',
    chatModel: (process.env.CHAT_MODEL || 'qwen-plus,qwen-turbo').split(',')[0].trim(),
    // 模型降级链：单个模型配额耗尽/不可用时自动换下一个。
    // 实测会遇到 403 AllocationQuota.FreeTierOnly（百炼免费额度用尽），
    // 没有降级链就会整条报告退化成兜底文案。
    chatModels: list(process.env.CHAT_MODEL || 'qwen-plus,qwen-turbo', ['qwen-plus', 'qwen-turbo']),
  },

  cf: {
    accountId: process.env.CF_ACCOUNT_ID || '',
    token: process.env.CF_API_TOKEN || '',
    embedModel: process.env.CF_EMBED_MODEL || '@cf/qwen/qwen3-embedding-0.6b',
    chatModel: (process.env.CF_CHAT_MODEL || '').split(',')[0].trim() || '@cf/meta/llama-3.1-8b-instruct',
    // 降级链。实测：glm-4.7-flash / qwen3-30b 是**推理模型**，
    // reasoning 也会消耗 token，max_tokens 给小了会出现 content=null、
    // finish_reason=length（见 llm.js 的 budgetFor）。因此链尾一定要放一个
    // 非推理模型兜底，否则整份报告会退化成兜底文案。
    chatModels: list(process.env.CF_CHAT_MODEL, [
      '@cf/zai-org/glm-4.7-flash',
      '@cf/qwen/qwen3-30b-a3b-fp8',
      '@cf/meta/llama-3.1-8b-instruct',
    ]),
  },

  openai: {
    key: process.env.OPENAI_KEY || '',
    base: (process.env.OPENAI_BASE || 'https://api.openai.com/v1').replace(/\/$/, ''),
    embedModel: process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small',
    chatModel: process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
  },

  corsOrigins: list(process.env.CORS_ORIGINS, [
    'https://qtvq.cn',
    'https://www.qtvq.cn',
    'http://localhost:8080',
    'http://localhost:8788',
  ]),

  // ===== 计费 =====
  // 0 = 只计算不扣款（响应里仍会明确标注），用于灰度；1 = 真扣
  enforceBilling: process.env.ENFORCE_BILLING !== '0',
  /** 新钱包初始赠送余额（元）；0 = 关闭 */
  welcomeBalance: num(process.env.WELCOME_BALANCE, 10),
  /** 免费档位（逗号分隔）。默认 basic 免费，作为体验档 */
  freeTiers: list(process.env.FREE_TIERS, ['basic']),
  /** 会员每日可免费生成的次数（任意档位） */
  memberDailyFree: num(process.env.MEMBER_DAILY_FREE, 1),
  /** 不同举报人数达到该阈值时，目标用户自动转 invisible（等待人工确认） */
  moderationAutoHide: num(process.env.MODERATION_AUTO_HIDE, 5),

  // ===== 运营台 =====
  /** 运营台口令；未配置时 /v1/admin/* 全部 404（不是 401，避免暴露存在性） */
  adminKey: process.env.ADMIN_KEY || '',

  // ===== 内容安全 =====
  /** local | local+wechat —— 本地词表始终生效，wechat 需配置密钥 */
  safetyProvider: process.env.SAFETY_PROVIDER || 'local',
  wechatMiniAppId: process.env.WECHAT_MINI_APPID || '',
  wechatMiniSecret: process.env.WECHAT_MINI_SECRET || '',
};

function describe(kind, provider) {
  if (provider === 'dashscope') {
    return {
      provider,
      configured: !!env.dashscope.key,
      model: kind === 'embed' ? env.dashscope.embedModel : env.dashscope.chatModel,
    };
  }
  if (provider === 'workers-ai') {
    return {
      provider,
      configured: !!(env.cf.accountId && env.cf.token),
      model: kind === 'embed' ? env.cf.embedModel : env.cf.chatModel,
    };
  }
  return {
    provider: 'openai',
    configured: !!env.openai.key,
    model: kind === 'embed' ? env.openai.embedModel : env.openai.chatModel,
  };
}

/** 供 /v1/health 输出，避免把密钥泄漏到日志或响应里 */
export function providerStatus() {
  return {
    embed: describe('embed', env.embedProvider),
    llm: describe('llm', env.llmProvider),
    embedDims: env.embedDims,
    legacyApiBase: env.legacyApiBase,
    devLoginAllowed: env.allowDevLogin,
  };
}
