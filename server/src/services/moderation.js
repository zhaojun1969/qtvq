/**
 * 举报与内容治理
 *
 * 关键设计：
 * - **去重靠唯一索引**（`dedupeKey`），不是「先查再插」——并发下才真正成立。
 * - 同一用户被多个不同举报人举报达到阈值后**自动转 invisible**（不再出现在候选/报告里），
 *   但**不直接封禁**：封禁必须由运营确认，避免 5 个号就能踢掉任意用户。
 * - 所有处置动作写 `audit_logs`。
 */
import { getDB } from '../config/db.js';
import { env } from '../config/env.js';
import { USER_STATUS } from '../constants.js';
import { badRequest, notFound } from '../lib/http.js';
import { startOfDayCN } from './wallet.js';
import { logAudit } from './audit.js';

export const REPORT_REASONS = ['涉黄', '广告', '诈骗', '辱骂', '头像违规', '虚假资料', '其他'];
export const TARGET_TYPES = ['user', 'report'];

/** 自动隐藏阈值：不同举报人达到这个数量就把目标转为 invisible（等待人工确认） */
const AUTO_HIDE_THRESHOLD = env.moderationAutoHide;

function dayKey(d = new Date()) {
  // 用北京时间自然日做去重窗口；文档里写清是「自然日」而不是「滚动 24 小时」
  const cn = new Date(d.getTime() + 8 * 3600 * 1000);
  return cn.toISOString().slice(0, 10);
}

export async function createReport({ reporterUid, targetType, targetId, reason, detail = '', evidence = [] }) {
  if (!TARGET_TYPES.includes(targetType)) throw badRequest('无效的举报对象类型', 'E_BAD_TARGET_TYPE');
  if (!REPORT_REASONS.includes(reason)) throw badRequest('无效的举报原因', 'E_BAD_REASON');
  if (!targetId) throw badRequest('缺少举报对象', 'E_NO_TARGET');
  if (String(targetId) === String(reporterUid)) throw badRequest('不能举报自己', 'E_SELF_REPORT');
  if (String(detail).length > 500) throw badRequest('补充说明最长 500 字', 'E_DETAIL_LONG');

  const db = getDB();
  const now = new Date();
  const doc = {
    reporterUid,
    targetType,
    targetId: String(targetId),
    reason,
    detail: String(detail || '').slice(0, 500),
    evidence: Array.isArray(evidence) ? evidence.slice(0, 5) : [],
    status: 'pending',
    dedupeKey: `${reporterUid}:${targetType}:${targetId}:${dayKey(now)}`,
    autoHidden: false,
    handledBy: null,
    handledAt: null,
    handleNote: null,
    createdAt: now,
  };

  try {
    await db.collection('moderation').insertOne(doc);
  } catch (err) {
    if (err?.code === 11000) {
      // 自然日内重复举报同一目标：直接返回已有记录，不报错（用户视角是「已受理」）
      const existed = await db.collection('moderation').findOne({ dedupeKey: doc.dedupeKey });
      return { duplicate: true, id: existed ? String(existed._id) : null, status: existed?.status || 'pending' };
    }
    throw err;
  }

  // 自动隐藏：只统计**不同举报人**，同一人换天重复举报不叠加
  if (targetType === 'user') {
    const reporters = await db
      .collection('moderation')
      .distinct('reporterUid', { targetType: 'user', targetId: doc.targetId, status: 'pending' });
    if (reporters.length >= AUTO_HIDE_THRESHOLD) {
      await db
        .collection('users')
        .updateOne(
          { _id: doc.targetId, status: { $ne: USER_STATUS.BANNED } },
          { $set: { status: USER_STATUS.INVISIBLE, autoHiddenAt: new Date() } },
        );
      await db.collection('moderation').updateOne({ _id: doc._id }, { $set: { autoHidden: true } });
      await logAudit({
        admin: 'system',
        action: 'auto_hide_user',
        targetType: 'user',
        targetId: doc.targetId,
        reason: `pending 举报达 ${reporters.length} 人（阈值 ${AUTO_HIDE_THRESHOLD}）`,
      });
    }
  }

  return { duplicate: false, id: String(doc._id), status: 'pending' };
}

export async function listMyReports(reporterUid, limit = 20) {
  const items = await getDB()
    .collection('moderation')
    .find({ reporterUid })
    .sort({ createdAt: -1 })
    .limit(Math.min(50, Math.max(1, limit)))
    .toArray();
  return items.map(publicModeration);
}

export function publicModeration(x) {
  return {
    id: String(x._id),
    targetType: x.targetType,
    targetId: x.targetId,
    reason: x.reason,
    status: x.status,
    autoHidden: !!x.autoHidden,
    handleNote: x.handleNote || null,
    createdAt: x.createdAt,
    handledAt: x.handledAt || null,
  };
}

export async function listPending({ status = 'pending', limit = 50 } = {}) {
  const q = status === 'all' ? {} : { status };
  const items = await getDB()
    .collection('moderation')
    .find(q)
    .sort({ createdAt: -1 })
    .limit(Math.min(200, Math.max(1, limit)))
    .toArray();
  return items.map((x) => ({ ...publicModeration(x), reporterUid: x.reporterUid, detail: x.detail }));
}

/**
 * 处置举报
 * @param {'approve'|'reject'} action approve = 认定成立
 */
export async function handleReport({ id, action, note = '', admin = 'admin' }) {
  if (!['approve', 'reject'].includes(action)) throw badRequest('无效的处置动作', 'E_BAD_ACTION');

  const db = getDB();
  const { ObjectId } = await import('mongodb');
  if (!ObjectId.isValid(id)) throw notFound('举报不存在');
  const _id = new ObjectId(id);

  const item = await db.collection('moderation').findOne({ _id });
  if (!item) throw notFound('举报不存在');
  if (item.status !== 'pending') throw badRequest('该举报已处理过', 'E_ALREADY_HANDLED');

  const status = action === 'approve' ? 'approved' : 'rejected';
  await db.collection('moderation').updateOne(
    { _id },
    { $set: { status, handledBy: admin, handledAt: new Date(), handleNote: String(note || '').slice(0, 200) } },
  );

  let effect = null;
  if (action === 'approve') {
    if (item.targetType === 'user') {
      await db
        .collection('users')
        .updateOne({ _id: item.targetId }, { $set: { status: USER_STATUS.BANNED, bannedAt: new Date() } });
      effect = 'user_banned';
    } else if (item.targetType === 'report') {
      await db
        .collection('reports')
        .updateOne({ _id: item.targetId }, { $set: { hidden: true, hiddenAt: new Date() } })
        .catch(() => {});
      effect = 'report_hidden';
    }
  }

  await logAudit({
    admin,
    action: action === 'approve' ? 'approve_report' : 'reject_report',
    targetType: item.targetType,
    targetId: item.targetId,
    reason: item.reason,
    meta: { moderationId: String(_id), note: String(note || '').slice(0, 200), effect },
  });

  return { id: String(_id), status, effect };
}

export async function moderationStats() {
  const db = getDB();
  const [pending, approved, rejected, todayNew] = await Promise.all([
    db.collection('moderation').countDocuments({ status: 'pending' }),
    db.collection('moderation').countDocuments({ status: 'approved' }),
    db.collection('moderation').countDocuments({ status: 'rejected' }),
    db.collection('moderation').countDocuments({ createdAt: { $gte: startOfDayCN() } }),
  ]);
  return { pending, approved, rejected, todayNew, autoHideThreshold: AUTO_HIDE_THRESHOLD };
}
