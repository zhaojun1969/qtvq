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
import { requireAdult } from '../middleware/adult.js';
import { generateReport, publicProfile } from '../services/report.js';
import { generateDiagnose, normalizeScenes, DIAGNOSE_SCENES } from '../services/report-diagnose.js';
import { assessQuality } from '../services/report-quality.js';
import { generateRetro } from '../services/report-retro.js';
import { assertSafe } from '../services/content-safety.js';
import { markText } from '../services/watermark.js';
import { consumeRead, identityOf } from '../middleware/read-limit.js';
import { quote, refund, spend } from '../services/wallet.js';
import { creditStatus, priceFenFor, introAvailable, markCreditApplied } from '../services/report-credits.js';
import { listAvailableCoupons } from '../services/coupons.js';
import { REPORT_SKUS, isValidSku } from '../constants.js';
import { env } from '../config/env.js';
import { consumeOrder } from '../services/orders.js';

/** 每日可查看**他人**报告的次数（自己的不限）。可用 `READ_DAILY_REPORT` 覆盖。 */
const READ_DAILY_REPORT = Number(process.env.READ_DAILY_REPORT) > 0 ? Number(process.env.READ_DAILY_REPORT) : 60;

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

async function loadMe(db, uid) {
  const me = await db.collection('users').findOne({ _id: uid });
  if (!me) throw badRequest('请先完善自己的资料', 'E_NEED_PROFILE');
  return me;
}

/**
 * 三种报告商品（kind）的生成器分派 —— 2026-10-27 · 实施书 P2。
 *
 *   · `pair`    配对合盘：需要 targetUid，沿用 services/report.js 的打分逻辑；
 *   · `diagnose`避坑诊断：**不需要对方**，输入是一段处境描述；
 *   · `retro`   关系复盘：也不需要对方，输入是自己/对方两个视角 + 时间线。
 *
 * 三者共用同一个"落库字段形状"（status/content/sections/completeness/pitfalls/…），
 * 这样 /v1/report/:id、异步轮询、分享卡、退款逻辑都不用分支。
 */
async function generateForKind({ db, kind, me, ta, tier, question, payload }) {
  if (kind === 'diagnose') {
    const g = await generateDiagnose({
      description: payload?.description,
      scenes: payload?.scenes,
      question,
    });
    return {
      status: g.content ? REPORT_STATUS.READY : REPORT_STATUS.FAILED,
      overall: null,
      scores: null,
      labels: null,
      basis: null,
      content: g.content,
      sections: g.sections,
      completeness: g.completeness,
      quality: g.quality || null,
      pitfalls: g.pitfalls,
      retrieval: g.retrieval,
      scenes: g.scenes,
      fallback: g.fallback,
      model: g.model,
      provider: g.provider,
      llmError: g.llmError || null,
    };
  }

  if (kind === 'retro') {
    const g = await generateRetro({
      selfView: payload?.selfView,
      partnerView: payload?.partnerView,
      history: payload?.history,
      question,
    });
    return {
      status: g.content ? REPORT_STATUS.READY : REPORT_STATUS.FAILED,
      overall: null,
      scores: null,
      labels: null,
      basis: null,
      content: g.content,
      sections: g.sections,
      completeness: g.completeness,
      quality: g.quality || null,
      pitfalls: g.pitfalls,
      retrieval: g.retrieval,
      scenes: null,
      fallback: g.fallback,
      model: g.model,
      provider: g.provider,
      llmError: g.llmError || null,
    };
  }

  const [myQa, taQa] = await Promise.all([loadQa(db, me._id), loadQa(db, ta._id)]);
  const generated = await generateReport({
    me,
    ta,
    tier,
    question: question ? String(question).slice(0, 500) : '',
    myQa,
    taQa,
  });
  // 配对报告也纳入同一套质量度量（只记录、不重试：它的长度由档位 prompt 控制）
  // generateReport 内部已做长度守卫（可能重试一次），优先用它的结果；没有才本地补算
  const pairQuality = generated.quality || assessQuality({ sku: 'pair', content: generated.content, sections: generated.sections || {}, skipStructure: true });
  return {
    status: generated.fallback && !generated.content ? REPORT_STATUS.FAILED : REPORT_STATUS.READY,
    overall: generated.overall,
    scores: generated.scores,
    labels: generated.labels,
    basis: generated.basis,
    content: generated.content,
    sections: null,
    completeness: null,
    quality: pairQuality,
    pitfalls: generated.pitfalls,
    retrieval: generated.retrieval,
    scenes: null,
    fallback: generated.fallback,
    model: generated.model,
    provider: generated.provider,
    llmError: generated.llmError || null,
  };
}

