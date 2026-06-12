#!/usr/bin/env node
/**
 * 构建避坑 RAG 向量索引
 * 用法：npm run build:rag
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PITFALLS, HOT_TOPICS, TOPICS } from '../../js/data.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const OUT = join(ROOT, 'functions/data/rag-index.json');
const EMBED_MODEL = '@cf/qwen/qwen3-embedding-0.6b';
const BATCH = 8;

function loadCfEnv() {
  try {
    const path = join(ROOT, 'cf.env');
    const text = readFileSync(path, 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const i = t.indexOf('=');
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      if (k && !process.env[k]) process.env[k] = v;
    }
  } catch {
    /* optional */
  }
}

function pitfallChunk(p) {
  return `[${p.category}] ${p.title}\n教训：${p.lesson}\n直线方案：${p.steps}\n代价：${p.cost}`;
}

function buildChunks() {
  const items = PITFALLS.map((p) => ({
    id: p.id,
    category: p.category,
    title: p.title,
    text: pitfallChunk(p),
  }));

  for (const hot of HOT_TOPICS) {
    items.push({
      id: `hot-${hot.text.slice(0, 12)}`,
      category: '热点',
      title: hot.text.slice(0, 40),
      text: `热点问题：${hot.text}\n说明：Q问用户高频提问，回答需给出3步直线方案。`,
    });
  }

  for (const topic of TOPICS) {
    items.push({
      id: `topic-${topic.id}`,
      category: '专题',
      title: topic.name,
      text: `专题：${topic.name}\n${topic.desc}\n相关案例ID：${topic.pitIds.join(',')}`,
    });
  }

  return items;
}

function extractVectors(apiJson) {
  const r = apiJson?.result ?? apiJson;
  if (Array.isArray(r)) {
    if (Array.isArray(r[0])) return r;
    if (typeof r[0] === 'number') return [r];
  }
  if (r?.data) {
    if (Array.isArray(r.data[0])) return r.data;
    return [r.data];
  }
  throw new Error('无法解析 embedding 响应: ' + JSON.stringify(apiJson).slice(0, 200));
}

async function embedBatch(token, accountId, texts) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${EMBED_MODEL}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: texts }),
    }
  );
  const json = await res.json();
  if (!json.success) {
    throw new Error(json.errors?.[0]?.message || `HTTP ${res.status}`);
  }
  return extractVectors(json);
}

async function main() {
  loadCfEnv();
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || 'bb7eb342a5cfde7c0a84cd9bd519a859';
  if (!token) {
    console.error('ERROR: 需要 cf.env 中的 CLOUDFLARE_API_TOKEN');
    process.exit(1);
  }

  const chunks = buildChunks();
  console.log(`>> 共 ${chunks.length} 条避坑知识块，模型 ${EMBED_MODEL}`);

  const indexed = [];
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const texts = batch.map((c) => c.text);
    process.stdout.write(`>> Embedding ${i + 1}-${i + batch.length}/${chunks.length}...\r`);
    const vectors = await embedBatch(token, accountId, texts);
    if (vectors.length !== batch.length) {
      throw new Error(`批次向量数不匹配: ${vectors.length} vs ${batch.length}`);
    }
    batch.forEach((c, j) => {
      indexed.push({ ...c, vector: vectors[j] });
    });
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n>> 写入 ${OUT}`);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify({
      version: 1,
      model: EMBED_MODEL,
      builtAt: new Date().toISOString(),
      count: indexed.length,
      items: indexed,
    })
  );
  console.log(`>> OK ${indexed.length} vectors`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
