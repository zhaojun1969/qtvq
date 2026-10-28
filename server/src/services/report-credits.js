/**
 * 报告额度与首单价（2026-10-27 · 再改造实施书 D6 / P1-T1.2）
 *
 * ── 为什么是"惰性计算"而不是"发放" ────────────────────────────────────────
 * 会员额度可以写成"开通会员时 +1 份"（要跨系统写），也可以写成"查询时按会员状态算"。
 * 这里选**惰性计算**，理由有三：
 *   1. 存量会员不需要迁移脚本 —— 他们已经有 `activeUntil`，一查就有额度；
 *   2. 不会出现"会员到期了但额度还挂着"的脏状态 —— 到期自然归零；
 *   3. 少一次跨系统写，就少一处可能写失败的地方（写失败比算错更难补救）。
 *
 * ── 怎么算"这一期已用" ────────────────────────────────────────────────────
 * 以会员到期日往前推一个套餐周期，作为**当前这一期**的起点；
 * 统计该期内在 `reports` 里被标记 `creditApplied: true` 的份数。
 * 跨期后起点自动前移，上一期的消耗不再计入 —— 不需要定时清零任务。
 */

import { getDB } from '../config/db.js';
import { PLAN_DAYS, PLAN_REPORT_CREDITS, REPORT_SKUS } from '../constants.js';

/** 当前会员期的起点（毫秒）。无会员/无到期时间返回 null */
export function periodStart(membership) {
  if (!membership?.active || !membership?.activeUntil) return null;
  const days = PLAN_DAYS[membership.plan] || PLAN_DAYS.month;
  return Number(membership.activeUntil) - days * 24 * 3600 * 1000;
}

/** 该会员这一期应得的额度份数（不是会员则为 0） */
export function totalCredits(membership) {
  if (!membership?.active) return 0;
  return PLAN_REPORT_CREDITS[membership.plan] ?? PLAN_REPORT_CREDITS.month;
}

/** 这一期已用掉的份数 */
export async function usedCredits(uid, membership) {
  const start = periodStart(membership);
  if (!start) return 0;
  return getDB()
    .collection('reports')
    .countDocuments({ uid, creditApplied: true, createdAt: { $gte: new Date(start) } });
}

/** @returns {{total:number, used:number, remaining:number, plan:string|null, periodStart:number|null}} */
export async function creditStatus(uid, membership) {
  const total = totalCredits(membership);
  if (!total) {
    return { total: 0, used: 0, remaining: 0, plan: membership?.plan || null, periodStart: null };
  }
  const used = await usedCredits(uid, membership);
  return {
    total,
    used,
    remaining: Math.max(0, total - used),
    plan: membership.plan,
    periodStart: periodStart(membership),
  };
}

/**
 * 首单价是否可用（实施书 D5：diagnose 首份 ¥4.9，每账号限一次）。
 * 判定：该账号没有 diagnose 的已支付/已消费订单，也没有用过 credit 生成过 diagnose。
 */
export async function introAvailable(uid) {
  const db = getDB();
  const paid = await db
    .collection('orders')
    .countDocuments({ uid: String(uid), sku: 'diagnose', status: { $in: ['paid', 'consumed'] } });
  if (paid > 0) return false;
  const generated = await db.collection('reports').countDocuments({ uid, sku: 'diagnose' });
  return generated === 0;
}

/** 该用户实际应付（分）：首单价命中则用 introFen，否则用 priceFen */
export async function priceFenFor(uid, sku) {
  const item = REPORT_SKUS[sku];
  if (!item) return null;
  if (item.introFen && (await introAvailable(uid))) return item.introFen;
  return item.priceFen;
}

/** 把某份报告记为"用会员额度生成"（用于统计这一期已用） */
export async function markCreditApplied(reportId) {
  await getDB()
    .collection('reports')
    .updateOne({ _id: reportId }, { $set: { creditApplied: true, creditAppliedAt: new Date() } });
}
