/**
 * Embedding 服务：dashscope（默认，境内可用）/ workers-ai（复用现网）/ openai
 *
 * 维度固定 1024：与现网 Cloudflare `@cf/qwen/qwen3-embedding-0.6b` 一致，
 * 因此新老向量在同一维度空间内可比，未来切换供应商或复用旧索引都不会崩。
 */
import { env } from '../config/env.js';
import { ApiError } from '../lib/http.js';

const BATCH = 10; // dashscope text-embedding-v3 单次输入上限较保守，取 10
const MAX_CHARS = 2000;

function clampText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
}

function pickVector(payload) {
  const d = payload?.data;
  if (Array.isArray(d)) {
    if (Array.isArray(d[0]?.embedding)) return d[0].embedding;
    if (Array.isArray(d[0]) && typeof d[0][0] === 'number') return d[0];
  }
  const r = payload?.result;
  if (r) {
    if (Array.isArray(r.data) && Array.isArray(r.data[0])) return r.data[0];
    if (Array.isArray(r.data) && typeof r.data[0] === 'number') return r.data;
    if (Array.isArray(r)) return r;
  }
  return null;
}

function collectVectors(payload, expected) {
  const d = payload?.data;
  if (Array.isArray(d) && d.length === expected && typeof d[0]?.embedding !== 'undefined') {
    return d.map((x) => x.embedding);
  }
  const one = pickVector(payload);
  return one ? [one] : [];
}

async function requestJson(url, { method = 'POST', headers, body }) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应，保留原文用于报错 */
  }
  if (!res.ok) {
    const detail = json?.error?.message || json?.message || json?.errors?.[0]?.message || text.slice(0, 300);
    throw new ApiError(502, `Embedding 调用失败(${res.status}): ${detail}`, 'E_EMBED_UPSTREAM');
  }
  return json;
}

async function embedBatchDashscope(texts) {
  return requestJson(`${env.dashscope.base}/embeddings`, {
    headers: { Authorization: `Bearer ${env.dashscope.key}` },
    body: {
      model: env.dashscope.embedModel,
      input: texts,
      dimensions: env.embedDims,
      encoding_format: 'float',
    },
  });
}

async function embedBatchWorkers(texts) {
  // Workers AI REST：单次一个 text，逐条调用
  const out = [];
  for (const t of texts) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${env.cf.accountId}/ai/run/${env.cf.embedModel}`;
    const json = await requestJson(url, {
      headers: { Authorization: `Bearer ${env.cf.token}` },
      body: { text: t },
    });
    const v = pickVector(json);
    if (v) out.push(v);
  }
  return { data: out.map((embedding) => ({ embedding })) };
}

async function embedBatchOpenAI(texts) {
  return requestJson(`${env.openai.base}/embeddings`, {
    headers: { Authorization: `Bearer ${env.openai.key}` },
    body: { model: env.openai.embedModel, input: texts, dimensions: env.embedDims },
  });
}

async function callEmbed(texts) {
  switch (env.embedProvider) {
    case 'dashscope':
      if (!env.dashscope.key) throw new ApiError(503, 'DASHSCOPE_API_KEY 未配置', 'E_NO_EMBED_KEY');
      return embedBatchDashscope(texts);
    case 'workers-ai':
      if (!env.cf.accountId || !env.cf.token) throw new ApiError(503, 'CF_ACCOUNT_ID / CF_API_TOKEN 未配置', 'E_NO_EMBED_KEY');
      return embedBatchWorkers(texts);
    case 'openai':
      if (!env.openai.key) throw new ApiError(503, 'OPENAI_KEY 未配置', 'E_NO_EMBED_KEY');
      return embedBatchOpenAI(texts);
    default:
      throw new ApiError(500, `未知 EMBED_PROVIDER: ${env.embedProvider}`, 'E_BAD_PROVIDER');
  }
}

/** 单条向量；失败返回 null，让上层走降级逻辑（不阻塞报告生成） */
export async function embedOne(text) {
  const t = clampText(text);
  if (!t) return null;
  try {
    const payload = await callEmbed([t]);
    const vectors = collectVectors(payload, 1);
    return vectors[0] || null;
  } catch (err) {
    console.error('[embed] failed:', err.message);
    return null;
  }
}

/** 批量向量；顺序与入参严格一致，失败项为 null */
export async function embedMany(texts) {
  const cleaned = texts.map(clampText);
  const out = new Array(cleaned.length).fill(null);
  for (let i = 0; i < cleaned.length; i += BATCH) {
    const slice = cleaned.slice(i, i + BATCH);
    const idx = slice.map((t, k) => (t ? i + k : -1)).filter((n) => n >= 0);
    const inputs = slice.filter(Boolean);
    if (!inputs.length) continue;
    try {
      const payload = await callEmbed(inputs);
      const vectors = collectVectors(payload, inputs.length);
      idx.forEach((target, k) => {
        out[target] = vectors[k] || null;
      });
    } catch (err) {
      console.error('[embed] batch failed:', err.message);
    }
  }
  return out;
}

/** 资料 → 向量文本（全项目唯一构造口径，改这里就等于全站改） */
export function profileText(user = {}) {
  const parts = [];
  if (user.gender) parts.push(user.gender === 'male' ? '男性' : user.gender === 'female' ? '女性' : String(user.gender));
  if (user.age) parts.push(`${user.age}岁`);
  if (user.city) parts.push(String(user.city));
  if (user.job) parts.push(`职业:${user.job}`);
  if (user.height) parts.push(`身高:${user.height}`);
  if (Array.isArray(user.tags) && user.tags.length) parts.push(`标签:${user.tags.join('、')}`);
  if (user.intro) parts.push(`简介:${user.intro}`);
  return parts.join(' ');
}

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
