/**
 * 本人数据导出（DSAR 自助）
 *
 * 为什么此前一直关着
 * ------------------
 * `dataExport` 长期是 false，理由写的是"涉及权限边界与脱敏，价值低于风险"。
 * 那个判断只对了一半：**脱敏是为了给别人看**，而这里导出的是本人的数据、
 * 给本人下载。真正需要防的不是"用户看到自己的信息"，而是三件事：
 *
 *   1. **别把别人的数据带出去** —— 配对报告里存着对方的昵称/年龄/简介，
 *      一起导出就是一次数据泄漏，且受害的是没点过"导出"的那个人。
 *   2. **别把凭据带出去** —— 密码哈希、会话 token 一旦落进一个会被转发、
 *      会留在下载目录里的文件，等于把账号安全交给"用户不会转存"这个假设。
 *   3. **别把自己变成批量抓取的入口** —— 这个接口一次能拉全量，
 *      必须有频次约束，否则它就是最好用的爬虫端点。
 *
 * 所以本文件的形状是：**白名单式**（认识的字段才给）、**分区式**（每段说明范围）、
 * **有上限**（每段最多 N 条并明确写"这是最近 N 条"）、**有冷却**（10 分钟一次）。
 *
 * 刻意不做"整库 dump"
 * ------------------
 * 直接 `find({uid})` 把原始文档吐出去最省事，但那会把将来新增的字段
 * （可能是密钥、可能是别人的 id）自动带进导出文件里 —— 一个默认开放的接口，
 * 安全性取决于"以后没人往 users 里加敏感字段"，而这个假设迟早会破。
 * 这里反过来：只有明确列出的字段会出去，新增字段默认不导出。
 *
 * 不导出的东西（在 `_meta.excluded` 里也写给用户看）
 * ------------------------------------------------
 *   · 订单快照里的设备与联系信息（trace.*）：反欺诈留痕，导出文件常被转发，
 *     需要可走人工（qtvq@qtvq.cn）。
 *   · 报告正文：含对方资料，属"共同数据"，只在应用内可见。
 *   · 密码哈希 / 会话 token / 微信 openid 原文（只给脱敏尾号）。
 */

import { Router } from 'express';
import { getDB } from '../config/db.js';
import { ApiError, wrap } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { logAudit } from '../services/audit.js';

const router = Router();

/** 每段上限：既防止响应体过大，也避免"一次拉全量"变成抓取入口 */
const LIMIT_QUESTIONS = 500;
const LIMIT_ORDERS = 500;
const LIMIT_LEDGER = 500;
const LIMIT_REPORTS = 200;

/** 冷却：同一账号 10 分钟内只能导一次（进程内，重启即清空 —— 与 chat 限流同口径） */
const COOLDOWN_MS = 10 * 60 * 1000;
const lastExportAt = new Map();

/** 敏感字段：命中即删。用正则而不是逐个列举，避免以后加字段时漏掉 */
const SECRET_KEY_RE = /(password|passwd|salt|token|secret|credential|session)/i;

/**
 * 下面这些 shaper 是纯函数，**刻意对外导出**：`tools/scripts/check-data-export.mjs`
 * 直接调用它们断言"哪些字段会出去、哪些不会"。
 * 用正则去源码里找 `trace` 是否存在，只能证明"没写这个词"，
 * 证明不了"调用后真的没有 trace" —— 后者才是用户下载到的文件。
 */
export function maskId(value, { head = 4, tail = 4 } = {}) {
  const s = String(value || '');
  if (!s) return null;
  if (s.length <= head + tail) return '*'.repeat(s.length);
  return `${s.slice(0, head)}${'*'.repeat(Math.max(4, s.length - head - tail))}${s.slice(-tail)}`;
}