/** 生成 + 落库（同步路径与「接受邀请」用），避免两条路径逻辑漂移 */
async function buildAndStoreReport(db, { kind = 'pair', ownerUid, targetUid = null, tier, question = '', payload = null }) {
  let me;
  let ta = null;
  if (targetUid) {
    ({ me, ta } = await loadUsers(db, ownerUid, targetUid));
  } else {
    me = await loadMe(db, ownerUid);
  }

  const generated = await generateForKind({ db, kind, me, ta, tier, question, payload });

  const doc = {
    uid: me._id,
    targetUid: ta ? ta._id : null,
    kind,
    tier,
    tierZh: TIERS[tier].zh,
    price: TIERS[tier].price,
    ...generated,
    meSnapshot: publicProfile(me),
    targetSnapshot: ta ? publicProfile(ta) : null,
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
    // kind/sku 决定前端渲染哪一套模板（配对合盘 / 避坑诊断 / 关系复盘）
    kind: doc.kind || 'pair',
    sku: doc.sku || null,
    tier: doc.tier,
    tierZh: doc.tierZh,
    price: doc.price,
    billing: 'deferred',
    // 异步生成的关键字段：pending 时前端应继续轮询，ready/failed 才渲染
    status: doc.status || 'ready',
    overall: doc.overall,
    scores: doc.scores,
    labels: doc.labels,
    basis: doc.basis,
    content: doc.content,
    // 结构化三段（diagnose/retro 有；pair 为 null）
    sections: doc.sections || null,
    completeness: typeof doc.completeness === 'number' ? doc.completeness : null,
    quality: doc.quality || null,
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
  targetUid = null,
  kind = 'pair',
  sku = null,
  tier,
  question,
  membership,
  idempotencyKey,
  payload = null,
  // 与 chargeAndCreatePending 保持一致：用微信订单/会员额度付过时不再扣钱包
  skipCharge = null,
}) {
  // 校验对象存在（扣钱之前），但不在这里生成：me/ta 由 buildAndStoreReport 再取一次
  if (targetUid) await loadUsers(db, ownerUid, targetUid);
  else await loadMe(db, ownerUid);

  /*
   * 两种付款方式在这里分叉（2026-10-27 · 实施书 P1-T1.1）：
   *   · `skipCharge` 为真：已经用**微信订单**或**会员额度**付过，钱包不再扣 ——
   *     只是把"这一单为什么免费"记进账单与报告，供对账与客服解释；
   *   · 否则沿用钱包扣费（原有行为，含幂等与失败退款）。
   */
  let bill;
  let paid;
  if (skipCharge) {
    bill = {
      enforce: true,
      reason: skipCharge.reason,
      label: skipCharge.label,
      price: Number(skipCharge.amountFen || 0) / 100,
      amount: 0,
      source: skipCharge.source,
      orderId: skipCharge.orderId || null,
    };
    paid = { charged: 0, balance: null, replayed: false };
  } else {
    bill = await quote({ uid: payerUid, tier, membership });
    paid = await spend(payerUid, bill.amount, {
      reason: bill.reason,
      idempotencyKey,
      meta: { tier, targetUid: targetUid ? String(targetUid) : null, ownerUid, payerUid, price: bill.price },
    });
  }

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
    const { reportId, doc } = await buildAndStoreReport(db, {
      kind,
      ownerUid,
      targetUid,
      tier,
      question,
      payload,
    });
    // 把报告 id 记到账本上，供重放时直接取回
    if (idempotencyKey) {
      await db.collection('wallet_ledger').updateOne({ idempotencyKey }, { $set: { ref: String(reportId) } });
    }
    const withSku = sku ? { ...doc, sku } : doc;
    if (sku) await db.collection('reports').updateOne({ _id: reportId }, { $set: { sku } });
    return { reportId, doc: withSku, bill, replayed: false, charged: paid.charged, balance: paid.balance };
  } catch (err) {
    if (paid.charged > 0) {
      await refund(payerUid, paid.charged, {
        reason: 'refund',
        ref: idempotencyKey || `auto:${Date.now()}:${payerUid}`,
        meta: { tier, targetUid: targetUid ? String(targetUid) : null, kind, error: String(err?.message || err).slice(0, 200) },
      }).catch((e) => console.error('[billing] 退款失败，需人工介入：', payerUid, paid.charged, e.message));
    }
    throw err;
  }
}

