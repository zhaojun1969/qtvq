/**
 * 最小运营台 API
 *
 * 挂在 `/v1/admin/*`，用 `X-Admin-Key` 鉴权。未配置 ADMIN_KEY 时整组 404（不暴露后台存在）。
 * 页面：`GET /v1/admin/console`（一个静态 HTML，口令在页面里输入，不走 URL 传参）。
 *
 * 刻意**不做**的事：不做角色/多管理员、不做批量操作、不做数据导出 —— 现阶段一个口令足够，
 * 权限模型等到真需要多人协作时再设计，避免现在拍脑袋定错。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { getDB } from '../config/db.js';
import { USER_STATUS } from '../constants.js';
import { badRequest, notFound, ok, wrap } from '../lib/http.js';
import { requireAdmin } from '../middleware/admin.js';
import { credit, getWallet, listLedger, startOfDayCN } from '../services/wallet.js';
import { handleReport, listPending, moderationStats, publicModeration } from '../services/moderation.js';
import { spinStats } from '../services/wheel.js';
import { listAudit, logAudit } from '../services/audit.js';
import { safetyStatus } from '../services/content-safety.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_FILE = path.resolve(HERE, '../../public/console.html');

const router = Router();

// 控制台页面放在鉴权之前：它只是个静态 HTML，口令由页面输入后放进请求头
router.get('/console', (req, res) => {
  res.sendFile(CONSOLE_FILE, (err) => {
    if (err) res.status(404).type('text/plain; charset=utf-8').send('运营台页面不存在');
  });
});

router.use(requireAdmin);

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------- 总览

router.get(
  '/overview',
  wrap(async (req, res) => {
    const db = getDB();
    const today = startOfDayCN();

    const [users, profilesReady, banned, invisible, totalReports, reportsToday, mod, revAll, revToday, bal] =
      await Promise.all([
        db.collection('users').estimatedDocumentCount(),
        db.collection('users').countDocuments({ profileVector: { $ne: null } }),
        db.collection('users').countDocuments({ status: USER_STATUS.BANNED }),
        db.collection('users').countDocuments({ status: USER_STATUS.INVISIBLE }),
        db.collection('reports').estimatedDocumentCount(),
        db.collection('reports').countDocuments({ createdAt: { $gte: today } }),
        moderationStats(),
        db
          .collection('wallet_ledger')
          .aggregate([
            { $match: { direction: 'out', status: 'done', reason: 'tier_price' } },
            { $group: { _id: null, sum: { $sum: '$amount' } } },
          ])
          .toArray(),
        db
          .collection('wallet_ledger')
          .aggregate([
            { $match: { direction: 'out', status: 'done', reason: 'tier_price', createdAt: { $gte: today } } },
            { $group: { _id: null, sum: { $sum: '$amount' } } },
          ])
          .toArray(),
        db
          .collection('wallet')
          .aggregate([{ $group: { _id: null, sum: { $sum: '$balance' }, n: { $sum: 1 } } }])
          .toArray(),
      ]);

    return ok(res, {
      users: { total: users, profilesReady, banned, invisible },
      reports: { total: totalReports, today: reportsToday },
      wheel: await spinStats(),
      moderation: mod,
      wallet: {
        accounts: bal[0]?.n || 0,
        totalBalance: Math.round((bal[0]?.sum || 0) * 100) / 100,
        revenueAll: Math.round((revAll[0]?.sum || 0) * 100) / 100,
        revenueToday: Math.round((revToday[0]?.sum || 0) * 100) / 100,
      },
      safety: safetyStatus(),
      time: new Date().toISOString(),
    });
  }),
);

// ---------------------------------------------------------------- 举报处置

router.get(
  '/moderation',
  wrap(async (req, res) => {
    const status = String(req.query.status || 'pending');
    const limit = Number(req.query.limit) || 50;
    return ok(res, { items: await listPending({ status, limit }), stats: await moderationStats() });
  }),
);

router.post(
  '/moderation/:id/handle',
  wrap(async (req, res) => {
    const { action, note = '' } = req.body || {};
    const result = await handleReport({ id: req.params.id, action, note, admin: req.admin || 'admin' });
    return ok(res, result);
  }),
);

// ---------------------------------------------------------------- 用户

router.get(
  '/users',
  wrap(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || '');
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));

    const filter = {};
    if (status) filter.status = status;
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.$or = [{ _id: rx }, { nickname: rx }, { city: rx }];
    }

    // 用聚合直接算出 hasVector：投影排除向量的话就没法判断它是否存在，
    // 而把 1024 维向量取回内存再判断又是纯浪费（30 个用户 ≈ 120KB）。
    const items = await getDB()
      .collection('users')
      .aggregate([
        { $match: filter },
        { $sort: { updatedAt: -1 } },
        { $limit: limit },
        {
          $project: {
            nickname: 1,
            gender: 1,
            age: 1,
            city: 1,
            tags: 1,
            status: 1,
            createdAt: 1,
            updatedAt: 1,
            hasVector: { $gt: [{ $size: { $ifNull: ['$profileVector', []] } }, 0] },
          },
        },
      ])
      .toArray();

    const uids = items.map((u) => u._id);
    const wallets = await getDB()
      .collection('wallet')
      .find({ _id: { $in: uids } })
      .toArray();
    const balMap = new Map(wallets.map((w) => [w._id, Math.round((w.balance || 0) * 100) / 100]));

    return ok(res, {
      items: items.map((u) => ({
        uid: u._id,
        nickname: u.nickname || null,
        gender: u.gender || null,
        age: u.age || null,
        city: u.city || null,
        tags: Array.isArray(u.tags) ? u.tags : [],
        status: u.status || USER_STATUS.ACTIVE,
        balance: balMap.get(u._id) ?? 0,
        hasVector: !!u.hasVector,
        createdAt: u.createdAt || null,
        updatedAt: u.updatedAt || null,
      })),
    });
  }),
);

router.get(
  '/users/:uid',
  wrap(async (req, res) => {
    const uid = String(req.params.uid);
    const u = await getDB().collection('users').findOne({ _id: uid }, { projection: { profileVector: null, introVector: null } });
    if (!u) throw notFound('用户不存在');
    const [wallet, ledger, mods] = await Promise.all([
      getWallet(uid),
      listLedger(uid, 20),
      getDB().collection('moderation').find({ targetType: 'user', targetId: uid }).sort({ createdAt: -1 }).limit(20).toArray(),
    ]);
    return ok(res, {
      user: { ...u, uid: u._id, _id: undefined },
      wallet,
      ledger,
      moderation: mods.map((m) => ({ ...publicModeration(m), reporterUid: m.reporterUid })),
    });
  }),
);

router.post(
  '/users/:uid/status',
  wrap(async (req, res) => {
    const uid = String(req.params.uid);
    const { status, reason = '' } = req.body || {};
    if (![USER_STATUS.ACTIVE, USER_STATUS.INVISIBLE, USER_STATUS.BANNED].includes(status)) {
      throw badRequest('无效的状态', 'E_BAD_STATUS');
    }
    const r = await getDB()
      .collection('users')
      .updateOne({ _id: uid }, { $set: { status, updatedAt: new Date() } });
    if (!r.matchedCount) throw notFound('用户不存在');

    await logAudit({
      admin: req.admin || 'admin',
      action: status === USER_STATUS.BANNED ? 'ban_user' : status === USER_STATUS.ACTIVE ? 'unban_user' : 'hide_user',
      targetType: 'user',
      targetId: uid,
      reason: String(reason || '').slice(0, 200),
      meta: { status },
    });
    return ok(res, { uid, status });
  }),
);

/** 人工充值：对公/静态码汇款核实通过后给用户加余额 */
router.post(
  '/users/:uid/credit',
  wrap(async (req, res) => {
    const uid = String(req.params.uid);
    const { amount, reason = '人工核实充值', ref = null } = req.body || {};
    const num = Number(amount);
    if (!Number.isFinite(num) || num <= 0 || num > 100000) throw badRequest('金额不合法（0–100000）', 'E_BAD_AMOUNT');

    const u = await getDB().collection('users').findOne({ _id: uid }, { projection: { _id: 1 } });
    if (!u) throw notFound('用户不存在');

    // ref 作为幂等键：同一个汇款单号重复提交只入账一次
    const idempotencyKey = ref ? `admin_credit:${ref}` : null;
    const result = await credit(uid, num, {
      reason: 'admin_credit',
      operator: req.admin || 'admin',
      ref,
      idempotencyKey,
      meta: { note: String(reason).slice(0, 200) },
    });

    await logAudit({
      admin: req.admin || 'admin',
      action: 'credit_user',
      targetType: 'user',
      targetId: uid,
      reason: String(reason).slice(0, 200),
      meta: { amount: num, ref, replayed: !!result.replayed, balance: result.balance },
    });

    return ok(res, {
      uid,
      credited: result.credited,
      balance: result.balance,
      replayed: !!result.replayed,
    });
  }),
);

router.get(
  '/users/:uid/ledger',
  wrap(async (req, res) => {
    const limit = Number(req.query.limit) || 50;
    return ok(res, { items: await listLedger(String(req.params.uid), limit) });
  }),
);

// ---------------------------------------------------------------- 流水与审计

router.get(
  '/ledger',
  wrap(async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const items = await getDB()
      .collection('wallet_ledger')
      .find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return ok(res, {
      items: items.map((x) => ({
        id: String(x._id),
        _id: undefined,
        uid: x.uid,
        direction: x.direction,
        amount: Math.round((x.amount || 0) * 100) / 100,
        reason: x.reason,
        ref: x.ref || null,
        operator: x.operator || null,
        status: x.status,
        balanceAfter: x.balanceAfter,
        createdAt: x.createdAt,
      })),
    });
  }),
);

router.get(
  '/audit',
  wrap(async (req, res) => {
    const limit = Number(req.query.limit) || 50;
    const items = await listAudit(limit);
    return ok(res, {
      items: items.map((x) => ({ id: String(x._id), _id: undefined, ...x })),
    });
  }),
);

export default router;
