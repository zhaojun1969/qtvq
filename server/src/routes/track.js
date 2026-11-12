/**
 * 埋点上报（2026-10-27 · 再改造实施书 P0-T0.3）
 *
 * `POST /v1/track` —— 批量 ≤ 20 条，`navigator.sendBeacon` 兼容（POST + JSON）。
 *
 * ── 三条设计约束（照书里 §7 的事件字典执行）────────────────────────────────
 * 1. **事件名必须来自白名单**。随手加事件会让三个月后的看板变成"什么都查不出来"，
 *    所以未知事件名直接丢弃（记一条 debug 日志），不入库。
 * 2. **每事件必须有 `eventId`**，唯一索引去重 —— beacon 在弱网下会重发。
 * 3. **缺渠道码归 `ch=direct`**：渠道归因是 P3/P4 的地基，宁可少归因也不要 null。
 *
 * ── 按月分表（`events_YYYYMM`）──────────────────────────────────────────────
 * 埋点是增长类数据，单月量级远大于业务表；按月滚动可以让"90 天观测"跑完后直接归档旧表，
 * 不必对一张大表做删除。查询侧（P4 聚合脚本）按月份枚举即可。
 *
 * ── 限频 ────────────────────────────────────────────────────────────────────
 * 每 uid 每分钟 ≤ 60 条、每 IP 每分钟 ≤ 120 条（书里 §8）。用进程内滑动窗口，
 * 单进程部署下足够；多实例时需换 Redis —— 已在注释里标注。
 */

import { Router } from 'express';
import { getDB } from '../config/db.js';
import { resolveIdentity } from '../middleware/auth.js';
import { ok, wrap } from '../lib/http.js';

const router = Router();

/** 事件字典（书里 §7 的最小集，禁止随意加） */
export const EVENT_WHITELIST = new Set([
  'register',
  'login',
  'profile_complete',
  'question_asked',
  'report_landing_view',
  'report_pay_intent',
  'report_paid',
  'report_generated',
  'share_card_save',
  'share_card_landing',
  // P3-T3.2：渠道落地页（内容矩阵每条内容的入口）与它的 CTA 点击。
  // 分开记是因为"看了"和"点了"是两种转化率，混成一个事件就再也分不开了。
  'landing_view',
  'landing_cta_click',
  'wheel_spin_free',
  'wheel_spin_paid',
  'membership_purchase',
]);

const MAX_BATCH = 20;
const MAX_PROPS_BYTES = 2048;
const UID_LIMIT_PER_MIN = 60;
const IP_LIMIT_PER_MIN = 120;

/** 进程内滑动窗口（多实例部署时需换共享存储） */
const buckets = new Map();
function rateOk(key, limit) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now - b.start > 60_000) {
    buckets.set(key, { start: now, count: 1 });
    return true;
  }
  if (b.count >= limit) return false;
  b.count += 1;
  return true;
}
// 防内存膨胀：每 5 分钟清一次过期桶
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now - v.start > 120_000) buckets.delete(k);
}, 5 * 60_000).unref?.();

/**
 * 事件分表的月份名。
 *
 * **必须用本地时区**（ECS = Asia/Shanghai），和 `services/metrics.js::monthColl` 一致。
 * 原来这里用 UTC：每月 1 号 00:00–08:00（本地）的事件会被写进**上个月**的集合，
 * 而聚合按本地月去取 → 每月前 8 小时的事件整段丢失，且没有任何报错。
 */
export function monthCollection(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `events_${y}${m}`;
}

function sanitizeEvent(raw, { uid, anonId, ch }) {
  const name = String(raw?.event || '').trim();
  if (!EVENT_WHITELIST.has(name)) return null;

  const eventId = String(raw?.eventId || '').trim().slice(0, 64);
  if (!eventId) return null;

  let props = raw?.props;
  if (props && typeof props === 'object') {
    const s = JSON.stringify(props);
    if (Buffer.byteLength(s, 'utf8') > MAX_PROPS_BYTES) props = { _dropped: 'props too large' };
    else props = JSON.parse(s);
  } else props = null;

  const ts = Number(raw?.ts) > 0 ? new Date(Number(raw.ts)) : new Date();
  return {
    eventId,
    event: name,
    uid: uid ? String(uid) : null,
    anonId: anonId ? String(anonId).slice(0, 64) : null,
    ch: String(ch || 'direct').slice(0, 32),
    props,
    ts,
    receivedAt: new Date(),
  };
}

