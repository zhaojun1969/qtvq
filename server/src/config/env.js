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
  llmProvider: (process.env.LLM_PROVIDER || 'dashscope') === 'tongyi' ? 'dashscope' : process.env.LLM_PROVIDER || 'dashscope',
  /** 是否**显式**设过 LLM_PROVIDER —— 决定"内置默认链"要不要生效（见 resolveLlmChain） */
  llmProviderSet: !!process.env.LLM_PROVIDER,
  embedDims: num(process.env.EMBED_DIMS, 1024),

  /*
   * 跨提供方的模型降级链（与 Pages 侧 `functions/lib/llm-chain.js` **同名同语义**）。
   *
   * 起因（2026-09-18）：业务方要求改用通义的角色模型，且参数与 FTVF 项目
   * （D:\ftvf夫道）一致，便于维护与充值。FTVF 的做法就是一条有序链
   * 「通义 → DeepSeek → 内置话术」；本项目把它落成 `LLM_CHAIN` 这个环境变量，
   * Pages 与 Node 读同一个名字 —— 换模型只改配置、不改代码。
   *
   * 为什么链必须能跨提供方：单提供方的一条链，在"这一家整体配额用尽"时全灭
   * （实测百炼会返回 `Free quota exhausted`，整份报告会退化成兜底文案）；
   * 跨提供方时百炼不行还能落到已绑定的 Workers AI。
   *
   * 优先级：LLM_CHAIN > LLM_PROVIDER（兼容旧配置）> 内置默认（通义优先）。
   * 最终顺序由 resolveLlmChain() 计算，见文件末尾。
   */
  llmChainEnv: list(process.env.LLM_CHAIN, []),
  /** 角色模型名（与 FTVF 同名 TONGYI_CHARACTER_MODEL）：只覆盖链里第一个通义条目 */
  tongyiCharacterModel: process.env.TONGYI_CHARACTER_MODEL || '',

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
  /*
   * 报告计费开关（2026-10-27 · 实施书 P1-T1.3）。
   *
   * **默认关**是刻意的：一个会扣用户余额的开关，不该因为"忘了配环境变量"就悄悄打开。
   * 打开方式：`ENFORCE_REPORT_BILLING=1`；灰度再用 `REPORT_BILLING_GRAY_UIDS`（逗号分隔）限人。
   * 与 `enforceBilling`（转盘/钱包既有开关）分开命名，避免一个开关同时改变两种计费行为。
   */
  enforceReportBilling: process.env.ENFORCE_REPORT_BILLING === '1',
  /** 灰度名单：只有这些 uid 会被真扣（空 = 全量生效，前提是上面的总开关已开） */
  reportBillingGrayUids: list(process.env.REPORT_BILLING_GRAY_UIDS, []),
  /** 新钱包初始赠送余额（元）；0 = 关闭 */
  welcomeBalance: num(process.env.WELCOME_BALANCE, 10),
  /** 免费档位（逗号分隔）。默认 basic 免费，作为体验档 */
  freeTiers: list(process.env.FREE_TIERS, ['basic']),
  /** 会员每日可免费生成的次数（任意档位） */
  memberDailyFree: num(process.env.MEMBER_DAILY_FREE, 1),
  /** 不同举报人数达到该阈值时，目标用户自动转 invisible（等待人工确认） */
  moderationAutoHide: num(process.env.MODERATION_AUTO_HIDE, 5),

  // ===== 转盘 =====
  /** 转一次的价格（元）；0 = 免费 */
  wheelPrice: num(process.env.WHEEL_PRICE, 1),
  /** 会员每日免费转动次数 */
  memberDailySpins: num(process.env.MEMBER_DAILY_SPINS, 3),
  /** 单次最多取多少候选进内存打分（O(N)，见 services/wheel.js 的规模说明） */
  wheelPoolLimit: num(process.env.WHEEL_POOL_LIMIT, 200),
  /** 转盘扇区数（每扇区一个头像） */
  wheelSectors: num(process.env.WHEEL_SECTORS, 12),
  /** 排除最近 N 次已转到的对象，避免转来转去都是同一个人 */
  wheelRecentExclude: num(process.env.WHEEL_RECENT_EXCLUDE, 20),

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

/** 内置默认链：通义角色模型优先，Workers AI 兜底（与 Pages 侧默认完全一致） */
const DEFAULT_LLM_CHAIN = [
  'tongyi:qwen-plus-character',
  'tongyi:qwen-long',
  'workers-ai:@cf/zai-org/glm-4.7-flash',
  'workers-ai:@cf/qwen/qwen3-30b-a3b-fp8',
  'workers-ai:@cf/meta/llama-3.1-8b-instruct-fp8',
];

