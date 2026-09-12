/**
 * 对话模型服务：dashscope（默认）/ workers-ai（复用现网模型链）/ openai
 *
 * 与现网 `functions/api/chat.js` 同一套降级思想：失败不抛给用户，而是返回
 * null 让上层决定用兜底文案 —— 报告生成不能因为模型抖动而整体 500。
 */
import { env } from '../config/env.js';
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

/**
 * @returns {Promise<{text: string|null, model: string, provider: string, error?: string}>}
 */
export async function chat({ messages, temperature = 0.8, maxTokens = 1200 }) {
  const provider = env.llmProvider;
  const model =
    provider === 'dashscope' ? env.dashscope.chatModel : provider === 'workers-ai' ? env.cf.chatModel : env.openai.chatModel;

  try {
    let payload;
    if (provider === 'dashscope') {
      if (!env.dashscope.key) throw new ApiError(503, 'DASHSCOPE_API_KEY 未配置', 'E_NO_LLM_KEY');
      payload = await chatCompletions({
        base: env.dashscope.base,
        key: env.dashscope.key,
        model,
        messages,
        temperature,
        maxTokens,
      });
    } else if (provider === 'workers-ai') {
      if (!env.cf.accountId || !env.cf.token) throw new ApiError(503, 'CF_ACCOUNT_ID / CF_API_TOKEN 未配置', 'E_NO_LLM_KEY');
      payload = await chatWorkers({ model, messages, temperature, maxTokens });
    } else {
      if (!env.openai.key) throw new ApiError(503, 'OPENAI_KEY 未配置', 'E_NO_LLM_KEY');
      payload = await chatCompletions({
        base: env.openai.base,
        key: env.openai.key,
        model,
        messages,
        temperature,
        maxTokens,
      });
    }

    const text = extractText(payload);
    if (!text) return { text: null, model, provider, error: 'EMPTY_RESPONSE' };
    return { text: String(text).trim(), model, provider };
  } catch (err) {
    console.error('[llm] failed:', err.message);
    return { text: null, model, provider, error: err.message };
  }
}
