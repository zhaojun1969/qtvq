/**
 * 配对报告接口（路线 B）
 *
 * 计费说明：本阶段**不扣费**。档位价格与权益已在 `constants.js` 统一定义，
 * 计费在阶段 4 接入钱包（D1）后由 `ENFORCE_REPORT_BILLING` 打开。
 * 这里显式返回 `billing: 'deferred'`，避免出现「看起来收费、实际免费」的静默缺口。
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { getDB } from '../config/db.js';
import { REPORT_STATUS, TIERS, USER_STATUS, isValidTier } from '../constants.js';
import { badRequest, notFound, ok, unauthorized, wrap } from '../lib/http.js';
import { requireAuth, resolveIdentity } from '../middleware/auth.js';
import { generateReport, publicProfile } from '../services/report.js';

const router = Router();

const SHARE_TTL_DAYS = 30;
const COMPLETENESS_MIN = 0.5; // 资料完整度低于此值不生成报告，先引导补资料

function newShareToken() {
  return crypto.randomBytes(16).toString('base64url');
}

function parseObjectId(id) {
  if (!ObjectId.isValid(id)) throw notFound('报告不存在');
  return new ObjectId(id);
}

async function loadUsers(db, uid, targetUid) {
  const [me, ta] = await Promise.all([
    db.collection('users').findOne({ _id: uid }),
    db.collection('users').findOne({ _id: targetUid }),
  ]);
  if (!me) throw badRequest('请先完善自己的资料', 'E_NEED_PROFILE');
  if (!ta) throw notFound('对方不存在');
  if (ta.status === USER_STATUS.BANNED) throw notFound('对方不存在');
  if (ta.status === USER_STATUS.INVISIBLE) throw notFound('对方暂不接受配对');
  if (uid === targetUid) throw badRequest('不能与自己配对', 'E_SELF');
  return { me, ta };
}

async function loadQa(db, uid) {
  return db
    .collection('qa_pairs')
    .find({ uid }, { projection: { question: 1, answer: 1, _id: 0 } })
    .sort({ createdAt: -1 })
    .limit(10)
    .toArray();
}

/** POST /v1/report/generate */
router.post(
  '/generate',
  requireAuth,
  wrap(async (req, res) => {
    const { targetUid, tier = 'deep', question = '' } = req.body || {};
    if (!targetUid) throw badRequest('缺少 targetUid', 'E_NO_TARGET');
    if (!isValidTier(tier)) throw badRequest(`无效档位：${tier}`, 'E_BAD_TIER');
    if (question && String(question).length > 500) throw badRequest('问题过长（≤500 字）', 'E_QUESTION_LONG');

    const db = getDB();
    const { me, ta } = await loadUsers(db, req.uid, String(targetUid));

    const [myQa, taQa] = await Promise.all([loadQa(db, me._id), loadQa(db, ta._id)]);

    const generated = await generateReport({
      me,
      ta,
      tier,
      question: question ? String(question).slice(0, 500) : '',
      myQa,
      taQa,
    });

    const doc = {
      uid: me._id,
      targetUid: ta._id,
      tier,
      tierZh: TIERS[tier].zh,
      price: TIERS[tier].price,
      status: generated.fallback && !generated.content ? REPORT_STATUS.FAILED : REPORT_STATUS.READY,
      overall: generated.overall,
      scores: generated.scores,
      labels: generated.labels,
      basis: generated.basis,
      content: generated.content,
      pitfalls: generated.pitfalls,
      retrieval: generated.retrieval,
      fallback: generated.fallback,
      model: generated.model,
      provider: generated.provider,
      llmError: generated.llmError || null,
      meSnapshot: publicProfile(me),
      targetSnapshot: publicProfile(ta),
      question: question ? String(question).slice(0, 500) : '',
      shareToken: null,
      createdAt: new Date(),
    };

    const { insertedId } = await db.collection('reports').insertOne(doc);

    return ok(res, {
      reportId: String(insertedId),
      tier,
      tierZh: TIERS[tier].zh,
      price: TIERS[tier].price,
      billing: 'deferred',
      overall: doc.overall,
      scores: doc.scores,
      labels: doc.labels,
      basis: doc.basis,
      content: doc.content,
      pitfalls: doc.pitfalls,
      retrieval: doc.retrieval,
      fallback: doc.fallback,
      model: doc.model,
      provider: doc.provider,
      // 走兜底时把上游真实错误一并返回，便于定位（模型未开通/免费额度用尽/超时）
      llmError: doc.fallback ? doc.llmError || null : null,
      me: doc.meSnapshot,
      target: doc.targetSnapshot,
      createdAt: doc.createdAt,
    });
  }),
);

