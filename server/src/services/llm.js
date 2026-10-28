/**
 * 对话模型服务：按 `resolveLlmChain()` 的有序链依次尝试（可跨提供方）
 *
 * 与 Pages 侧 `functions/lib/llm-chain.js` 同语义，环境变量同名（`LLM_CHAIN` /
 * `DASHSCOPE_API_KEY` / `TONGYI_CHARACTER_MODEL`），换模型只改配置不改代码。
 *
 * 与现网 `functions/api/chat.js` 同一套降级思想：失败不抛给用户，而是返回
 * null 让上层决定用兜底文案 —— 报告生成不能因为模型抖动而整体 500。
 */
import { env, resolveLlmChain } from '../config/env.js';
import { ApiError } from '../lib/http.js';

const TIMEOUT_MS = 45000;

function extractText(payload) {
  if (typeof payload === 'string') return payload;
  const c = payload?.choices?.[0]?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => x?.text || '').join('');
  const r = payload?.result;
  if (typeof r?.response === 'string') return r.response;
  if (typeof payload?.response === 'string') return payload.response;
  if (r) return extractText(r);
  return null;
}

async function postJson(url, headers, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* keep raw */
    }
    if (!res.ok) {
      const detail = json?.error?.message || json?.message || text.slice(0, 300);
      throw new ApiError(502, `模型调用失败(${res.status}): ${detail}`, 'E_LLM_UPSTREAM');
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** OpenAI 兼容 /chat/completions 形态（dashscope 与 openai 都是这个形状） */
async function chatCompletions({ base, key, model, messages, temperature, maxTokens }) {
  return postJson(
    `${base}/chat/completions`,
    { Authorization: `Bearer ${key}` },
    { model, messages, temperature, max_tokens: maxTokens },
  );
}

async function chatWorkers({ model, messages, temperature, maxTokens }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.cf.accountId}/ai/run/${model}`;
  return postJson(url, { Authorization: `Bearer ${env.cf.token}` }, { messages, temperature, max_tokens: maxTokens });
}

async function callOpenAiCompatible({ base, key, model, messages, temperature, maxTokens }) {
  return chatCompletions({ base, key, model, messages, temperature, maxTokens });
}

/**
 * 推理模型的 token 预算要单独放大。
 *
 * 实测踩到的坑：Workers AI 的 `@cf/zai-org/glm-4.7-flash` 与
 * `@cf/qwen/qwen3-30b-a3b-fp8` 会在 `message.reasoning` 里先输出一大段思考，
 * 这段**同样计入 max_tokens**。预算给小了就会出现
 * `content: null` + `finish_reason: "length"` —— 看起来像「返回内容为空」，
 * 实际是被思考过程吃光了额度。
 *
 * （Pages 侧 `functions/lib/llm-chain.js` 里有一份同样的实现 —— 两侧运行环境不同、
 *   没有共享包，所以这份重复是刻意的；改动时请同时改两处，`npm run check:llm` 会暴露不一致。）
 */
function isReasoningLike(model) {
  return /glm-4\.[0-9]|qwen3|qwq|deepseek|gpt-oss|thinking|reasoning/i.test(String(model));
}

function budgetFor(model, maxTokens) {
  if (!isReasoningLike(model)) return maxTokens;
  return Math.min(4096, Math.max(2048, Math.round(maxTokens * 2 + 512)));
}

/**
 * 依次尝试模型降级链，返回第一个成功的结果。
 *
 * 为什么要链、且为什么**必须能跨提供方**：实测百炼在「仅使用免费额度」模式下会返回
 * `403 AllocationQuota.FreeTierOnly`（英文为 `Free quota exhausted`），
 * 若链只在一家内部兜底，整家额度用尽时整份报告就会退化成兜底文案。
 * 跨提供方后，百炼不行还能落到已绑定的 Workers AI。
 *
 * @returns {Promise<{text: string|null, model: string, provider: string, attempts?: number, error?: string}>}
 */
export async function chat({ messages, temperature = 0.8, maxTokens = 1200 }) {
  const chain = resolveLlmChain();
  const errors = [];

  for (const { provider, model } of chain) {
    try {
      // 推理模型要把思考过程的 token 也算进去
      const budget = budgetFor(model, maxTokens);
      let payload;
      if (provider === 'tongyi') {
        if (!env.dashscope.key) throw new ApiError(503, 'DASHSCOPE_API_KEY 未配置', 'E_NO_LLM_KEY');
        payload = await callOpenAiCompatible({
          base: env.dashscope.base,
          key: env.dashscope.key,
          model,
          messages,
          temperature,
          maxTokens: budget,
        });
      } else if (provider === 'workers-ai') {
        if (!env.cf.accountId || !env.cf.token) throw new ApiError(503, 'CF_ACCOUNT_ID / CF_API_TOKEN 未配置', 'E_NO_LLM_KEY');
        payload = await chatWorkers({ model, messages, temperature, maxTokens: budget });
      } else if (provider === 'openai') {
        if (!env.openai.key) throw new ApiError(503, 'OPENAI_KEY 未配置', 'E_NO_LLM_KEY');
        payload = await callOpenAiCompatible({
          base: env.openai.base,
          key: env.openai.key,
          model,
          messages,
          temperature,
          maxTokens: budget,
        });
      } else {
        throw new ApiError(400, `未知模型提供方：${provider}`, 'E_BAD_LLM_PROVIDER');
      }

      const text = extractText(payload);
      if (!text) {
        const finish =
          payload?.result?.choices?.[0]?.finish_reason || payload?.choices?.[0]?.finish_reason || null;
        const reasoningLen = (payload?.result?.choices?.[0]?.message?.reasoning || '').length;
        errors.push(
          `${provider}:${model}: 返回内容为空${finish === 'length' ? `（finish_reason=length，疑似思考过程占满 ${budget} tokens${reasoningLen ? `，reasoning 已 ${reasoningLen} 字` : ''}）` : ''}`,
        );
        continue;
      }
      return { text: String(text).trim(), model, provider, attempts: errors.length + 1 };
    } catch (err) {
      console.error(`[llm] ${provider}:${model} 失败: ${err.message}`);
      errors.push(`${provider}:${model}: ${err.message}`);
    }
  }

  return { text: null, model: chain[0]?.model || null, provider: chain[0]?.provider || null, error: errors.join(' | ') };
}
