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
    chatModel: process.env.CHAT_MODEL || 'qwen-plus',
  },

  cf: {
    accountId: process.env.CF_ACCOUNT_ID || '',
    token: process.env.CF_API_TOKEN || '',
    embedModel: process.env.CF_EMBED_MODEL || '@cf/qwen/qwen3-embedding-0.6b',
    chatModel: process.env.CF_CHAT_MODEL || '@cf/zai-org/glm-4.7-flash',
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
