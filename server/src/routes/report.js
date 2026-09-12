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
import { ApiError, badRequest, notFound, ok, unauthorized, wrap } from '../lib/http.js';
import { requireAuth, resolveIdentity } from '../middleware/auth.js';
import { generateReport, publicProfile } from '../services/report.js';
import { assertSafe } from '../services/content-safety.js';
import { quote, refund, spend } from '../services/wallet.js';

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

/**
 * 带计费的生成：报价 → 幂等扣款 → 生成 → 失败退回。
 *
 * **付款人与报告归属人是两个概念**，必须分开传：
 *   - `/generate`：自己生成，两者都是本人；
 *   - 接受邀请：**接受方付款**（是他点的生成），但**报告归邀请人**（与 /generate 的语义一致：
 *     uid=发起方，target=接受方），随后签发 shareToken 让接受方也能看同一份。
 * 混为一谈会让「谁付钱」和「报告归谁」两个问题互相污染。
 *
 * 顺序也是刻意的：
 * 1. 先 `loadUsers` 校验目标存在 —— 不能扣了钱才发现对方不存在；
 * 2. `spend` 用唯一索引做幂等，重复请求不会二次扣款；
 * 3. 扣款成功后才生成；生成抛错则 `refund` 退给**付款人**并留痕，
 *    **不留「扣了钱没报告」的静默状态**。
 */
async function chargeAndGenerate({
  db,
  ownerUid,
  payerUid,
  targetUid,
  tier,
  question,
  membership,
  idempotencyKey,
}) {
  const { me, ta } = await loadUsers(db, ownerUid, targetUid);

  const bill = await quote({ uid: payerUid, tier, membership });
  const paid = await spend(payerUid, bill.amount, {
    reason: bill.reason,
    idempotencyKey,
    meta: { tier, targetUid: String(targetUid), ownerUid, payerUid, price: bill.price },
  });

  // 幂等重放：直接返回上一次的结果，而不是再生成一份（也更省钱）
  if (paid.replayed) {
    if (paid.failed) {
      throw new ApiError(
        402,
        `余额不足：本次需要 ¥${bill.price.toFixed(2)}，当前余额 ¥${Number(paid.balance || 0).toFixed(2)}`,
        'E_INSUFFICIENT_BALANCE',
      );
    }
    const previousId = paid.entry?.ref;
    if (previousId) {
      const doc = await loadReportDoc(db, previousId);
      if (doc) {
        return { reportId: doc._id, doc, bill, replayed: true, charged: 0, balance: paid.entry?.balanceAfter ?? null };
      }
    }
    throw new ApiError(409, '上一次同样的请求还在处理中，请稍后刷新', 'E_DUPLICATE_IN_FLIGHT');
  }

  try {
    const { reportId, doc } = await buildAndStoreReport(db, ownerUid, targetUid, tier, question);
    // 把报告 id 记到账本上，供重放时直接取回
    if (idempotencyKey) {
      await db.collection('wallet_ledger').updateOne({ idempotencyKey }, { $set: { ref: String(reportId) } });
    }
    return { reportId, doc, bill, replayed: false, charged: paid.charged, balance: paid.balance };
  } catch (err) {
    if (paid.charged > 0) {
      await refund(payerUid, paid.charged, {
        reason: 'refund',
        ref: idempotencyKey || `auto:${Date.now()}:${payerUid}`,
        meta: { tier, targetUid: String(targetUid), error: String(err?.message || err).slice(0, 200) },
      }).catch((e) => console.error('[billing] 退款失败，需人工介入：', payerUid, paid.charged, e.message));
    }
    throw err;
  }
}

async function loadReportDoc(db, reportId) {
  try {
    const { ObjectId } = await import('mongodb');
    if (!ObjectId.isValid(String(reportId))) return null;
    return await db.collection('reports').findOne({ _id: new ObjectId(String(reportId)) });
  } catch {
    return null;
  }
}

/** POST /v1/report/generate */
router.post(
  '/generate',
  requireAuth,
  wrap(async (req, res) => {
    const { targetUid, tier, question } = req.body || {};
    if (!targetUid) throw badRequest('缺少 targetUid', 'E_NO_TARGET');

    const t = validateTier(tier);
    const q = validateQuestion(question);
    if (q) await assertSafe(q, { field: 'question', label: '问题' });

    const idempotencyKey =
      String(req.body?.idempotencyKey || req.headers['x-idempotency-key'] || '').trim().slice(0, 80) || null;

    const db = getDB();
    const { reportId, doc, bill, replayed, charged, balance } = await chargeAndGenerate({
      db,
      ownerUid: req.uid,
      payerUid: req.uid,
      targetUid: String(targetUid),
      tier: t,
      question: q,
      membership: req.membership,
      idempotencyKey,
    });

    return ok(
      res,
      reportResponse(reportId, doc, {
        billing: {
          enforce: bill.enforce,
          reason: bill.reason,
          label: bill.label,
          price: bill.price,
          charged: replayed ? 0 : charged ?? bill.amount,
          balance: typeof balance === 'number' ? balance : null,
          replayed: !!replayed,
        },
      }),
    );
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
    if (question) await assertSafe(question, { field: 'question', label: '问题' });

    // 谁点「生成」谁付钱：接受邀请的一方触发本次生成，因此由接受方扣款。
    // 报告仍然归邀请人所有（下方逻辑不变），并立刻签发 shareToken 给接受方。
    const { reportId, doc, bill, charged, balance } = await chargeAndGenerate({
      db,
      ownerUid: invite.fromUid,
      payerUid: req.uid,
      targetUid: req.uid,
      tier,
      question,
      membership: req.membership,
      idempotencyKey: `invite:${token}`,
    });

    // 已有 shareToken 就复用：重复接受邀请时不能把上一次发出去的链接作废
    const shareToken = doc.shareToken || newShareToken();
    const shareExpiresAt = doc.shareExpiresAt || new Date(Date.now() + SHARE_TTL_DAYS * 86400000);
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
        billing: {
          enforce: bill.enforce,
          reason: bill.reason,
          label: bill.label,
          price: bill.price,
          charged: charged ?? bill.amount,
          balance: typeof balance === 'number' ? balance : null,
          payer: 'accepter',
        },
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