/* ---------------------------------------------------------------- 异步生成 */

/*
 * 为什么要异步（2026-10-26）：
 * `generateReport()` 内部要等大模型，`services/llm.js` 的超时是 **45 秒**。
 * 同步返回意味着用户点「生成」后最坏要盯着转圈 45 秒，而这期间什么反馈都没有。
 *
 * 改成：先扣费 + 落一条 `pending` 报告，**立刻返回 reportId**；
 * 生成在后台跑，完成后把文档更新为 `ready` / `failed`。前端轮询 `GET /v1/report/:id`。
 *
 * 钱的部分必须仍然安全：
 *   · 扣费在返回前完成（用户看到"已扣费"就是真的扣了）；
 *   · 生成失败 / 进程中途重启导致长期 pending → **退款**，并把 `refunded` 记在文档上，
 *     避免重复退款；
 *   · 幂等键仍然生效，重放直接拿到同一份报告（可能是 pending）。
 */
const ASYNC_MODE = () => String(process.env.REPORT_ASYNC || '1') !== '0';
/** pending 超过这个时长就认为生成已经死了（进程重启/机器重启），按失败处理并退款 */
const PENDING_TIMEOUT_MS = Number(process.env.REPORT_PENDING_TIMEOUT_MS) > 0
  ? Number(process.env.REPORT_PENDING_TIMEOUT_MS)
  : 5 * 60 * 1000;

/** 扣费 + 建 pending 文档（不生成） */
async function chargeAndCreatePending({
  db,
  ownerUid,
  payerUid,
  targetUid = null,
  kind = 'pair',
  sku = null,
  tier,
  question,
  membership,
  idempotencyKey,
  payload = null,
  skipCharge = null,
}) {
  let me;
  let ta = null;
  if (targetUid) {
    ({ me, ta } = await loadUsers(db, ownerUid, targetUid));
  } else {
    me = await loadMe(db, ownerUid);
  }

  /*
   * 两种付款方式在这里分叉（2026-10-27 · 实施书 P1-T1.1）：
   *   · `skipCharge` 为真：已经用**微信订单**或**会员额度**付过，钱包不再扣 ——
   *     只是把"这一单为什么免费"记进账单与报告，供对账与客服解释；
   *   · 否则沿用钱包扣费（原有行为，含幂等与失败退款）。
   */
  let bill;
  let paid;
  if (skipCharge) {
    bill = {
      enforce: true,
      reason: skipCharge.reason,
      label: skipCharge.label,
      price: Number(skipCharge.amountFen || 0) / 100,
      amount: 0,
      source: skipCharge.source,
      orderId: skipCharge.orderId || null,
    };
    paid = { charged: 0, balance: null, replayed: false };
  } else {
    bill = await quote({ uid: payerUid, tier, membership });
    paid = await spend(payerUid, bill.amount, {
      reason: bill.reason,
      idempotencyKey,
      meta: { tier, targetUid: targetUid ? String(targetUid) : null, ownerUid, payerUid, price: bill.price },
    });
  }

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
        // 上一次可能还在 pending：直接把那份还回去，让前端继续轮询同一份
        return { reportId: doc._id, doc, bill, replayed: true, charged: 0, balance: paid.entry?.balanceAfter ?? null };
      }
    }
    throw new ApiError(409, '上一次同样的请求还在处理中，请稍后刷新', 'E_DUPLICATE_IN_FLIGHT');
  }

  const doc = {
    uid: me._id,
    targetUid: ta ? ta._id : null,
    kind,
    sku: sku || null,
    tier,
    tierZh: TIERS[tier].zh,
    price: TIERS[tier].price,
    status: REPORT_STATUS.PENDING || 'pending',
    meSnapshot: publicProfile(me),
    targetSnapshot: ta ? publicProfile(ta) : null,
    question: question ? String(question).slice(0, 500) : '',
    shareToken: null,
    // 退款依据：谁付的、付了多少、退过没有。进程重启后仍能据此补救。
    billing: {
      payerUid,
      charged: paid.charged || 0,
      price: bill.price,
      reason: bill.reason,
      refunded: false,
    },
    createdAt: new Date(),
  };
  const { insertedId } = await db.collection('reports').insertOne(doc);

  /*
   * 用会员额度支付的，要在报告上打 `creditApplied` —— 额度是"惰性计算"的，
   * 靠这个标记统计"这一期已用几份"（见 services/report-credits.js）。
   * 打标失败不阻塞生成：大不了额度多算一份给用户，不会少算。
   */
  if (skipCharge?.source === 'credit') {
    await markCreditApplied(insertedId).catch((e) =>
      console.error('[report] 额度标记失败：', String(insertedId), e?.message || e),
    );
  }

  if (idempotencyKey) {
    await db.collection('wallet_ledger').updateOne({ idempotencyKey }, { $set: { ref: String(insertedId) } });
  }
  return {
    reportId: insertedId,
    doc: { ...doc, _id: insertedId },
    bill,
    replayed: false,
    charged: paid.charged,
    balance: paid.balance,
    pendingInput: { kind, sku, me, ta, ownerUid, targetUid, tier, question, payload, payerUid },
  };
}