router.post(
  '/',
  wrap(async (req, res) => {
    const body = req.body || {};
    const list = Array.isArray(body.events) ? body.events : [];
    if (!list.length) return ok(res, { accepted: 0 });
    if (list.length > MAX_BATCH) return ok(res, { accepted: 0, error: `单次最多 ${MAX_BATCH} 条` });

    // 身份：优先登录态；匿名用 anonId（前端 localStorage 生成）
    const identity = await resolveIdentity(req).catch(() => null);
    const uid = identity?.uid ? String(identity.uid) : null;
    const ip = req.headers['cf-connecting-ip'] || req.ip || 'unknown';

    if (!rateOk(`uid:${uid || 'anon'}`, UID_LIMIT_PER_MIN)) {
      return res.status(429).json({ code: 'E_TRACK_RATE', error: '上报过于频繁' });
    }
    if (!rateOk(`ip:${ip}`, IP_LIMIT_PER_MIN)) {
      return res.status(429).json({ code: 'E_TRACK_RATE', error: '上报过于频繁' });
    }

    const ch = String(body.ch || '').trim() || 'direct';
    const docs = [];
    for (const raw of list.slice(0, MAX_BATCH)) {
      const doc = sanitizeEvent(raw, { uid, anonId: body.anonId, ch });
      if (doc) docs.push(doc);
    }
    if (!docs.length) return ok(res, { accepted: 0, rejected: list.length });

    const col = getDB().collection(monthCollection());
    // 去重靠唯一索引（eventId），重复不报错、只统计
    let accepted = 0;
    try {
      await col.createIndex({ eventId: 1 }, { unique: true });
    } catch {
      /* 索引已存在 */
    }
    /* E.85：月度集合例行索引 + TTL（首次写入该月集合时建，createIndex 幂等）。
     * ts TTL 180 天：埋点原始数据的留存上限——聚合（metrics_daily）每日已汇总，
     * 90 天验收窗口也只用近 3 个月，180 天足够回溯且防无限增长。 */
    try {
      await col.createIndex({ ts: 1 }, { expireAfterSeconds: 180 * 86400, name: 'ts_ttl_180d' });
      await col.createIndex({ uid: 1, ts: 1 }, { name: 'uid_ts' });
    } catch {
      /* 月度集合例行索引已存在 */
    }
    try {
      const r = await col.insertMany(docs, { ordered: false });
      accepted = r.insertedCount;
    } catch (err) {
      // 部分重复时 insertMany 会抛，但已插入的仍写入
      accepted = err?.result?.insertedCount ?? err?.insertedCount ?? 0;
      if (err?.code !== 11000) console.error('[track] 写入异常：', err?.message || err);
    }

    return ok(res, { accepted, rejected: list.length - accepted });
  }),
);

/** 管理端：按天统计（P4 看板的最小可用版本，避免为了看数先写聚合任务） */
router.get(
  '/stats',
  wrap(async (req, res) => {
    const days = Math.min(Number(req.query.days) || 7, 90);
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const db = getDB();

    // 事件按月分表：days > 1 时窗口可能跨月，只查当月会把上个月整段算丢
    const months = new Set();
    for (let m = new Date(since.getFullYear(), since.getMonth(), 1); m <= new Date(); m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
      months.add(monthCollection(m));
    }

    const all = [];
    for (const name of months) {
      const exists = await db.listCollections({ name }, { nameOnly: true }).toArray();
      if (!exists.length) continue;
      const rows = await db
        .collection(name)
        .aggregate([
          { $match: { ts: { $gte: since } } },
          {
            $group: {
              _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$ts', timezone: 'Asia/Shanghai' } }, event: '$event' },
              count: { $sum: 1 },
            },
          },
        ])
        .toArray();
      all.push(...rows);
    }

    // 合并同一天同一事件（跨月边界同一天只会落在一个月集合里，合并是无害的兜底）
    const merged = new Map();
    for (const r of all) {
      const key = `${r._id.day}|${r._id.event}`;
      merged.set(key, (merged.get(key) || 0) + r.count);
    }
    const rows = [...merged.entries()]
      .map(([key, count]) => {
        const [day, event] = key.split('|');
        return { day, event, count };
      })
      .sort((a, b) => (a.day === b.day ? a.event.localeCompare(b.event) : a.day < b.day ? -1 : 1));

    return ok(res, { days, rows });
  }),
);

export default router;
