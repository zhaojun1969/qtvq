/** 运营审计日志：所有管理动作必须留痕，否则出事无法回溯 */
import { getDB } from '../config/db.js';

export async function logAudit({ admin, action, targetType = null, targetId = null, reason = null, meta = null }) {
  try {
    await getDB().collection('audit_logs').insertOne({
      admin: admin || 'unknown',
      action,
      targetType,
      targetId: targetId == null ? null : String(targetId),
      reason,
      meta: meta || null,
      createdAt: new Date(),
    });
  } catch (err) {
    // 审计失败不能影响主流程，但必须吵醒人
    console.error('[audit] 写审计日志失败：', err.message);
  }
}

export async function listAudit(limit = 50) {
  return getDB()
    .collection('audit_logs')
    .find({})
    .sort({ createdAt: -1 })
    .limit(Math.min(200, Math.max(1, limit)))
    .toArray();
}