/**
 * 后台生成：完成后更新**同一条** pending 文档；失败则标记失败并退款。
 *
 * 注意这里**不再 insert 新报告行**：旧实现调用 `buildAndStoreReport()`（内部 insertOne），
 * 于是每份异步报告在 `reports` 里会留下两条记录（一条 pending 被更新，一条孤儿 ready），
 * 对账时"报告数 ≠ 付费数"，也会污染 PII 审计。现在只做 update。
 */
async function runGeneration({ db, reportId, input }) {
  const { ownerUid, targetUid, tier, question, payerUid, kind = 'pair', payload = null } = input;
  try {
    let me;
    let ta = null;
    if (targetUid) {
      ({ me, ta } = await loadUsers(db, ownerUid, targetUid));
    } else {
      me = await loadMe(db, ownerUid);
    }
    const generated = await generateForKind({ db, kind, me, ta, tier, question, payload });
    await db.collection('reports').updateOne(
      { _id: reportId },
      {
        $set: {
          ...generated,
          generatedAt: new Date(),
        },
      },
    );
    return true;
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 300);
    console.error('[report] 后台生成失败：', String(reportId), msg);
    const current = await db.collection('reports').findOne({ _id: reportId });
    const charged = Number(current?.billing?.charged || 0);
    const shouldRefund = charged > 0 && !current?.billing?.refunded;
    if (shouldRefund) {
      await refund(payerUid, charged, {
        reason: 'refund',
        ref: `report-fail:${String(reportId)}`,
        meta: { tier, error: msg.slice(0, 200) },
      }).catch((e) => console.error('[billing] 退款失败，需人工介入：', payerUid, charged, e.message));
    }
    await db.collection('reports').updateOne(
      { _id: reportId },
      { $set: { status: REPORT_STATUS.FAILED || 'failed', llmError: msg, refunded: shouldRefund, billing: { ...(current?.billing || {}), refunded: shouldRefund } } },
    );
    return false;
  }
}

