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

  /*
   * 订单完整记录（含 PII）。
   *
   * 2026-10-26 · G1「数据境内化」：Cloudflare KV 只保留**剥离 PII 的投影**，
   * 完整订单（openid / trace.phone / trace.ip / trace.userAgent）落在本机 Mongo。
   * 见 docs/订单数据境内化双写方案.md。
   *
   * `orderId` 建唯一索引：Functions 侧的同步是「整单 upsert」，重复投递（回调重试、
   * 轮询自愈、迁移脚本重跑）必须收敛成一条 —— 否则运营台出现重复订单、对账直接错。
   */
  await database.collection('orders').createIndexes([
    { key: { orderId: 1 }, unique: true },
    { key: { clientId: 1, createdAt: -1 } },
    { key: { status: 1, createdAt: -1 } },
    { key: { uid: 1, createdAt: -1 } },
    { key: { createdAt: -1 } },
  ]);

  // 转盘记录：按用户倒序查「最近转到过谁」（去重），以及审计
  await database.collection('spin_logs').createIndexes([
    { key: { uid: 1, createdAt: -1 } },
    { key: { targetUid: 1, createdAt: -1 } },
  ]);

  /*
   * 客户端付款明细（2026-10-26 · G1 最后一块）。
   *
   * KV `client:<id>` 现在只留 `timestamps` + `subscription`（判额度用，无 PII）；
   * `paymentPending` / `topupPending` / `paymentHistory` 里的**真实姓名与手机号**放这里。
   *
   * 索引说明：`clientId` 唯一（一次 upsert 一条）；`paymentPending.status` 让运营台
   * 的「待核实汇款」列表变成一次带索引的查询 —— 改造前它要扫全部 `client:` 键。
   */
  try {
    await database.collection('client_billing').dropIndex('paymentPending.status_1');
  } catch {
    /* 不存在则忽略 */
  }
  await database.collection('client_billing').createIndexes([
    { key: { clientId: 1 }, unique: true },
    { key: { 'paymentPending.status': 1, 'paymentPending.submittedAt': -1 } },
    { key: { updatedAt: -1 } },
  ]);
  /*
   * 账号的**可识别字段**（2026-10-26 · G1）。
   *
   * 为什么要拆：`auth:user:` 的值里有 `phone` 与三个 openid/unionid，属于个人信息；
   * 但同一条记录里还有 `passwordHash`/`passwordSalt` 与 `clientId` —— 鉴权每次都要读它。
   * 整条搬到 Mongo 会让**每一次带登录态的请求**都多一次公网往返（P50 会从 2ms 掉到几十毫秒），
   * 拿热路径换合规不划算。
   *
   * 所以按"能否识别到人"拆开：
   *   · KV  保留 id/clientId/createdAt/passwordHash/passwordSalt（不可逆摘要，不构成识别）
   *   · Mongo 保留 phone / wechatOpenId / wechatWebOpenId / wechatMpOpenId / wechatUnionId
   * 需要"认人"的少数路径（/me、注销、微信登录、重置密码、收款通知）才去取 Mongo。
   */
  /*
   * `phone` 的唯一索引必须是**部分索引**（只索引字符串值）。
   *
   * 第一版写成 `{ unique: true, sparse: true }`，结果微信登录的账号（phone 为 null）
   * 全部互相撞键 → `POST /v1/admin/auth-users` 500（2026-10-26 迁移 8 个账号时实测 5 个失败）。
   * 原因：sparse 只跳过"字段不存在"，**显式 null 仍然会被索引**，而唯一索引下只能有一个 null。
   * 部分索引显式排除非字符串值，null 与缺失都不参与唯一性约束。
   *
   * 旧索引要先删掉，否则同名索引的旧规则会继续生效（这个集合是本次新建的，删除是安全的）。
   */
  try {
    await database.collection('auth_users').dropIndex('phone_1');
  } catch {
    /* 不存在则忽略 */
  }
  await database.collection('auth_users').createIndexes([
    { key: { userId: 1 }, unique: true },
    {
      key: { phone: 1 },
      unique: true,
      partialFilterExpression: { phone: { $type: 'string' } },
      name: 'phone_unique_string',
    },
    { key: { updatedAt: -1 } },
  ]);
}
