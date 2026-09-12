/**
 * MongoDB 连接与索引
 *
 * 关于向量检索：自建 MongoDB（非 Atlas）没有 $vectorSearch。
 * 本项目的配对报告只需要「一对用户之间」的相似度，不需要全库 ANN 召回，
 * 因此直接在 Node 内做余弦计算即可 —— 这正好绕开了计划书里
 * 「一键部署 Docker 就建不了 Atlas 向量索引」的自相矛盾（见方案 §1.3 矛盾 1）。
 * 若日后需要全库召回，再单独评估 Atlas（含数据出境问题）或独立向量服务。
 */
import { MongoClient } from 'mongodb';
import { env } from './env.js';

let client = null;
let db = null;

export async function connectDB() {
  if (db) return db;

  client = new MongoClient(env.mongoUri, {
    serverSelectionTimeoutMS: 8000,
    maxPoolSize: 10,
  });
  await client.connect();
  db = client.db(env.mongoDb);
  await ensureIndexes(db);
  return db;
}

export function getDB() {
  if (!db) throw new Error('MongoDB 未连接：请先 await connectDB()');
  return db;
}

export async function closeDB() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

async function ensureIndexes(database) {
  await database.collection('users').createIndexes([
    // _id 直接复用现有 Cloudflare 体系的 uid（u_xxx），无需映射表
    { key: { status: 1 } },
    { key: { gender: 1, status: 1 } },
    { key: { updatedAt: -1 } },
  ]);

  await database.collection('pitfalls').createIndexes([
    { key: { category: 1 } },
    { key: { id: 1 }, unique: true },
  ]);

  await database.collection('reports').createIndexes([
    { key: { uid: 1, createdAt: -1 } },
    { key: { targetUid: 1 } },
    { key: { shareToken: 1 }, sparse: true },
  ]);

  await database.collection('invites').createIndexes([
    { key: { token: 1 }, unique: true },
    { key: { fromUid: 1, createdAt: -1 } },
  ]);

  await database.collection('qa_pairs').createIndexes([{ key: { uid: 1, createdAt: -1 } }]);

  // 钱包账本：uid + 流水时间；幂等键唯一（重复请求靠它拦截，而不是靠应用层判断）
  await database.collection('wallet_ledger').createIndexes([
    { key: { uid: 1, createdAt: -1 } },
    { key: { idempotencyKey: 1 }, unique: true, sparse: true },
    { key: { uid: 1, reason: 1, createdAt: -1 } },
  ]);

  await database.collection('moderation').createIndexes([
    { key: { status: 1, createdAt: -1 } },
    { key: { reporterUid: 1, createdAt: -1 } },
    { key: { targetType: 1, targetId: 1, status: 1 } },
    // 同一举报人对同一目标 24h 内只能报一次：靠唯一键而不是查询判断（并发下也成立）
    { key: { dedupeKey: 1 }, unique: true, sparse: true },
  ]);

  await database.collection('audit_logs').createIndexes([{ key: { createdAt: -1 } }]);
}
