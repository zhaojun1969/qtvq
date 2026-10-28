/**
 * 内容审核台账（P0-4）
 *
 * 为什么需要
 * ----------
 * 审核结论此前只进 `console.log`，无法回答三个必须回答的问题：
 *   ① 这条内容当时判了什么档位、由哪一层判的（L1 词表 / L2 云审核 / L3 LLM）？
 *   ② 用户申诉时，凭什么复议？
 *   ③ 监管部门要"内容审核记录"时，能拿出什么？
 *
 * 法定留存要求：《网络安全法》第二十一条要求网络日志留存**不少于六个月**，
 * 因此本集合用 `expiresAt` 上的 TTL 索引保留 180 天，由 MongoDB 自动清理。
 *
 * 隐私最小化（与 P0-1 数据境内化同一原则）
 * ----------------------------------------
 *   · `pass` 档位**不落原文** —— 正常用户内容没有必要再复制一份进台账；
 *   · 一律落 `textHash` + `textLength`，供"同一段文本是否被重复提交"的关联分析；
 *   · 只有 `review` / `block` 才落原文（复核与申诉必需），且截断至 5000 字；
 *   · 台账与业务数据一起存放在**境内** MongoDB。
 *
 * 失败策略
 * --------
 * 台账写入失败**绝不影响**内容审核主流程（只打日志）。台账是记录手段，不是准入手段。
 */
import crypto from 'node:crypto';
import { getDB } from '../config/db.js';

/** 与《网络安全法》第二十一条对齐 */
const RETENTION_DAYS = 180;

let indexReady = null;

async function ensureIndex(db) {
  if (!indexReady) {
    indexReady = (async () => {
      const col = db.collection('moderation_ledger');
      await col.createIndex({ traceId: 1 }, { unique: true });
      await col.createIndex({ createdAt: -1 });
      await col.createIndex({ action: 1, createdAt: -1 });
      await col.createIndex({ textHash: 1, createdAt: -1 });
      await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    })().catch((err) => {
      indexReady = null; // 失败不缓存，下次重试
      throw err;
    });
  }
  return indexReady;
}

export function newTraceId() {
  return crypto.randomBytes(8).toString('hex');
}

/** NFKC 归一后取 SHA-256 前 32 位：全角/半角、兼容字符不同但语义相同的文本会得到同一哈希 */
export function hashText(text) {
  const norm = String(text || '').normalize('NFKC');
  return crypto.createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 32);
}

/**
 * 写一条台账。永不抛错。
 * @returns {Promise<string|null>} traceId，失败返回 null
 */
export async function recordLedger(entry = {}) {
  try {
    const db = getDB();
    if (!db) return null;
    await ensureIndex(db);
    const now = new Date();
    const action = String(entry.action || 'pass');
    const text = String(entry.text || '');
    const doc = {
      traceId: entry.traceId || newTraceId(),
      field: String(entry.field || 'default').slice(0, 32),
      action,
      provider: String(entry.provider || 'unknown').slice(0, 32),
      categories: Array.isArray(entry.categories) ? entry.categories.slice(0, 10) : [],
      hits: Array.isArray(entry.hits) ? entry.hits.slice(0, 20) : [],
      degraded: !!entry.degraded,
      textHash: hashText(text),
      textLength: text.length,
      /* pass 不落原文：正常用户内容无需再复制一份进台账 */
      text: action === 'pass' ? null : text.slice(0, 5000),
      uid: entry.uid ? String(entry.uid).slice(0, 64) : null,
      clientId: entry.clientId ? String(entry.clientId).slice(0, 64) : null,
      /* 人工复核结果，由运营台回填；null 表示尚未人工处理 */
      humanDecision: null,
      operator: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + RETENTION_DAYS * 24 * 3600 * 1000),
    };
    await db.collection('moderation_ledger').insertOne(doc);
    return doc.traceId;
  } catch (err) {
    console.error('[moderation-ledger] 写入失败（不影响审核主流程）:', err.message);
    return null;
  }
}

/** 供运营台/排查使用 */
export async function listLedger({ limit = 50, action = null } = {}) {
  const db = getDB();
  const q = action ? { action } : {};
  return db
    .collection('moderation_ledger')
    .find(q)
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(limit) || 50, 200))
    .toArray();
}

/** 按 textHash 反查同一段文本的全部审核记录（申诉与重复提交分析用） */
export async function ledgerByHash(textHash) {
  const db = getDB();
  return db
    .collection('moderation_ledger')
    .find({ textHash: String(textHash) })
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();
}

/** 台账统计（供 `/v1/safety/status` 展示真实覆盖率） */
export async function ledgerStats() {
  const db = getDB();
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const [total, today, blocked, reviewed] = await Promise.all([
    db.collection('moderation_ledger').estimatedDocumentCount(),
    db.collection('moderation_ledger').countDocuments({ createdAt: { $gte: since } }),
    db.collection('moderation_ledger').countDocuments({ action: 'block', createdAt: { $gte: since } }),
    db.collection('moderation_ledger').countDocuments({ action: 'review', createdAt: { $gte: since } }),
  ]);
  return { total, last24h: today, blocked24h: blocked, reviewed24h: reviewed, retentionDays: RETENTION_DAYS };
}
