/**
 * 对话模型"降级链"（Pages 侧唯一入口）
 *
 * 为什么要有这个文件
 * ----------------
 * 原来 Pages 侧只认一个提供方：Workers AI 绑定（`env.AI`）。模型名写死在 chat.js/health.js 两处，
 * 且**都是境外服务**。业务方 2026-09-18 要求：改用通义的角色模型，并把参数做得和 FTVF 项目一致
 * （`D:\ftvf夫道`），便于维护与充值。
 *
 * 关于"通义星辰（tongyi.aliyun.com/character/）"
 * ------------------------------------------
 * 那个页面是**通义 App 的角色页，没有公开 API**。FTVF 项目实测过：把该角色编号当 app_id 调用，
 * 返回 `403 App.AccessDenied`，其文档明确写了"通义 App 的角色页没有公开 API"。
 * 等价且可用的形态是**阿里云百炼（DashScope）的角色扮演模型 `qwen-plus-character`**，
 * 人设写在 system 消息里。已用本项目现有的 DASHSCOPE_API_KEY 实测可用。
 *
 * 参数命名与 FTVF 保持一致（FTVF 的 `docs/NVC转译AI与Voyage规责.md` / `夫问栏目规责.md`）：
 *   LLM_CHAIN              形如 `provider:model,provider:model` 的有序链（本项目新增，两边同名）
 *   DASHSCOPE_API_KEY      百炼 API Key（与向量检索同一把 key、同一个账号、同一个账单）
 *   TONGYI_BASE_URL        百炼地址；OpenAI 兼容模式默认 `…/compatible-mode/v1`
 *   TONGYI_CHARACTER_MODEL 角色模型名，默认 `qwen-plus-character`
 *
 * 设计要点
 * --------
 * - **链是有序的、跨提供方的**：百炼 → Workers AI → 上层兜底文案。理由与 FTVF 相同：
 *   任一家配额波动（实测百炼会返回 `Free quota exhausted`）都不该让用户看到模板话术。
 * - **逐个记录失败原因**，绝不只留最后一条（这条教训来自 health.js 的假阴性）。
 * - **不抛异常**：调用方拿 `{ text: null, errors }` 自己决定怎么兜底。
 */

/** 内置默认链：通义角色模型优先，Workers AI 兜底（Workers AI 已绑定、不额外计费） */
export const DEFAULT_CHAIN = [
  'tongyi:qwen-plus-character',
  'tongyi:qwen-long',
  'workers-ai:@cf/zai-org/glm-4.7-flash',
  'workers-ai:@cf/qwen/qwen3-30b-a3b-fp8',
  'workers-ai:@cf/meta/llama-3.1-8b-instruct-fp8',
];

const TIMEOUT_MS = 45000;

/** 通义/百炼的 OpenAI 兼容地址（FTVF 的 TONGYI_BASE_URL 若指到 api/v1，这里会补成兼容模式） */
export function tongyiBase(env) {
  const raw = String(env?.TONGYI_BASE_URL || env?.DASHSCOPE_BASE || '').trim();
  const base = raw || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  return base.replace(/\/$/, '');
}

export function tongyiKey(env) {
  return String(env?.DASHSCOPE_API_KEY || env?.TONGYI_API_KEY || '').trim();
}

export function isTongyiConfigured(env) {
  return !!tongyiKey(env);
}

/**
 * 解析链配置。
 * @returns {Array<{provider: string, model: string}>}
 */
export function resolveChain(env) {
  const raw = String(env?.LLM_CHAIN || '').trim();
  let list = raw
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : [...DEFAULT_CHAIN];

  // TONGYI_CHARACTER_MODEL 只覆盖"链里第一个通义条目"的模型名，
  // 这样"换角色模型"不必动整条链（与 FTVF 的 TONGYI_CHARACTER_MODEL 语义一致）。
  const charModel = String(env?.TONGYI_CHARACTER_MODEL || '').trim();
  if (charModel) {
    const i = list.findIndex((x) => x.startsWith('tongyi:'));
    if (i >= 0) list[i] = `tongyi:${charModel}`;
    else list.unshift(`tongyi:${charModel}`);
  }

  const parsed = [];
  for (const item of list) {
    const idx = item.indexOf(':');
    if (idx <= 0) {
      // 只写了模型名（形如 `qwen-plus-character`）→ 按通义处理；带 `@cf/` 前缀的按 Workers AI
      const model = item.trim();
      if (!model) continue;
      parsed.push({ provider: model.startsWith('@cf/') ? 'workers-ai' : 'tongyi', model });
      continue;
    }
    const provider = item.slice(0, idx).trim();
    const model = item.slice(idx + 1).trim();
    if (!model) continue;
    parsed.push({ provider: provider === 'dashscope' ? 'tongyi' : provider, model });
  }
  return parsed;
}

/** 供 /api/health 输出：链里各条是否"具备调用条件"，不泄漏密钥 */
export function describeChain(env) {
  const tongyiReady = isTongyiConfigured(env);
  const cfReady = !!env?.AI;
  return resolveChain(env).map((x) => ({
    ...x,
    configured: x.provider === 'tongyi' ? tongyiReady : x.provider === 'workers-ai' ? cfReady : false,
  }));
}

