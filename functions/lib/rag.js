/**
 * 避坑 RAG：向量检索 + 关键词兜底
 * 索引由 npm run build:rag 预生成（functions/data/rag-index.json）
 */

import ragIndex from '../data/rag-index.json';

export const EMBED_MODEL = '@cf/qwen/qwen3-embedding-0.6b';
const TOP_K = 4;
const MIN_SCORE = 0.25;

let indexCache = null;

function getIndex() {
  if (indexCache) return indexCache;
  if (ragIndex?.items?.length) {
    indexCache = ragIndex;
    return indexCache;
  }
  return null;
}

function cosine(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
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

function extractVector(result) {
  if (Array.isArray(result)) {
    if (Array.isArray(result[0])) return result[0];
    if (typeof result[0] === 'number') return result;
  }
  if (result?.data) {
    const d = result.data;
    if (Array.isArray(d[0])) return d[0];
    if (Array.isArray(d)) return d;
  }
  if (result?.result) return extractVector(result.result);
  return null;
}

export async function embedText(env, text) {
  if (!env?.AI || !text?.trim()) return null;
  try {
    const result = await env.AI.run(EMBED_MODEL, { text: text.trim().slice(0, 2000) });
    return extractVector(result);
  } catch (err) {
    console.error('RAG embed failed:', err?.message || err);
    return null;
  }
}

function keywordRetrieve(query, items, k) {
  const q = query.toLowerCase();
  const scored = items.map((item) => {
    let score = 0;
    const blob = `${item.category} ${item.title} ${item.text}`.toLowerCase();
    if (item.category && q.includes(item.category)) score += 3;
    const terms = q.split(/[\s，。！？、；：""''（）]+/).filter((t) => t.length >= 2);
    for (const t of terms) {
      if (blob.includes(t)) score += 1;
    }
    if (/借钱|转账|投资|杀猪|网恋/.test(q) && item.category === '网恋') score += 2;
    if (/暧昧|备胎|确认关系/.test(q) && item.category === '暧昧') score += 2;
    if (/冷暴力|已读不回|消失|不回/.test(q) && item.category === '冷暴力') score += 2;
    if (/彩礼|见家长|结婚|订婚/.test(q) && (item.category === '彩礼' || item.category === '见家长')) score += 2;
    if (/出轨|第三者|暧昧边界/.test(q) && item.category === '出轨') score += 2;
    if (/相亲|催婚/.test(q) && item.category === '相亲') score += 2;
    if (/异地/.test(q) && item.category === '异地') score += 2;
    return { item, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => ({ ...x.item, score: x.score / 10, method: 'keyword' }));
}

export async function retrievePitfalls(env, query, k = TOP_K) {
  const index = getIndex();
  const items = index?.items || [];
  if (!items.length) {
    return { hits: [], context: '', method: 'none' };
  }

  const queryVec = await embedText(env, query);
  if (queryVec) {
    const ranked = items
      .map((item) => ({
        ...item,
        score: cosine(queryVec, item.vector),
        method: 'vector',
      }))
      .filter((x) => x.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    if (ranked.length) {
      return {
        hits: ranked.map(({ id, category, title, score, method }) => ({ id, category, title, score, method })),
        context: formatContext(ranked),
        method: 'vector',
      };
    }
  }

  const kw = keywordRetrieve(query, items, k);
  return {
    hits: kw.map(({ id, category, title, score, method }) => ({ id, category, title, score, method })),
    context: formatContext(kw),
    method: kw.length ? 'keyword' : 'none',
  };
}

function formatContext(hits) {
  return hits
    .map(
      (h, i) =>
        `案例${i + 1}「${h.title}」（${h.category}）\n${h.text.replace(/\n直线方案：/g, '\n方案：')}`
    )
    .join('\n\n');
}

export function isRagReady() {
  return !!getIndex()?.items?.length;
}