/**
 * 计算最终生效的模型链（有序、可跨提供方）。
 *
 * 规则：
 *   1. 设了 `LLM_CHAIN` → 完全按它来（`provider:model` 逗号分隔）；
 *   2. 否则若设了 `LLM_PROVIDER`（旧配置）→ 该 provider 的模型排前面，
 *      再把它之外的**已配置** provider 追加在后面兜底（这样"旧配置"也能享受到跨家兜底，
 *      而不是像以前那样整家挂了就全灭）；
 *   3. 都没设 → 内置默认（通义优先）。
 *
 * @returns {Array<{provider: string, model: string}>}
 */
export function resolveLlmChain() {
  const raw = env.llmChainEnv.length ? env.llmChainEnv : env.llmProviderSet ? [] : DEFAULT_LLM_CHAIN;
  let items = raw.length ? [...raw] : [];

  if (!items.length) {
    // 旧配置路径：LLM_PROVIDER 决定首选，其余已配置的 provider 自动兜底
    const primary = env.llmProvider;
    const primaryModels = primary === 'workers-ai' ? env.cf.chatModels : primary === 'openai' ? [env.openai.chatModel] : env.dashscope.chatModels;
    const prefix = primary === 'tongyi' ? 'tongyi' : primary;
    items = primaryModels.map((m) => `${prefix}:${m}`);

    if (primary !== 'workers-ai' && env.cf.accountId && env.cf.token) {
      items.push(...env.cf.chatModels.map((m) => `workers-ai:${m}`));
    }
    if (primary !== 'dashscope' && primary !== 'tongyi' && env.dashscope.key) {
      items.push(...env.dashscope.chatModels.map((m) => `tongyi:${m}`));
    }
  }

  // TONGYI_CHARACTER_MODEL 只覆盖链里第一个通义条目（与 FTVF 的语义一致）
  if (env.tongyiCharacterModel) {
    const i = items.findIndex((x) => x.startsWith('tongyi:') || x.startsWith('dashscope:'));
    if (i >= 0) items[i] = `tongyi:${env.tongyiCharacterModel}`;
    else items.unshift(`tongyi:${env.tongyiCharacterModel}`);
  }

  const parsed = [];
  for (const item of items) {
    const idx = item.indexOf(':');
    if (idx <= 0) {
      const model = String(item).trim();
      if (!model) continue;
      parsed.push({ provider: model.startsWith('@cf/') ? 'workers-ai' : 'tongyi', model });
      continue;
    }
    const provider = item.slice(0, idx).trim() === 'dashscope' ? 'tongyi' : item.slice(0, idx).trim();
    const model = item.slice(idx + 1).trim();
    if (!model) continue;
    parsed.push({ provider, model });
  }
  return parsed;
}

/** 供 /v1/health 输出：链里每一条是否具备调用条件（不泄漏密钥） */
export function llmChainStatus() {
  return resolveLlmChain().map((x) => ({
    ...x,
    configured:
      x.provider === 'tongyi'
        ? !!env.dashscope.key
        : x.provider === 'workers-ai'
          ? !!(env.cf.accountId && env.cf.token)
          : !!env.openai.key,
  }));
}

/** 供 /v1/health 输出，避免把密钥泄漏到日志或响应里 */
export function providerStatus() {
  const chain = llmChainStatus();
  // 实际生效的首选 = 链里第一个"具备调用条件"的条目（就是 llm.js 里第一个会真正被调用的模型）。
  //
  // 为什么不能用 env.llmProvider 顶上：那是**旧的单一提供方配置**。设了 LLM_CHAIN 之后
  // 它就不再决定用谁了 —— 2026-09-20 实际踩到：链已经切到通义并探测成功，而这里仍报
  // `provider=workers-ai`，我自己的 check-llm.mjs 据此打印"报告侧未切到通义"（假结论）。
  // 现在 llm 字段一律反映**真实生效**的首选，旧配置值单独放在 llmProviderEnv 里备查。
  const primary = chain.find((x) => x.configured) || chain[0] || null;
  return {
    embed: describe('embed', env.embedProvider),
    llm: primary
      ? { provider: primary.provider, model: primary.model, configured: true, source: 'llmChain' }
      : { provider: env.llmProvider, model: env.dashscope.chatModel, configured: false, source: 'none' },
    llmChain: chain,
    /** 旧配置项（LLM_PROVIDER）：现在只作为兜底与留痕，不再代表"实际在用谁" */
    llmProviderEnv: env.llmProvider,
    embedDims: env.embedDims,
    legacyApiBase: env.legacyApiBase,
    devLoginAllowed: env.allowDevLogin,
  };
}
