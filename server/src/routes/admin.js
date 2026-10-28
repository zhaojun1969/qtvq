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
import {
  GATE,
  acceptanceGate,
  aggregateRange,
  channelBreakdown,
  listChannelCosts,
  listDaily,
  recordChannelCost,
  summarize,
} from '../services/metrics.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_FILE = path.resolve(HERE, '../../public/console.html');

const router = Router();

// 控制台页面放在鉴权之前：它只是个静态 HTML，口令由页面输入后放进请求头
router.get('/console', (req, res) => {
  res.sendFile(CONSOLE_FILE, (err) => {
    if (err) res.status(404).type('text/plain; charset=utf-8').send('运营台页面不存在');
  });
});

// 实施书 T4.1 写的是「新建 server/public/metrics.html 单页看板」。
// 实际不另建一份：看板已经是 console.html 的「指标看板」tab，两份页面必然口径分叉。
// 这里只给实施书要求的地址留一个跳转，落地到同一份看板（页面自己解析 #metrics）。
router.get('/metrics.html', (req, res) => res.redirect(302, '/v1/admin/console#metrics'));

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
    /*
     * ledgerReason：写进**流水**的机器可读原因码，只允许白名单里的值。
     *
     * 起因（2026-09-18 复验）：这里原来把流水 reason 写死成 'admin_credit'，
     * 于是"微信在线充值自动到账"在用户的缘值明细里显示成「人工入账」——
     * 用户看到"我明明在线付的，怎么是人工入账"，运营对账时也分不清自动与人工。
     * 现在允许支付系统传 'topup'；默认仍是 'admin_credit'（人工入账），
     * 未知值一律回落成默认，避免任何调用方往流水里塞自定义字符串。
     */
    const {
      amount,
      reason = '人工核实充值',
      ref = null,
      createIfMissing = false,
      ledgerReason = 'admin_credit',
    } = req.body || {};
    const LEDGER_REASONS = ['admin_credit', 'topup'];
    const ledgerCode = LEDGER_REASONS.includes(String(ledgerReason)) ? String(ledgerReason) : 'admin_credit';
    const num = Number(amount);
    if (!Number.isFinite(num) || num <= 0 || num > 100000) throw badRequest('金额不合法（0–100000）', 'E_BAD_AMOUNT');

    const u = await getDB().collection('users').findOne({ _id: uid }, { projection: { _id: 1 } });
    if (!u) {
      // createIfMissing 只给**支付系统自动入账**用：它的 uid 来自已支付的充值订单，是可信来源；
      // 而用户在 Pages 侧注册，Node 侧可能还没有资料文档（本项目 wallet.accounts=1 而 users.total=0）。
      // 手工入账（运营台输入 uid）不传这个标志，仍然要求用户必须已存在 —— 防止金额充到错的人身上。
      if (createIfMissing === true) {
        await getDB()
          .collection('users')
          .updateOne(
            { _id: uid },
            { $setOnInsert: { _id: uid, createdAt: new Date(), status: USER_STATUS.ACTIVE, source: 'payment_topup' } },
            { upsert: true },
          );
      } else {
        throw notFound('用户不存在');
      }
    }

    // ref 作为幂等键：同一个汇款单号重复提交只入账一次
    const idempotencyKey = ref ? `admin_credit:${ref}` : null;
    const result = await credit(uid, num, {
      reason: ledgerCode,
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
      meta: { amount: num, ref, replayed: !!result.replayed, balance: result.balance, ledgerReason: ledgerCode },
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

// ---------------------------------------------------------------- 留言（境内落地）
/*
 * 2026-10-16 · P0-1「数据境内化」的落地端点。
 *
 * 背景：留言记录此前写在 Cloudflare KV（`contact:<id>`）。KV 由 Cloudflare **全球网络**承载，
 * 而留言里的 `replyEmail` 与自由文本 `message` 属于《个人信息保护法》定义的个人信息，
 * 存于境外节点即构成数据出境。现改为落在境内 MongoDB（本机河源 ECS）。
 *
 * 约定：
 *   · 集合 `contact_messages`，`id` 唯一（幂等 upsert，迁移脚本可安全重跑）；
 *   · 保留 90 天，用 `expiresAt` 上的 TTL 索引由 MongoDB 自动清理，与旧 KV TTL 对齐；
 *   · `functions/api/contact.js` 侧**不再写 KV**；写入失败降级为「仅 OSS 备份 + 邮件」，
 *     保证 KV 永远不承载 PII。
 */
const CONTACT_RETENTION_DAYS = 90;

let contactIndexReady = null;
async function ensureContactIndex(db) {
  if (!contactIndexReady) {
    contactIndexReady = (async () => {
      const col = db.collection('contact_messages');
      await col.createIndex({ id: 1 }, { unique: true });
      await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      await col.createIndex({ createdAt: -1 });
    })().catch((err) => {
      contactIndexReady = null; // 失败不缓存，下次重试
      throw err;
    });
  }
  return contactIndexReady;
}

function normalizeContactRecord(raw) {
  const id = String(raw?.id || '').trim().slice(0, 80);
  if (!id) return null;
  const message = String(raw?.message || '').trim();
  if (!message) return null;
  return {
    id,
    to: String(raw?.to || 'qtvq@qtvq.cn').slice(0, 120),
    message: message.slice(0, 5000),
    replyEmail: raw?.replyEmail ? String(raw.replyEmail).trim().slice(0, 120) : null,
    clientId: String(raw?.clientId || 'anonymous').slice(0, 64),
    // 只保留图片元数据：base64 正文已存境内 OSS，放进 Mongo 既撑大文档，
    // 也会让 Functions 侧的请求体撞上这里 express.json 的 1mb 上限（413）
    images: Array.isArray(raw?.images)
      ? raw.images.slice(0, 4).map((i) => ({
          name: String(i?.name || '').slice(0, 80),
          type: String(i?.type || '').slice(0, 40),
          bytes: Number(i?.bytes) || null,
        }))
      : [],
    emailSent: !!raw?.emailSent,
    emailProvider: raw?.emailProvider ? String(raw.emailProvider).slice(0, 40) : null,
    createdAt: raw?.createdAt ? new Date(raw.createdAt) : new Date(),
    source: raw?.source ? String(raw.source).slice(0, 40) : 'cloudflare-function',
  };
}

router.post(
  '/contact',
  wrap(async (req, res) => {
    const record = normalizeContactRecord(req.body);
    if (!record) throw badRequest('留言记录无效（至少需要 id 与 message）', 'E_CONTACT_INVALID');
    const db = getDB();
    await ensureContactIndex(db);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CONTACT_RETENTION_DAYS * 24 * 3600 * 1000);
    // 幂等：同一 id 重复投递只保留一份，迁移脚本重跑不会产生重复数据
    await db
      .collection('contact_messages')
      .updateOne(
        { id: record.id },
        { $set: { ...record, expiresAt }, $setOnInsert: { receivedAt: now } },
        { upsert: true },
      );
    return ok(res, { id: record.id, stored: true, expiresAt: expiresAt.toISOString() });
  }),
);

router.get(
  '/contact',
  wrap(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const db = getDB();
    const items = await db
      .collection('contact_messages')
      // 图片是 base64 大字段，列表不返回，避免把响应撑大
      .find({}, { projection: { images: 0 } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return ok(res, { items: items.map((x) => ({ ...x, _id: String(x._id) })) });
  }),
);

router.delete(
  '/contact/:id',
  wrap(async (req, res) => {
    const db = getDB();
    const r = await db.collection('contact_messages').deleteOne({ id: String(req.params.id) });
    if (!r.deletedCount) throw notFound('留言不存在');
    return ok(res, { id: req.params.id, deleted: true });
  }),
);

// ---------------------------------------------------------------- 订单（境内完整记录 · G1）
/*
 * 2026-10-26 · 订单数据境内化的**落地点**（方案见 docs/订单数据境内化双写方案.md）。
 *
 * 分工：Cloudflare KV 只保留**剥离 PII 的投影**（orderId/clientId/plan/amount/status/…），
 * 完整记录（openid、trace.phone/ip/userAgent）只存这里。
 *
 * 三个端点都是「整单 upsert」语义，不发明状态机接口：
 *   · Functions 侧的写入本来就是 `put(整单 JSON)`，读改写也发生在同一份对象上；
 *   · 若在这里定义 `/paid`、`/failed` 之类的状态迁移接口，Orders 侧与 KV 侧就会各自
 *     维护一套状态机，两边一旦不同步就是**对账错误**——比多送几个字段危险得多。
 */
const ORDER_TEXT_MAX = 200;

function normalizeOrderRecord(raw) {
  const orderId = String(raw?.orderId || '').trim().slice(0, 80);
  if (!orderId) return null;
  const amountFen = Number(raw?.amountFen);
  const trace = raw?.trace && typeof raw.trace === 'object' ? raw.trace : null;
  const str = (v, n = ORDER_TEXT_MAX) => (v == null ? null : String(v).slice(0, n));
  return {
    orderId,
    clientId: str(raw?.clientId, 64) || 'unknown',
    uid: raw?.uid ? String(raw.uid).slice(0, 80) : null,
    plan: str(raw?.plan, 40),
    planLabel: str(raw?.planLabel, 80),
    amount: Number.isFinite(Number(raw?.amount)) ? Number(raw.amount) : null,
    amountFen: Number.isFinite(amountFen) ? amountFen : null,
    channel: str(raw?.channel, 40),
    status: str(raw?.status, 20) || 'pending',
    // —— 以下是只在境内保留的 PII ——
    openid: raw?.openid ? String(raw.openid).slice(0, 128) : null,
    trace: trace
      ? {
          ip: str(trace.ip, 64),
          userAgent: str(trace.userAgent, 200),
          phone: str(trace.phone, 40),
          uid: trace.uid ? String(trace.uid).slice(0, 80) : null,
        }
      : null,
    // —— 对账/排障字段 ——
    platformTradeNo: str(raw?.platformTradeNo, 80),
    prepayId: str(raw?.prepayId, 120),
    codeUrl: raw?.codeUrl ? String(raw.codeUrl).slice(0, 512) : null,
    failureReason: str(raw?.failureReason, 300),
    createdAt: Number(raw?.createdAt) || Date.now(),
    paidAt: Number(raw?.paidAt) || null,
    failedAt: Number(raw?.failedAt) || null,
  };
}

router.post(
  '/orders',
  wrap(async (req, res) => {
    const record = normalizeOrderRecord(req.body);
    if (!record) throw badRequest('订单记录无效（至少需要 orderId）', 'E_ORDER_INVALID');
    const db = getDB();
    const now = new Date();

    /*
     * ⚠️ PII 字段**只允许被"有值"的写入覆盖**，绝不能因为收到一份没有 PII 的订单就被抹掉。
     *
     * 为什么：Functions 侧的 `saveOrder`/`updateOrder` 是「先读 KV、改字段、再整单同步」，
     * 而 KV 里那份是**剥离了 PII 的投影**。早期版本直接 `$set: {...record}`，
     * 于是「下单时同步了完整 trace」→「支付成功后 updateOrder 再同步一次投影」
     * → Mongo 里的 trace 被**覆盖成 null**。实测（2026-10-26 单号 ord_mvp9xvqo_y0hkdld6）
     * 正是如此：PII 已经搬到境内，却在第二次同步时被自己的投影冲掉。
     *
     * 修法：把 PII 字段拆到 $setOnInsert（首次插入才写）与条件 $set（有值才更新）里，
     * 同一次 update 中一个字段只能出现在其中一处，Mongo 不允许重复。
     */
    const { openid, trace, ...nonPii } = record;
    const hasPiiTrace = Boolean(trace && (trace.ip || trace.phone || trace.userAgent));
    const set = { ...nonPii, syncedAt: now };
    const setOnInsert = { receivedAt: now };
    if (openid) set.openid = openid;
    else setOnInsert.openid = null;
    if (hasPiiTrace) set.trace = trace;
    else setOnInsert.trace = trace || null;

    await db
      .collection('orders')
      .updateOne({ orderId: record.orderId }, { $set: set, $setOnInsert: setOnInsert }, { upsert: true });
    return ok(res, { orderId: record.orderId, stored: true, syncedAt: now.toISOString() });
  }),
);

router.get(
  '/orders',
  wrap(async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const filter = {};
    if (req.query.clientId) filter.clientId = String(req.query.clientId).slice(0, 64);
    if (req.query.status) filter.status = String(req.query.status).slice(0, 20);
    if (req.query.uid) filter.uid = String(req.query.uid).slice(0, 80);
    const items = await getDB()
      .collection('orders')
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return ok(res, {
      total: await getDB().collection('orders').countDocuments(filter),
      items: items.map((x) => ({ ...x, _id: String(x._id) })),
    });
  }),
);

router.get(
  '/orders/:orderId',
  wrap(async (req, res) => {
    const item = await getDB().collection('orders').findOne({ orderId: String(req.params.orderId) });
    if (!item) throw notFound('订单不存在');
    return ok(res, { ...item, _id: String(item._id) });
  }),
);

/*
 * 账号注销时的订单脱敏（《个人信息保护法》"删除权"的实际落点）。
 *
 * 为什么必须有这个端点：订单的 PII 现在只在境内 Mongo，而注销流程
 * （`functions/api/auth/delete.js`）此前只改 KV —— KV 那份已经不含 PII，
 * 真正需要抹掉的恰恰在 Mongo 里。不补这一步，"注销即删"就是句空话。
 *
 * 语义：保留订单财务骨架（金额/时间/套餐/状态），把 clientId 换成不可逆短哈希、
 * 清空 openid 与 trace —— 与 KV 侧的既有策略完全一致，只是作用在完整记录上。
 */
router.post(
  '/orders/redact',
  wrap(async (req, res) => {
    const clientId = String(req.body?.clientId || '').trim().slice(0, 64);
    const tag = String(req.body?.tag || '').trim().slice(0, 80);
    if (!clientId) throw badRequest('缺少 clientId', 'E_NO_CLIENT_ID');
    if (!tag) throw badRequest('缺少脱敏标记 tag', 'E_NO_TAG');
    const col = getDB().collection('orders');
    /*
     * 先取 orderId 列表再改：调用方要用它去**精确**改 KV 里对应的那几个键，
     * 而不是把整个 `order:` 前缀扫一遍。KV 没有二级索引，全量扫描在 124 单时
     * 就已经让 `/api/auth/delete` 超时 504（2026-10-26 实测）—— 删除权不能挂在
     * 一个"订单越多越慢"的实现上。
     */
    const targets = await col
      .find({ clientId }, { projection: { orderId: 1 } })
      .limit(500)
      .toArray();
    const r = await col.updateMany(
      { clientId },
      { $set: { clientId: tag, openid: null, trace: null, redactedAt: new Date() } },
    );
    return ok(res, {
      clientId,
      tag,
      redacted: r.modifiedCount,
      orderIds: targets.map((t) => t.orderId),
    });
  }),
);

// ---------------------------------------------------------------- 账号可识别字段（境内 · G1）
/*
 * 2026-10-26 · `auth:user:` 的**值**里含 phone 与 openid，属个人信息；但同一条记录还带着
 * `passwordHash`/`passwordSalt`，而它每次带登录态的请求都要读（`resolveSession`）。
 * 整条搬 Mongo 会让热路径多一次公网往返，所以按"能否识别到人"拆开，见 db.js 的注释。
 *
 * 这里的 upsert 有一个刻意的不对称：**可识别字段只被"有值"的写入覆盖**。
 * 因为 Functions 侧的 `saveUser` 可能带着一份已脱敏的记录来（例如刚注销或只是改密码），
 * 若无脑 `$set`，Mongo 里刚存下的 phone/openid 会被空值冲掉 —— 订单那批已经踩过这个坑
 * （见 `/orders` 的注释与 docs/订单数据境内化双写方案.md）。
 */
const IDENTITY_FIELDS = ['phone', 'wechatOpenId', 'wechatWebOpenId', 'wechatMpOpenId', 'wechatUnionId'];

function normalizeIdentity(raw) {
  const userId = String(raw?.userId || '').trim().slice(0, 80);
  if (!userId) return null;
  const str = (v, n = 120) => (v == null ? null : String(v).slice(0, n));
  return {
    userId,
    clientId: str(raw?.clientId, 64),
    createdAt: Number(raw?.createdAt) || Date.now(),
    ...Object.fromEntries(IDENTITY_FIELDS.map((f) => [f, str(raw?.[f])])),
  };
}

router.post(
  '/auth-users',
  wrap(async (req, res) => {
    const rec = normalizeIdentity(req.body);
    if (!rec) throw badRequest('缺少 userId', 'E_NO_USER_ID');
    const db = getDB();
    const now = new Date();
    const set = { userId: rec.userId, clientId: rec.clientId, createdAt: rec.createdAt, updatedAt: now };
    for (const f of IDENTITY_FIELDS) {
      /*
       * 只写**有值**的字段：既不写 null，也不在插入时预置 null。
       *
       * 两个后果都要避免：
       *   · 写 null 会让 `phone` 的唯一部分索引把多个"无手机号"账号判成重复（曾导致 500）；
       *   · 用 `$unset` 表达"没有值"更危险 —— 调用方可能只是带着脱敏记录来（改密码、
       *     注销流程），那样会把境内刚存下的手机号删掉。所以"没有值"就**什么都不做**，
       *     让已有值保持不变。
       */
      if (rec[f]) set[f] = rec[f];
    }
    /*
     * 密码哈希：2026-10-26 账号迁到境内时新增。
     * 只接受"有值"的写入，理由同上（注销流程会带着脱敏记录来，不能把已有哈希冲掉）。
     * 这两个字段**不会**出现在 GET 响应里，除非显式 `?secrets=1`（迁移校验用）。
     */
    const hash = String(req.body?.passwordHash || '');
    const salt = String(req.body?.passwordSalt || '');
    if (hash && salt) {
      set.passwordHash = hash;
      set.passwordSalt = salt;
    }
    /*
     * 不再使用 `$setOnInsert`：它曾经用来"插入时预置 null"，现在已经没有要预置的东西，
     * 而 MongoDB **不接受空的更新操作符**（`$setOnInsert: {}` 直接报
     * "'$setOnInsert' is empty" → 500）。这个坑在拆分改造的 E2E 里表现为
     * `/api/auth/me` 的 phone 恒为 null：所有 identity 同步都 500 了。
     */
    await db.collection('auth_users').updateOne({ userId: rec.userId }, { $set: set }, { upsert: true });
    return ok(res, { userId: rec.userId, stored: true });
  }),
);

router.get(
  '/auth-users/:userId',
  wrap(async (req, res) => {
    const item = await getDB().collection('auth_users').findOne({ userId: String(req.params.userId) });
    if (!item) throw notFound('账号信息不存在');
    const out = { ...item, _id: String(item._id) };
    /*
     * 密码哈希默认**不返回**：它是可直接用于离线爆破的材料，不该因为"查账号"而外泄。
     * 只有显式 `?secrets=1` 才带上（迁移脚本回读校验用），且仍要求 X-Admin-Key。
     */
    if (String(req.query.secrets) !== '1') {
      delete out.passwordHash;
      delete out.passwordSalt;
    }
    return ok(res, out);
  }),
);

/** 注销时调用：把可识别字段整条删掉（不做脱敏保留 —— 订单才是需要保留的财务依据） */
router.delete(
  '/auth-users/:userId',
  wrap(async (req, res) => {
    const r = await getDB().collection('auth_users').deleteOne({ userId: String(req.params.userId) });
    return ok(res, { userId: req.params.userId, deleted: r.deletedCount });
  }),
);

// ---------------------------------------------------------------- 客户端付款明细（境内 · G1）
/*
 * 2026-10-26 · `client:<id>` 的值里 `paymentPending` / `topupPending` / `paymentHistory`
 * 含**付款人真实姓名与手机号**。这些是个人信息，但同一条记录也承载着判额度用的
 * `timestamps`（每次提问都要读）。所以：KV 只留判额度必需的两项，明细放这里。
 *
 * 写入遵循同一条铁律：**只写有值的字段**。调用方常常只改其中一项（例如充值登记不碰
 * `paymentHistory`），无条件覆盖会把另外两项抹掉。
 */
const BILLING_KEYS = ['paymentPending', 'topupPending', 'paymentHistory'];

function normalizeBillingField(field, value) {
  if (field === 'paymentHistory') {
    return Array.isArray(value) ? value.slice(0, 20).map((x) => (x && typeof x === 'object' ? x : null)).filter(Boolean) : [];
  }
  if (!value || typeof value !== 'object') return null;
  const s = (v, n) => (v == null ? null : String(v).slice(0, n));
  const out = {
    status: s(value.status, 20) || 'pending',
    submittedAt: Number(value.submittedAt) || Date.now(),
    clientId: s(value.clientId, 64),
    payerName: s(value.payerName, 40),
    phone: s(value.phone, 40),
    paidAt: s(value.paidAt, 40),
    remark: s(value.remark, 80),
  };
  // 会员登记与充值登记的字段不同，按存在的补齐
  if (value.plan !== undefined) out.plan = s(value.plan, 20);
  if (value.planLabel !== undefined) out.planLabel = s(value.planLabel, 40);
  if (value.amount !== undefined) out.amount = Number(value.amount) || 0;
  if (value.activatedAt !== undefined) out.activatedAt = Number(value.activatedAt) || null;
  return out;
}

router.post(
  '/client-billing',
  wrap(async (req, res) => {
    const clientId = String(req.body?.clientId || '').trim().slice(0, 64);
    if (!clientId) throw badRequest('缺少 clientId', 'E_NO_CLIENT_ID');
    const set = { clientId, updatedAt: new Date() };
    let touched = 0;
    for (const k of BILLING_KEYS) {
      if (req.body?.[k] === undefined) continue;
      set[k] = normalizeBillingField(k, req.body[k]);
      touched += 1;
    }
    if (!touched) throw badRequest('没有要更新的明细字段', 'E_NO_BILLING_FIELD');
    await getDB()
      .collection('client_billing')
      .updateOne({ clientId }, { $set: set }, { upsert: true });
    return ok(res, { clientId, stored: true, fields: touched });
  }),
);

router.get(
  '/client-billing/:clientId',
  wrap(async (req, res) => {
    const item = await getDB()
      .collection('client_billing')
      .findOne({ clientId: String(req.params.clientId) });
    if (!item) throw notFound('无该设备的付款明细');
    return ok(res, { ...item, _id: String(item._id) });
  }),
);

/*
 * 待核实列表。`pending=payment` 取会员汇款、`pending=topup` 取缘值充值。
 * 改造前运营台要扫全部 `client:` 键再逐条取值（KV 没有二级索引），
 * 现在是一次带索引的查询。
 */
router.get(
  '/client-billing',
  wrap(async (req, res) => {
    const kind = String(req.query.pending || '');
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    const filter =
      kind === 'topup'
        ? { 'topupPending.status': 'pending' }
        : kind === 'payment'
          ? { 'paymentPending.status': 'pending' }
          : {};
    const items = await getDB()
      .collection('client_billing')
      .find(filter)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray();
    return ok(res, {
      total: await getDB().collection('client_billing').countDocuments(filter),
      items: items.map((x) => ({ ...x, _id: String(x._id) })),
    });
  }),
);

router.delete(
  '/client-billing/:clientId',
  wrap(async (req, res) => {
    const r = await getDB()
      .collection('client_billing')
      .deleteOne({ clientId: String(req.params.clientId) });
    return ok(res, { clientId: req.params.clientId, deleted: r.deletedCount });
  }),
);

// ------------------------------------------------------- 客户端额度（境内 Mongo）
/*
 * 2026-10-26：额度与订阅从 Cloudflare KV（`client:<id>`）搬到境内 Mongo。
 *
 * 为什么必须暴露这些 admin 接口：**付款开通在 Pages 侧**。
 * `functions/lib/quota-store.js` 的 `activatePayment()` 原来写 KV；
 * 额度已经搬到 Mongo 后，它必须改成调这里，否则"付了钱但没解锁"。
 *
 * 语义与原 KV 版一致：`{ timestamps, subscription }`，其余(BPM 明细)在 client_billing。
 */
router.get(
  '/client-quota/:clientId',
  wrap(async (req, res) => {
    const { loadRecord } = await import('../services/quota-store.js');
    const rec = await loadRecord(String(req.params.clientId));
    return ok(res, rec || { timestamps: [], subscription: null });
  }),
);

router.post(
  '/client-quota/:clientId',
  wrap(async (req, res) => {
    const { saveRecord } = await import('../services/quota-store.js');
    const body = req.body || {};
    const saved = await saveRecord(String(req.params.clientId), {
      timestamps: body.timestamps,
      subscription: body.subscription,
    });
    return ok(res, { clientId: req.params.clientId, saved });
  }),
);

router.post(
  '/client-quota/:clientId/activate',
  wrap(async (req, res) => {
    const { activatePayment } = await import('../services/quota-store.js');
    const plan = String((req.body || {}).plan || '');
    const okActivated = await activatePayment(String(req.params.clientId), plan);
    if (!okActivated) throw badRequest('开通失败（套餐无效或明细未同步）', 'E_BAD_PLAN');
    return ok(res, { clientId: req.params.clientId, plan, activated: true });
  }),
);

router.delete(
  '/client-quota/:clientId',
  wrap(async (req, res) => {
    const { clearClientRecord } = await import('../services/quota-store.js');
    const cleared = await clearClientRecord(String(req.params.clientId));
    return ok(res, { clientId: req.params.clientId, cleared });
  }),
);
/*
 * 回答三个此前无法回答的问题：这条内容当时判了哪档、由哪层判的、申诉时凭什么复议。
 * 台账由 `content-safety.js` 的 `checkText` 旁路写入，保留 180 天（《网络安全法》第 21 条）。
 */
router.get(
  '/moderation-ledger/stats',
  wrap(async (req, res) => {
    const { ledgerStats } = await import('../services/moderation-ledger.js');
    return ok(res, await ledgerStats());
  }),
);

router.get(
  '/moderation-ledger',
  wrap(async (req, res) => {
    const { listLedger } = await import('../services/moderation-ledger.js');
    const action = req.query.action ? String(req.query.action) : null;
    const items = await listLedger({ limit: Number(req.query.limit) || 50, action });
    return ok(res, {
      items: items.map((x) => ({ ...x, _id: String(x._id) })),
    });
  }),
);

router.get(
  '/moderation-ledger/by-hash/:hash',
  wrap(async (req, res) => {
    const { ledgerByHash } = await import('../services/moderation-ledger.js');
    const items = await ledgerByHash(req.params.hash);
    return ok(res, { items: items.map((x) => ({ ...x, _id: String(x._id) })) });
  }),
);


// ------------------------------------------------ 账号会话（供 Pages 侧共享）
/*
 * 微信登录 / 短信重置 / 注销仍在 Pages 上，但它们要签发与校验会话。
 * 会话主键统一为 `hashKey('session:'+token)`（与 KV 版同算法：sha256 前 32 hex 字符），
 * 两侧算出同一个键即可共享 —— 不会出现"微信登录后网页端显示未登录"。
 */
router.post(
  '/auth-sessions',
  wrap(async (req, res) => {
    const { adminSaveSession } = await import('../services/auth-store.js');
    const { hashId, userId, clientId, expiresAt } = req.body || {};
    const saved = await adminSaveSession({ hashId, userId, clientId, expiresAt });
    return ok(res, { hashId, saved });
  }),
);

router.get(
  '/auth-sessions/:hashId',
  wrap(async (req, res) => {
    const { adminLoadSession } = await import('../services/auth-store.js');
    return ok(res, (await adminLoadSession(req.params.hashId)) || null);
  }),
);

router.delete(
  '/auth-sessions/:hashId',
  wrap(async (req, res) => {
    const { adminDeleteSession } = await import('../services/auth-store.js');
    return ok(res, { deleted: await adminDeleteSession(req.params.hashId) });
  }),
);
// ---------------------------------------------------------------- 指标看板（P4）
/*
 * 聚合结果在 `metrics_daily`（按天 upsert，由 scripts/aggregate-metrics.mjs 每日重算）。
 * 这里只读 + 提供"补算"和"录成本"两个写入口 —— 指标数字本身不允许后台手改。
 */
router.get(
  '/metrics',
  wrap(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const [rows, gate, costs] = await Promise.all([listDaily({ days }), acceptanceGate({ days: GATE.windowDays }), listChannelCosts({ days })]);
    return ok(res, {
      days,
      rows,
      summary: summarize(rows),
      gate,
      costs,
      gateConfig: GATE,
    });
  }),
);