/** GET /v1/report/mine */
router.get(
  '/mine',
  requireAuth,
  wrap(async (req, res) => {
    const db = getDB();
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const items = await db
      .collection('reports')
      .find(
        { uid: req.uid },
        {
          projection: {
            tier: 1, tierZh: 1, overall: 1, scores: 1, labels: 1,
            'targetSnapshot.uid': 1, 'targetSnapshot.nickname': 1, 'targetSnapshot.avatar': 1,
            shareToken: 1, createdAt: 1, fallback: 1,
          },
        },
      )
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return ok(res, { items: items.map((r) => ({ id: String(r._id), ...r, _id: undefined })) });
  }),
);

/** GET /v1/report/:id —— 本人可看；否则需 shareToken */
router.get(
  '/:id',
  wrap(async (req, res) => {
    const db = getDB();
    const _id = parseObjectId(req.params.id);
    const report = await db.collection('reports').findOne({ _id });
    if (!report) throw notFound('报告不存在');

    const identity = await resolveIdentity(req);
    // 必须是严格布尔：持分享链接匿名访问时 resolveIdentity 返回 null，
    // 直接返回 null 会让前端 `isOwner === false` 之类的判断失效
    const isOwner = Boolean(identity && identity.uid === report.uid);
    const token = typeof req.query.share === 'string' ? req.query.share : null;
    const tokenOk = token && report.shareToken && token === report.shareToken;
    if (!isOwner && !tokenOk) throw unauthorized('无权查看该报告');

    return ok(res, {
      id: String(report._id),
      isOwner,
      tier: report.tier,
      tierZh: report.tierZh,
      overall: report.overall,
      scores: report.scores,
      labels: report.labels,
      basis: report.basis,
      content: report.content,
      pitfalls: report.pitfalls,
      retrieval: report.retrieval,
      fallback: report.fallback,
      me: report.meSnapshot,
      target: report.targetSnapshot,
      createdAt: report.createdAt,
    });
  }),
);

/** POST /v1/report/:id/share —— 生成分享链接（二维码指向这里） */
router.post(
  '/:id/share',
  requireAuth,
  wrap(async (req, res) => {
    const db = getDB();
    const _id = parseObjectId(req.params.id);
    const report = await db.collection('reports').findOne({ _id });
    if (!report) throw notFound('报告不存在');
    if (report.uid !== req.uid) throw unauthorized('无权分享该报告');

    const token = report.shareToken || newShareToken();
    const expiresAt = new Date(Date.now() + SHARE_TTL_DAYS * 86400000);
    await db.collection('reports').updateOne(
      { _id },
      { $set: { shareToken: token, shareExpiresAt: expiresAt, updatedAt: new Date() } },
    );

    return ok(res, {
      shareToken: token,
      path: `/report.html?id=${String(_id)}&share=${token}`,
      // 分享页只展示脱敏快照，不暴露手机号、实名、支付信息
      expiresAt,
    });
  }),
);

/**
 * POST /v1/report/invite —— 对方还没注册时，先发邀请链接
 * 被邀请人打开后完成资料，即可生成对我方的配对报告。
 */
router.post(
  '/invite',
  requireAuth,
  wrap(async (req, res) => {
    const db = getDB();
    const token = crypto.randomBytes(8).toString('hex');
    await db.collection('invites').insertOne({
      token,
      fromUid: req.uid,
      note: String(req.body?.note || '').slice(0, 100),
      usedByUid: null,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + SHARE_TTL_DAYS * 86400000),
    });
    return ok(res, { inviteToken: token, path: `/report.html?invite=${token}` });
  }),
);

export default router;
