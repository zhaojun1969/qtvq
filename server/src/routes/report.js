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

/** 生成 + 落库，供 /generate 与「接受邀请」共用，避免两条路径逻辑漂移 */
async function buildAndStoreReport(db, uid, targetUid, tier, question = '') {
  const { me, ta } = await loadUsers(db, uid, targetUid);
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
  return { reportId: insertedId, doc };
}

/** 统一的报告响应体 */
function reportResponse(reportId, doc, extra = {}) {
  return {
    reportId: String(reportId),
    tier: doc.tier,
    tierZh: doc.tierZh,
    price: doc.price,
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
    ...extra,
  };
}

function validateTier(tier, fallbackTier = 'deep') {
  const t = tier || fallbackTier;
  if (!isValidTier(t)) throw badRequest(`无效档位：${t}`, 'E_BAD_TIER');
  return t;
}

function validateQuestion(question) {
  if (!question) return '';
  const q = String(question);
  if (q.length > 500) throw badRequest('问题过长（≤500 字）', 'E_QUESTION_LONG');
  return q.slice(0, 500);
}

/** POST /v1/report/generate */
router.post(
  '/generate',
  requireAuth,
  wrap(async (req, res) => {
    const { targetUid, tier, question } = req.body || {};
    if (!targetUid) throw badRequest('缺少 targetUid', 'E_NO_TARGET');

    const db = getDB();
    const { reportId, doc } = await buildAndStoreReport(
      db,
      req.uid,
      String(targetUid),
      validateTier(tier),
      validateQuestion(question),
    );
    return ok(res, reportResponse(reportId, doc));
  }),
);

/**
 * GET /v1/report/invite/:token —— 公开：接受邀请前先看是谁邀请的
 * 只返回对方的公开资料，不泄漏联系方式
 */
router.get(
  '/invite/:token',
  wrap(async (req, res) => {
    const db = getDB();
    const invite = await db.collection('invites').findOne({ token: String(req.params.token) });
    if (!invite) throw notFound('邀请链接不存在或已失效');
    const expired = invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now();
    if (expired) throw badRequest('邀请链接已过期', 'E_INVITE_EXPIRED');

    const from = await db.collection('users').findOne({ _id: invite.fromUid });
    if (!from) throw notFound('邀请人不存在或已注销');

    return ok(res, {
      inviteToken: invite.token,
      from: publicProfile(from),
      note: invite.note || '',
      usedByUid: invite.usedByUid || null,
      expiresAt: invite.expiresAt || null,
    });
  }),
);

/**
 * POST /v1/report/invite/:token/accept —— 接受邀请并生成报告
 *
 * 归属约定：报告归**邀请人**所有（与 /generate 一致：uid=发起方，target=接受方），
 * 同时立刻签发 shareToken 返回给接受方，双方都能凭链接回看同一份报告。
 * 这样不需要新增一套「共同所有权」权限模型。
 */
router.post(
  '/invite/:token/accept',
  requireAuth,
  wrap(async (req, res) => {
    const db = getDB();
    const token = String(req.params.token);
    const invite = await db.collection('invites').findOne({ token });
    if (!invite) throw notFound('邀请链接不存在或已失效');
    if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) {
      throw badRequest('邀请链接已过期', 'E_INVITE_EXPIRED');
    }
    if (invite.fromUid === req.uid) throw badRequest('不能接受自己发出的邀请', 'E_INVITE_SELF');

    const tier = validateTier((req.body || {}).tier);
    const question = validateQuestion((req.body || {}).question);

    const { reportId, doc } = await buildAndStoreReport(db, invite.fromUid, req.uid, tier, question);

    const shareToken = newShareToken();
    const shareExpiresAt = new Date(Date.now() + SHARE_TTL_DAYS * 86400000);
    await db
      .collection('reports')
      .updateOne({ _id: reportId }, { $set: { shareToken, shareExpiresAt, updatedAt: new Date() } });
    await db
      .collection('invites')
      .updateOne({ token }, { $set: { usedByUid: req.uid, usedAt: new Date() } });

    return ok(
      res,
      reportResponse(reportId, doc, {
        shareToken,
        shareExpiresAt,
        path: `/report.html?id=${String(reportId)}&share=${shareToken}`,
      }),
    );
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