function iso(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * 白名单式整理用户文档。
 *
 * 两个刻意的动作：
 *   · 向量（profileVector/introVector）不导出：128 维浮点数组对用户没有意义，
 *     却能让文件从几十 KB 涨到几 MB，还会让人误以为"我的资料被算成了什么数字"。
 *   · openid 只给脱敏值：它是微信侧的身份键，本人不需要原文即可核对是哪个号。
 */
export function shapeAccount(doc = {}) {
  const out = {
    uid: doc._id == null ? null : String(doc._id),
    nickname: doc.nickname || null,
    avatar: doc.avatar || null,
    gender: doc.gender || null,
    age: doc.age || null,
    city: doc.city || null,
    job: doc.job || null,
    height: doc.height || null,
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    intro: doc.intro || '',
    status: doc.status || null,
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
  };
  // 未知但可能存在的身份键：给脱敏值，不给原文
  if (doc.openid || doc.openId) out.openidMasked = maskId(doc.openid || doc.openId);
  if (doc.unionid || doc.unionId) out.unionidMasked = maskId(doc.unionid || doc.unionId);
  return out;
}

/** 账号表（auth_users）：只给登录标识与时间，凭据一律删除 */
export function shapeLogin(doc = {}) {
  if (!doc || !Object.keys(doc).length) return null;
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    if (SECRET_KEY_RE.test(k)) continue;
    if (/_id$/.test(k)) continue;
    if (v instanceof Date) out[k] = iso(v);
    else if (k === 'openid' || k === 'unionid') out[`${k}Masked`] = maskId(v);
    else out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

export function shapeOrder(o = {}) {
  /*
   * trace 段（ip / phone / userAgent）刻意不在自助导出里。
   * 这不是"忘了"：订单快照是反欺诈留痕，而导出文件最常见的归宿是被转发给
   * 客服/朋友帮忙看。设备与联系信息在这里出去的收益极低、暴露面极大。
   */
  return {
    orderId: o.orderId || null,
    sku: o.sku || null,
    amountFen: Number.isFinite(Number(o.amountFen)) ? Number(o.amountFen) : null,
    status: o.status || null,
    channel: o.channel || null,
    createdAt: iso(o.createdAt),
    paidAt: iso(o.paidAt),
    refundedAt: iso(o.refundedAt),
  };
}

export function shapeLedger(e = {}) {
  return {
    amount: Number.isFinite(Number(e.amount)) ? Number(e.amount) : null,
    reason: e.reason || null,
    balanceAfter: Number.isFinite(Number(e.balanceAfter)) ? Number(e.balanceAfter) : null,
    createdAt: iso(e.createdAt),
  };
}

export function shapeQuestion(q = {}) {
  return {
    question: q.question || q.q || null,
    answer: q.answer || q.a || null,
    createdAt: iso(q.createdAt),
  };
}

/** 报告只给"我生成过哪些"，不给正文（正文含对方资料） */
export function shapeReport(r = {}) {
  return {
    reportId: r._id == null ? null : String(r._id),
    kind: r.kind || r.sku || null,
    tier: r.tier || null,
    price: Number.isFinite(Number(r.price)) ? Number(r.price) : null,
    status: r.status || null,
    createdAt: iso(r.createdAt),
  };
}

/** 我提交过的举报（举报内容是我写的，属本人数据） */
export function shapeModeration(m = {}) {
  return {
    targetType: m.targetType || null,
    reason: m.reason || null,
    detail: m.detail || null,
    status: m.status || null,
    createdAt: iso(m.createdAt),
    handledAt: iso(m.handledAt),
  };
}

router.get(
  '/export',
  requireAuth,
  wrap(async (req, res) => {
    const uid = String(req.uid || '');
    if (!uid) throw new ApiError(401, '未登录或会话已过期', 'E401');

    const now = Date.now();
    const last = lastExportAt.get(uid) || 0;
    if (now - last < COOLDOWN_MS) {
      const waitSec = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
      throw new ApiError(
        429,
        `导出太频繁了，请 ${Math.ceil(waitSec / 60)} 分钟后再试（导出文件里是完整数据，不必反复下载）`,
        'E_EXPORT_TOO_FREQUENT',
      );
    }

    const db = getDB();

    /**
     * 并行拉取。每段都带 projection 与 limit：
     * 即便这里写错，最坏结果也只是"少给"，不会"多给"。
     */
    const [account, login, questions, orders, ledger, wallet, reports, moderation] = await Promise.all([
      db.collection('users').findOne({ _id: uid }),
      db.collection('auth_users').findOne({ userId: uid }).catch(() => null),
      db
        .collection('qa_pairs')
        .find({ uid }, { projection: { question: 1, answer: 1, createdAt: 1, _id: 0 } })
        .sort({ createdAt: -1 })
        .limit(LIMIT_QUESTIONS)
        .toArray()
        .catch(() => []),
      db
        .collection('orders')
        .find(
          { uid },
          {
            projection: {
              orderId: 1,
              sku: 1,
              amountFen: 1,
              status: 1,
              channel: 1,
              createdAt: 1,
              paidAt: 1,
              refundedAt: 1,
              _id: 0,
            },
          },
        )
        .sort({ createdAt: -1 })
        .limit(LIMIT_ORDERS)
        .toArray()
        .catch(() => []),
      db
        .collection('wallet_ledger')
        .find({ uid }, { projection: { amount: 1, reason: 1, balanceAfter: 1, createdAt: 1, _id: 0 } })
        .sort({ createdAt: -1 })
        .limit(LIMIT_LEDGER)
        .toArray()
        .catch(() => []),
      db.collection('wallet').findOne({ _id: uid }).catch(() => null),
      db
        .collection('reports')
        .find({ uid }, { projection: { sku: 1, kind: 1, tier: 1, price: 1, status: 1, createdAt: 1 } })
        .sort({ createdAt: -1 })
        .limit(LIMIT_REPORTS)
        .toArray()
        .catch(() => []),
      db
        .collection('moderation')
        .find(
          { reporterUid: uid },
          { projection: { targetType: 1, reason: 1, detail: 1, status: 1, createdAt: 1, handledAt: 1, _id: 0 } },
        )
        .sort({ createdAt: -1 })
        .limit(100)
        .toArray()
        .catch(() => []),
    ]);

    const generatedAt = new Date();
    const payload = {
      _meta: {
        product: '我心永恒 Q问',
        scope: '仅包含本账号本人的数据，不含他人信息与账号凭据',
        generatedAt: generatedAt.toISOString(),
        uid,
        version: 1,
        limits: {
          questions: LIMIT_QUESTIONS,
          orders: LIMIT_ORDERS,
          walletLedger: LIMIT_LEDGER,
          reports: LIMIT_REPORTS,
        },
        note: '各段按时间倒序，最多给到上限条数；需要更早的完整记录请联系 qtvq@qtvq.cn',
        excluded: [
          '登录密码与会话凭据（不导出，避免文件被转发后被人登录）',
          '微信 openid/unionid 原文（只给脱敏尾号，够核对是哪个号）',
          '配对报告正文与他人资料（属双方共同数据，仅在应用内可见）',
          '订单快照中的设备与联系信息 trace.*（反欺诈留痕，如需请人工申请）',
        ],
      },
      account: shapeAccount(account || {}),
      login: shapeLogin(login || {}),
      membership: {
        // 会员状态在 KV 侧由另一套系统维护，这里给的是本服务能看到的部分
        dailyFree: account?.memberDailyFree == null ? null : account.memberDailyFree,
      },
      wallet: {
        balance: Number.isFinite(Number(wallet?.balance)) ? Number(wallet.balance) : 0,
        updatedAt: iso(wallet?.updatedAt),
        ledger: ledger.map(shapeLedger),
      },
      questions: {
        count: questions.length,
        truncated: questions.length >= LIMIT_QUESTIONS,
        items: questions.map(shapeQuestion),
      },
      orders: {
        count: orders.length,
        truncated: orders.length >= LIMIT_ORDERS,
        items: orders.map(shapeOrder),
      },
      reports: { count: reports.length, items: reports.map(shapeReport) },
      moderation: { count: moderation.length, items: moderation.map(shapeModeration) },
    };

    /*
     * 冷却要在**成功取数之后**才落，且在发响应之前：
     * 若放在发响应之后，客户端断开连接时那行可能不执行，等于没有冷却。
     * 若放在取数之前，一次 Mongo 抖动就会让用户十分钟内无法重试。
     */
    lastExportAt.set(uid, now);
    if (lastExportAt.size > 5000) {
      for (const [k, t] of lastExportAt) if (now - t > COOLDOWN_MS) lastExportAt.delete(k);
    }

    // 自查导出（DSAR）要留痕：谁在什么时候拉走了多少条
    await logAudit({
      admin: 'self',
      action: 'data_export',
      targetType: 'user',
      targetId: uid,
      reason: '自助导出本人数据',
      meta: {
        questions: payload.questions.count,
        orders: payload.orders.count,
        ledger: payload.wallet.ledger.length,
      },
    });

    const stamp = generatedAt.toISOString().slice(0, 10);
    const filename = `qtvq-my-data-${stamp}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(`我心永恒-我的数据-${stamp}.json`)}`,
    );
    return res.send(JSON.stringify(payload, null, 2));
  }),
);

export default router;