/** 是否至少有一条链路可用 */
export function isLlmReady(env) {
  return describeChain(env).some((x) => x.configured);
}

/**
 * 推理模型的 token 预算要单独放大。
 *
 * 实测踩到的坑：Workers AI 的 glm-4.7-flash / qwen3 系列会在 `message.reasoning` 里先输出思考，
 * 这段**同样计入 max_tokens**；预算给小了会出现 `content: null` + `finish_reason: "length"`，
 * 看起来像"模型返回空"。
 */
export function isReasoningLike(model) {
  return /glm-4\.[0-9]|qwen3|qwq|deepseek|gpt-oss|thinking|reasoning/i.test(String(model));
}

export function budgetFor(model, maxTokens) {
  return isReasoningLike(model) ? Math.min(4096, Math.max(2048, Math.round(maxTokens * 2 + 512))) : maxTokens;
}

/**
 * 从各家返回结构里取文本。故意写得很宽：不同提供方/不同模型版本的字段名不一致，
 * 少认一个字段就会把"模型答了"误判成"模型挂了"（health.js 曾因此报了两次假阴性）。
 */
export function extractText(response) {
  if (typeof response === 'string') return response.trim() || null;
  const c = response?.choices?.[0]?.message?.content;
  if (typeof c === 'string' && c.trim()) return c;
  if (Array.isArray(c)) {
    const joined = c.map((x) => x?.text || '').join('');
    if (joined.trim()) return joined;
  }
  const candidates = [
    response?.response,
    response?.result?.response,
    response?.output_text,
    response?.result?.output_text,
  ];
  for (const x of candidates) {
    if (typeof x === 'string' && x.trim()) return x;
  }
  if (response?.result) return extractText(response.result);
  return null;
}

function extractReasoning(response) {
  return (
    response?.choices?.[0]?.message?.reasoning ||
    response?.result?.choices?.[0]?.message?.reasoning ||
    null
  );
}

function finishReason(response) {
  return (
    response?.choices?.[0]?.finish_reason || response?.result?.choices?.[0]?.finish_reason || null
  );
}

async function callTongyi(env, { model, messages, maxTokens, temperature }) {
  const key = tongyiKey(env);
  if (!key) throw new Error('DASHSCOPE_API_KEY 未配置（百炼/通义不可用）');
  const res = await fetch(`${tongyiBase(env)}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 保留原文用于报错 */
  }
  if (!res.ok) {
    // 百炼的错误码很有信息量，原样带出来：Free quota exhausted / InvalidApiKey / ModelNotFound …
    const code = json?.error?.code || json?.code || `HTTP_${res.status}`;
    const msg = json?.error?.message || json?.message || text.slice(0, 200);
    throw new Error(`HTTP ${res.status} ${code}: ${msg}`);
  }
  return json;
}

async function callWorkersAi(env, { model, messages, maxTokens, temperature }) {
  if (!env?.AI) throw new Error('Workers AI 未绑定');
  return env.AI.run(model, { messages, temperature, max_tokens: maxTokens });
}

/**
 * 依次走链，返回第一个"拿到了正式回答"的结果。
 *
 * @returns {Promise<{text: string|null, provider: string|null, model: string|null,
 *                    attempts: number, errors: Array<{provider:string,model:string,error:string}>,
 *                    reasoningOnly: {text:string,provider:string,model:string}|null}>}
 */
export async function runChatChain(env, { messages, maxTokens = 1200, temperature = 0.8 }) {
  const chain = resolveChain(env);
  const errors = [];
  let reasoningOnly = null;

  for (const { provider, model } of chain) {
    const budget = budgetFor(model, maxTokens);
    try {
      const payload =
        provider === 'tongyi'
          ? await callTongyi(env, { model, messages, maxTokens: budget, temperature })
          : provider === 'workers-ai'
            ? await callWorkersAi(env, { model, messages, maxTokens: budget, temperature })
            : (() => {
                throw new Error(`未知 provider: ${provider}`);
              })();

      const text = extractText(payload);
      if (text) {
        return { text: String(text).trim(), provider, model, attempts: errors.length + 1, errors, reasoningOnly };
      }

      // 只有思考过程：记下来继续试下一个，但作为最后的兜底保留（宁可给思考过程也不给无关模板）
      const reasoning = extractReasoning(payload);
      if (reasoning && !reasoningOnly) reasoningOnly = { text: reasoning, provider, model };
      const fr = finishReason(payload);
      errors.push({
        provider,
        model,
        error: `返回内容为空${fr === 'length' ? `（finish_reason=length，疑似思考过程占满 ${budget} tokens）` : ''}`,
      });
    } catch (err) {
      errors.push({ provider, model, error: err?.message || String(err) });
      console.error(`[llm-chain] ${provider}:${model} 失败: ${err?.message || err}`);
    }
  }

  return { text: null, provider: null, model: null, attempts: errors.length, errors, reasoningOnly };
}