/** 读报告时兜底：pending 太久＝生成已死 → 标失败并退款（幂等，只退一次） */
async function sweepStalePending(db, doc) {
  if (!doc || (doc.status !== 'pending' && doc.status !== REPORT_STATUS.PENDING)) return doc;
  const age = Date.now() - new Date(doc.createdAt || 0).getTime();
  if (age < PENDING_TIMEOUT_MS) return doc;
  const charged = Number(doc?.billing?.charged || 0);
  let refunded = !!doc?.billing?.refunded;
  if (charged > 0 && !refunded) {
    try {
      await refund(doc.billing.payerUid, charged, {
        reason: 'refund',
        ref: `report-timeout:${String(doc._id)}`,
        meta: { reason: 'pending-timeout' },
      });
      refunded = true;
    } catch (e) {
      console.error('[billing] 超时退款失败，需人工介入：', doc.billing.payerUid, charged, e.message);
    }
  }
  await db.collection('reports').updateOne(
    { _id: doc._id },
    { $set: { status: 'failed', llmError: '生成超时（服务重启或上游无响应），已退款', billing: { ...(doc.billing || {}), refunded }, refunded } },
  );
  return { ...doc, status: 'failed', billing: { ...(doc.billing || {}), refunded }, refunded };
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
/**
 * 报告价目 + 我的额度/首单价（P1-T1.1）。前端进报告页先调这个渲染价格表。
 * 价格按"我到手多少"算：命中首单价就返回 introFen，否则 priceFen。
 */
router.get(
  '/skus',
  requireAuth,
  requireAdult,
  wrap(async (req, res) => {
    const coupons = await listAvailableCoupons(req.uid);
    const best = coupons[0] || null;
    const out = {};
    for (const [key, item] of Object.entries(REPORT_SKUS)) {
      const yourPriceFen = await priceFenFor(req.uid, key);
      // 券后价要跟支付侧算得一模一样，否则又会出现"显示 ¥5.0、实扣 ¥9.9"
      const discountFen = best ? Math.min(best.valueFen, yourPriceFen) : 0;
      out[key] = {
        key,
        zh: item.zh,
        desc: item.desc,
        priceFen: item.priceFen,
        introFen: item.introFen || null,
        yourPriceFen,
        couponDiscountFen: discountFen,
        payableFen: yourPriceFen - discountFen,
        tier: item.tier,
      };
    }
    return ok(res, {
      skus: out,
      // 场景标签由服务端下发：前端不要自己维护一份，否则两边一改就对不上
      scenes: DIAGNOSE_SCENES,
      credits: await creditStatus(req.uid, req.membership),
      introAvailable: await introAvailable(req.uid),
      // 券也只下发可用列表，不暴露他人/已用/已过期
      coupons,
      couponFen: best ? best.valueFen : 0,
      billingOn: env.enforceReportBilling,
    });
  }),
);

/**
 * 按商品种类从请求体里取"生成输入"。
 *
 * pair 用 targetUid 走原路径；diagnose/retro **不需要对方**，输入是用户自己写的文字，
 * 所以在这里做长度与白名单收敛（避免把超长文本原样塞进 prompt）。
 */
function reportPayload(kind, body = {}) {
  if (kind === 'diagnose') {
    const description = String(body.description || '').trim().slice(0, 1200);
    if (description.length < 10) throw badRequest('请先用几句话描述你现在的处境（至少 10 个字）', 'E_NEED_DESCRIPTION');
    return { description, scenes: normalizeScenes(body.scenes) };
  }
  if (kind === 'retro') {
    const selfView = String(body.selfView || body.description || '').trim().slice(0, 1200);
    if (selfView.length < 10) throw badRequest('请先写一下你自己的视角（至少 10 个字）', 'E_NEED_DESCRIPTION');
    return {
      selfView,
      partnerView: String(body.partnerView || '').trim().slice(0, 1200),
      history: String(body.history || '').trim().slice(0, 2000),
    };
  }
  return null;
}

router.post(
  '/generate',
  requireAuth,
  requireAdult,
  wrap(async (req, res) => {
    const { targetUid = null, tier, question } = req.body || {};

    /*
     * 报告商品与付款方式（2026-10-27 · 实施书 P1）。
     * `sku` 决定"卖什么、多少钱"；`tier` 决定"生成多深"。两者解耦：
     * 前端可以只传 sku，这里用 REPORT_SKUS[sku].tier 推出生成档位。
     */
    const sku = String(req.body?.sku || 'pair');
    if (!isValidSku(sku)) throw badRequest('未知的报告商品', 'E_BAD_SKU');
    // 商品 key 与生成器 kind 一一对应：pair / diagnose / retro
    const kind = sku;
    const skuTier = String(req.body?.tier || REPORT_SKUS[sku].tier);
    const t = validateTier(skuTier);

    // 只有配对合盘需要对方；diagnose/retro 是"只关于我自己"的报告
    if (kind === 'pair' && !targetUid) throw badRequest('缺少 targetUid', 'E_NO_TARGET');
    const payload = reportPayload(kind, req.body || {});

    /*
     * 计费决策：只有总开关打开（且命中灰度名单）才真的要求付款。
     * 付款优先级（实施书 D6/D8）：
     *   ① 已支付的微信订单（orderId 传进来，且未消费过）→ 消费它；
     *   ② 会员本期的报告额度（惰性计算）→ 用一份；
     *   ③ 都不是且计费开启 → 402 `E_NEED_PAY`，前端据此拉起支付。
     */
    let skipCharge = null;
    const graylist = env.reportBillingGrayUids || [];
    const billingOn = env.enforceReportBilling && (graylist.length === 0 || graylist.includes(String(req.uid)));
    if (billingOn) {
      const orderIdIn = String(req.body?.orderId || '').trim();
      if (orderIdIn) {
        const used = await consumeOrder(orderIdIn);
        if (!used.consumed) {
          // 订单不存在 / 未支付 / 已消费过：三种情况都要明确告诉调用方，别让他重试
          throw badRequest('订单不可用（未支付或已被使用）', 'E_ORDER_UNUSABLE');
        }
        if (String(used.order.uid) !== String(req.uid) || used.order.sku !== sku) {
          throw badRequest('订单与本次购买不匹配', 'E_ORDER_MISMATCH');
        }
        skipCharge = { reason: 'report_order', source: 'order', orderId: orderIdIn, amountFen: used.order.amountFen, label: '微信支付' };
      } else {
        const credits = await creditStatus(req.uid, req.membership);
        if (credits.remaining > 0) {
          skipCharge = { reason: 'report_credit', source: 'credit', amountFen: REPORT_SKUS[sku].priceFen, label: '会员额度（' + credits.plan + '，剩余 ' + credits.remaining + '）' };
        } else {
          const priceFen = await priceFenFor(req.uid, sku);
          // 券后价一并给出：否则前端只能显示原价，用户点开微信才发现便宜了（或反过来）
          const best = (await listAvailableCoupons(req.uid))[0] || null;
          const discountFen = best ? Math.min(best.valueFen, priceFen) : 0;
          return res.status(402).json({
            code: 'E_NEED_PAY',
            error: '本报告为付费商品，请先完成支付',
            sku,
            priceFen,
            price: Number(priceFen) / 100,
            couponFen: best ? best.valueFen : 0,
            couponId: best ? best.id : null,
            discountFen,
            payableFen: priceFen - discountFen,
            payable: Number(priceFen - discountFen) / 100,
            credits,
          });
        }
      }
    }
    const q = validateQuestion(question);
    if (q) await assertSafe(q, { field: 'question', label: '问题' });

    const idempotencyKey =
      String(req.body?.idempotencyKey || req.headers['x-idempotency-key'] || '').trim().slice(0, 80) || null;

    const db = getDB();

    /*
     * 异步模式（默认开）：扣费 + 落 pending，立刻返回；生成在后台跑。
     * 传 `async: false` 可强制走原来的同步路径（排障/兼容用）。
     */
    const wantAsync = ASYNC_MODE() && req.body?.async !== false;
    if (wantAsync) {
      const created = await chargeAndCreatePending({
        db,
        ownerUid: req.uid,
        payerUid: req.uid,
        targetUid: targetUid ? String(targetUid) : null,
        kind,
        sku,
        tier: t,
        question: q,
        payload,
        membership: req.membership,
        idempotencyKey,
        skipCharge,
      });

      // 重放：上一次可能已经 ready，直接原样返回；仍在 pending 就继续等
      if (!created.replayed && created.pendingInput) {
        const { pendingInput } = created;
        setImmediate(() => {
          runGeneration({ db, reportId: created.reportId, input: pendingInput }).catch((e) =>
            console.error('[report] 后台任务异常：', e?.message || e),
          );
        });
      }

      return ok(
        res,
        reportResponse(created.reportId, created.doc, {
          billing: {
            enforce: created.bill.enforce,
            reason: created.bill.reason,
            label: created.bill.label,
            price: created.bill.price,
            charged: created.replayed ? 0 : created.charged ?? created.bill.amount,
            balance: typeof created.balance === 'number' ? created.balance : null,
            replayed: !!created.replayed,
          },
        }),
      );
    }

    const { reportId, doc, bill, replayed, charged, balance } = await chargeAndGenerate({
      db,
      ownerUid: req.uid,
      payerUid: req.uid,
      targetUid: targetUid ? String(targetUid) : null,
      kind,
      sku,
      tier: t,
      question: q,
      payload,
      membership: req.membership,
      idempotencyKey,
      skipCharge,
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
            kind: 1, sku: 1, tier: 1, tierZh: 1, overall: 1, scores: 1, labels: 1,
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

/**
 * GET /v1/report/share/:token —— 分享落地页 `/r/:token` 的公开只读接口
 *
 * 为什么单开一条"只有 token"的路由：
 *   · 短链 `/r/<token>` 里没有 reportId（短链的目的就是短），落地页只有 token；
 *   · 该接口**不需要登录**（被分享的人往往还不是用户），所以要严格限制返回字段：
 *     只给卡片/落地页要展示的结论与三段前几条，**不给**
 *     `meSnapshot/targetSnapshot`（含城市、职业等可拼出身份的资料）与全文。
 *     全文仍然走 `GET /v1/report/:id?share=token`，那里有读配额 + 水印。
 *   · 归因需要分享者 uid，但只回 uid（`u_xxxxxxx` 本身就是半公开的账号 ID）
 *     与昵称，不回任何其他资料。
 */
router.get(
  '/share/:token',
  wrap(async (req, res) => {
    const token = String(req.params.token || '').trim();
    if (!/^[A-Za-z0-9_-]{12,64}$/.test(token)) throw badRequest('分享链接无效', 'E_BAD_SHARE_TOKEN');
    const db = getDB();
    const report = await db.collection('reports').findOne({ shareToken: token });
    if (!report) throw notFound('分享链接不存在或已失效');
    if (report.shareExpiresAt && new Date(report.shareExpiresAt).getTime() < Date.now()) {
      throw new ApiError(410, '分享链接已过期', 'E_SHARE_EXPIRED');
    }
    const sec = report.sections || {};
    const take = (arr, n) => (Array.isArray(arr) ? arr.slice(0, n) : []);
    return ok(res, {
      kind: report.kind || 'pair',
      sku: report.sku || null,
      tier: report.tier || null,
      tierZh: report.tierZh || null,
      status: report.status || 'ready',
      overall: typeof report.overall === 'number' ? report.overall : null,
      // 结论 + 三段各取前几条：与分享卡上展示的内容一致，不多给
      summary: sec.summary || String(report.content || '').split('\n')[0] || '',
      risks: take(sec.risks, 3),
      cases: take(sec.cases, 2),
      actions: take(sec.actions, 3),
      pitfalls: (report.pitfalls || []).slice(0, 3).map((p) => ({ title: p.title || '', category: p.category || '' })),
      completeness: typeof report.completeness === 'number' ? report.completeness : null,
      inviterUid: report.uid || null,
      inviterNickname: report.meSnapshot?.nickname || null,
      createdAt: report.createdAt || null,
      expiresAt: report.shareExpiresAt || null,
    });
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

    /*
     * 异步生成的兜底：`pending` 卡太久说明生成进程已经没了（重启/崩溃）。
     * 在这里顺手收敛成 `failed` 并退款，而不是让前端无限轮询。
     * 幂等：`billing.refunded` 保证只退一次。
     */
    const swept = await sweepStalePending(db, report);
    if (swept !== report) Object.assign(report, swept);

    /*
     * 看别人的报告 → 计数 + 打水印（业务方选定的 B 方案）。
     *
     * 为什么只管"非本人"：
     *   · 看**自己的**报告是正常使用（刷新、来回翻、分享给朋友），限它只会惹恼正常用户；
     *   · 看**别人的**才是"批量把资料抓走"的攻击面 —— 计数与打标严格对齐这个攻击面。
     * 为什么要水印 + 限流一起上：限流是事前阻断（让批量抓取跑不完），
     * 水印是事后取证（万一还是流出去了，能定位到是哪个账号读的）。缺一不可。
     */
    let content = report.content;
    if (!isOwner) {
      const { count, limit } = await consumeRead(req, 'report', READ_DAILY_REPORT);
      res.setHeader('X-Read-Limit', String(limit));
      res.setHeader('X-Read-Remaining', String(Math.max(0, limit - count)));
      content = markText(content, identityOf(req));
    }

    return ok(res, {
      id: String(report._id),
      // 异步生成：pending 时前端继续轮询，ready/failed 才渲染
      status: report.status || 'ready',
      isOwner,
      kind: report.kind || 'pair',
      sku: report.sku || null,
      tier: report.tier,
      tierZh: report.tierZh,
      overall: report.overall,
      scores: report.scores,
      labels: report.labels,
      basis: report.basis,
      content,
      sections: report.sections || null,
      completeness: typeof report.completeness === 'number' ? report.completeness : null,
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
      // 短链：分享卡二维码指向它，落地页用 token 拉公开摘要（GET /v1/report/share/:token）
      shortPath: `/r/${token}`,
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
