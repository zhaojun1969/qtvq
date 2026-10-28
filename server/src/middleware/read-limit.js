/**
 * 读取频次上限 —— 水印的"另一半"。
 *
 * 分隔职责（很重要，别混）：
 *   · **水印**（`server/src/services/watermark.js`）是**事后取证** —— 已经泄漏了才能用；
 *   · **本中间件**是**事前阻断** —— 让"批量把别人的资料抓走"这件事根本跑不完。
 * 只有水印没有限流 = 只能事后追责；只有限流没有水印 = 抓到的少量数据仍无法定位来源。两者要一起上。
 *
 * ── 为什么只对"非本人"读取计数 ────────────────────────────────────────────
 * 看**自己的**报告是正常使用（刷新、来回翻看、分享给朋友都算），限它只会惹恼正常用户；
 * 看**别人的**才对应"批量抓资料"的攻击面。所以计数条件与攻击面严格对齐：
 *   本人读自己的 → 不计；凭 shareToken / 配对看到别人的 → 计。
 *
 * ── 为什么用 MongoDB 而不是内存 ──────────────────────────────────────────
 * 服务会重启（部署即重启），内存计数一重启就清零，攻击者只要卡在重启前后就能绕过。
 * 落在 Mongo 里并加 TTL 索引，重启不清零，过期自动清理，不需要额外的清理任务。
 */
import { getDB } from '../config/db.js';

/** 默认额度：按"天"计（北京时间自然日，与举报去重同一套口径） */
export const DEFAULT_DAILY = 200;

/** 北京时间的自然日键 */
export function dayKey(now = new Date()) {
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  return bj.toISOString().slice(0, 10);
}

/** 读取计数的身份：登录用户用 uid，匿名用 IP（降级但仍有限制） */
export function identityOf(req) {
  if (req.uid) return `uid:${req.uid}`;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
  return `ip:${ip}`;
}

let indexReady = null;
/** 建 TTL 索引（幂等；只建一次）。过期时间 = 2 天，足够跨日统计又不留垃圾。 */
async function ensureIndex(db) {
  if (indexReady) return indexReady;
  indexReady = db
    .collection('read_events')
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
    .catch((e) => {
      // 索引建不上不该让业务不可用，但必须留痕（否则"限流悄悄失效"没人知道）
      console.error('[read-limit] 建 TTL 索引失败：', e?.message);
      indexReady = null;
    });
  return indexReady;
}

/**
 * 记一次"读取他人数据"并判断是否超限。
 *
 * 单独导出（而不只是中间件）的原因：有些路由要先判断"这是不是本人的数据"才知道该不该计数
 * —— 例如 `GET /v1/report/:id` 里 `isOwner` 是算出来的，中间件阶段还不知道。
 * 所以提供这个可直接 `await` 的函数，让调用点自己掌握时机。
 * @returns {Promise<{count:number, limit:number}>}
 * @throws 超限时抛出 status=429 / code=E_READ_LIMIT 的错误
 */
export async function consumeRead(req, bucket, daily) {
  const limit = Number(daily) > 0 ? Number(daily) : Number(process.env.READ_DAILY_LIMIT) > 0
    ? Number(process.env.READ_DAILY_LIMIT)
    : DEFAULT_DAILY;
  const who = identityOf(req);
  const db = getDB();
  await ensureIndex(db);

  const r = await db.collection('read_events').findOneAndUpdate(
    { who, bucket, day: dayKey() },
    {
      $inc: { count: 1 },
      $set: { expiresAt: new Date(Date.now() + 2 * 24 * 3600 * 1000) },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true, returnDocument: 'after' },
  );
  const count = r?.value?.count ?? r?.count ?? 1;
  if (count > limit) {
    const e = new Error(`今日查看他人资料已达上限（${limit} 次/天），请明天再试`);
    e.status = 429;
    e.code = 'E_READ_LIMIT';
    e.expose = true; // 429 < 500 本就会显示 message，这里显式写清意图
    throw e;
  }
  return { count, limit };
}

/**
 * 生成一个读取限流中间件。
 * @param {object} opts
 * @param {string} opts.bucket 计数维度（如 'report'、'profile'），不同接口各自独立额度
 * @param {number} [opts.daily] 每日上限，默认 `READ_DAILY_LIMIT` 环境变量或 200
 */
export function readLimit({ bucket, daily } = {}) {
  if (!bucket) throw new Error('readLimit 需要 bucket');
  return async function readLimitMiddleware(req, res, next) {
    try {
      const { count, limit } = await consumeRead(req, bucket, daily);
      // 让调用方（前端/运维）能看到自己的余量，而不是撞上 429 才知道有这回事
      res.setHeader('X-Read-Limit', String(limit));
      res.setHeader('X-Read-Remaining', String(Math.max(0, limit - count)));
      next();
    } catch (e) {
      // 限流自身的故障（比如 Mongo 抖动）不该让业务整体不可用：
      // 放行但打日志 —— 与内容安全 "degraded 放行+标记" 同一套取舍。
      if (e?.code === 'E_READ_LIMIT') return next(e);
      console.error('[read-limit] 计数失败，本次放行：', e?.message);
      return next();
    }
  };
}

export default readLimit;
