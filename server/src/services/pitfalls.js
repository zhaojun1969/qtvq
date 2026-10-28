/**
 * 避坑知识库检索（本项目的独有护城河）
 *
 * 现网已有 50+ 条真实避坑案例（`js/data.js` + `js/data-extra.js`），
 * 通过 `scripts/import-pitfalls.mjs` 写入 MongoDB `pitfalls` 集合（含 1024 维向量）。
 *
 * 重要：自建 MongoDB 没有 $vectorSearch，但避坑库只有几十条，
 * 全量取回在内存里算余弦的代价可以忽略 —— 这是本方案刻意选的规模适配。
 * 只有当条目数进入万级时才需要重新评估（届时用独立向量服务，而不是 Atlas）。
 */
import { getDB } from '../config/db.js';
import { cosine, embedOne } from './embed.js';

const TOP_K = 3;
const MIN_SCORE = 0.25;

let cache = null;
let cacheAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function loadAll() {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL_MS) return cache;
  const db = getDB();
  const docs = await db
    .collection('pitfalls')
    .find({}, { projection: { id: 1, category: 1, title: 1, lesson: 1, steps: 1, cost: 1, vector: 1 } })
    .toArray();
  cache = docs;
  cacheAt = now;
  return docs;
}

export function invalidatePitfallCache() {
  cache = null;
  cacheAt = 0;
}

/**
 * 公开的避坑列表（按分类/关键词分页取）。
 *
 * 为什么需要它：本项目**原来没有 pitfalls 的 HTTP 接口** —— 网页端用的是本地静态数据
 * （`js/data.js`），而 MongoDB 里的 `pitfalls` 集合只服务于报告生成的向量检索。
 * 结果就是：鸿蒙/App 这类"没有本地静态数据"的端**拿不到避坑内容**，
 * 只能各自抄一份（必然漂移）。2026-09-22 写鸿蒙工程时实际踩到：
 * 我按记忆写了 `/v1/profile/pitfalls`，而那个路由根本不存在（会 404）。
 *
 * 投影只给"能公开"的字段，**不含 vector**（1024 维向量既没用又占带宽），
 * 也不返回任何用户数据。
 *
 * @param {{category?: string, keyword?: string, page?: number, pageSize?: number}} opts
 */
export async function listPitfalls({ category = '', keyword = '', page = 1, pageSize = 20 } = {}) {
  const docs = await loadAll();
  const kw = String(keyword || '').trim().toLowerCase();

  let items = docs;
  if (category) {
    const c = String(category).trim();
    items = items.filter((d) => String(d.category || '') === c);
  }
  if (kw) {
    items = items.filter((d) => {
      const blob = `${d.category || ''} ${d.title || ''} ${d.lesson || ''} ${d.steps || ''}`.toLowerCase();
      return blob.includes(kw);
    });
  }

  const size = Math.min(50, Math.max(1, Number(pageSize) || 20));
  const p = Math.max(1, Number(page) || 1);
  const total = items.length;
  const slice = items.slice((p - 1) * size, p * size);

  return {
    total,
    page: p,
    pageSize: size,
    categories: [...new Set(docs.map((d) => String(d.category || '')).filter(Boolean))].sort(),
    items: slice.map((d) => ({
      id: d.id,
      category: d.category || '',
      title: d.title || '',
      // 面向用户的正文：优先"教训"，其次"步骤"（两者都是给读者看的）
      lesson: d.lesson || '',
      steps: d.steps || '',
      cost: d.cost || '',
    })),
  };
}

/** 关键词兜底：模型/向量不可用时仍能给出相关案例 */
function keywordTop(text, docs, k) {
  const q = String(text || '').toLowerCase();
  const terms = q.split(/[\s，。！？、；：""''（）]+/).filter((t) => t.length >= 2);
  return docs
    .map((d) => {
      const blob = `${d.category} ${d.title} ${d.lesson || ''} ${d.steps || ''}`.toLowerCase();
      let score = 0;
      if (d.category && q.includes(String(d.category).toLowerCase())) score += 3;
      for (const t of terms) if (blob.includes(t)) score += 1;
      return { doc: d, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => ({ ...x.doc, score: Math.min(0.9, x.score / 10), method: 'keyword' }));
}

/**
 * @param {string} queryText 用于检索的合成文本（双方标签/简介/用户追问）
 * @param {number} k
 */
export async function retrievePitfalls(queryText, k = TOP_K) {
  const docs = await loadAll();
  if (!docs.length) return { hits: [], method: 'empty' };

  const qVec = await embedOne(queryText);
  if (qVec) {
    const ranked = docs
      .filter((d) => Array.isArray(d.vector) && d.vector.length === qVec.length)
      .map((d) => ({ ...d, score: cosine(qVec, d.vector), method: 'vector' }))
      .filter((d) => d.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    if (ranked.length) return { hits: ranked, method: 'vector' };
  }

  const kw = keywordTop(queryText, docs, k);
  return { hits: kw, method: kw.length ? 'keyword' : 'none' };
}

export function formatPitfalls(hits) {
  if (!hits?.length) return '';
  return hits
    .map((h, i) => `案例${i + 1}「${h.title}」（${h.category}）\n教训：${h.lesson || '（无）'}\n方案：${h.steps || '（无）'}`)
    .join('\n\n');
}

export function publicHits(hits) {
  return (hits || []).map((h) => ({ id: h.id, category: h.category, title: h.title, score: Number((h.score || 0).toFixed(3)) }));
}