router.get(
  '/metrics/channels',
  wrap(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || GATE.windowDays, 1), 365);
    return ok(res, { days, channels: await channelBreakdown({ days }) });
  }),
);

// 补算：埋点晚到、或者改了聚合口径之后，从这里重跑历史
router.post(
  '/metrics/rebuild',
  wrap(async (req, res) => {
    const day = req.body?.day ? String(req.body.day) : null;
    if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw badRequest('日期格式应为 YYYY-MM-DD', 'E_BAD_DATE');
    const days = Math.min(Math.max(Number(req.body?.days) || 7, 1), 365);
    const rows = day ? await aggregateRange({ from: day, to: day }) : await aggregateRange({ days });
    await logAudit(req, 'metrics.rebuild', { day, days, rows: rows.length });
    return ok(res, { rebuilt: rows.length, first: rows[0]?.date, last: rows[rows.length - 1]?.date });
  }),
);

// 渠道成本是 CAC 的唯一分子来源，只能人工录入（投放账单、邀请券成本）
router.post(
  '/metrics/cost',
  wrap(async (req, res) => {
    const { date, channel, amountFen, note } = req.body || {};
    let saved;
    try {
      saved = await recordChannelCost({ date, channel, amountFen, note });
    } catch (err) {
      throw badRequest(err.message, err.code || 'E_BAD_COST');
    }
    await logAudit(req, 'metrics.cost', saved);
    return ok(res, saved);
  }),
);

router.get(
  '/metrics/costs',
  wrap(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 365);
    return ok(res, { days, costs: await listChannelCosts({ days }) });
  }),
);

export default router;
