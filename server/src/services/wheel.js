/**
 * 转盘：候选召回 + 服务端抽签 + 记录
 *
 * 三条硬规则（都是刻意的，别改）：
 *
 * 1. **抽签结果由服务端决定**。计划书的前端实现是 `const targetIndex = Math.floor(Math.random()*n)`
 *    再回传 `target_uid` —— 那样任何人都能直接调接口指定想配对的人，还能重放刷。这里反过来：
 *    服务端先定 target，前端只负责把动画停到对应扇区。
 *
 * 2. **候选只来自真实活跃账号**。计划书「女头像不够 → 虚拟头像池」是红线：
 *    用户付费后转到的"异性"若是机器生成的假人，构成欺诈（消保法 55 条退一赔三）。
 *    因此候选池条件写死 `status=active`，且**池子不足时返回空态，绝不填充假人**。
 *
 * 3. **先确认有候选，再扣费**。否则会出现"扣了钱但转盘没东西可指"。
 *
 * 关于为什么不用向量：候选打分只用标签/城市/年龄这些轻量字段。
 * 拉 1024 维向量做全库相似度意味着每次转动要取回几百个向量（数 MB）—— 而转盘只需要
 * "挑一个合适的"，语义精算交给报告（那里只有两个人，向量是常数成本）。
 * 这也正好绕开计划书「一键 Docker 就建不了 Atlas 向量索引」的自相矛盾。
 * 规模上限：候选数受 WHEEL_POOL_LIMIT 约束，万级用户前都够用；再大就该换 ANN 方案。
 */
import { randomInt } from 'node:crypto';
import { getDB } from '../config/db.js';
import { env } from '../config/env.js';
import { USER_STATUS } from '../constants.js';
import { ApiError, badRequest } from '../lib/http.js';
import { ageScore, cityScore, jaccard } from './dimensions.js';
import { quote, spend, startOfDayCN } from './wallet.js';

/** 只取打分需要的字段；**绝不带 profileVector**（那是数 MB 的额外开销） */
const CANDIDATE_PROJECTION = {
  _id: 1,
  nickname: 1,
  avatar: 1,
  gender: 1,
  age: 1,
  city: 1,
  tags: 1,
  intro: 1,
};

function oppositeGender(gender) {
  if (gender === 'male') return 'female';
  if (gender === 'female') return 'male';
  return null;
}

/** 轻量打分：标签 0.4 + 城市 0.3 + 年龄 0.2 + 资料完整 0.1 */
function candidateScore(me, ta) {
  const tag = jaccard(me.tags, ta.tags);
  const city = cityScore(me.city, ta.city);
  const age = ageScore(me.age, ta.age);
  const complete = (ta.intro ? 0.5 : 0) + (Array.isArray(ta.tags) && ta.tags.length ? 0.5 : 0);
  return tag * 0.4 + city * 0.3 + age * 0.2 + complete * 0.1;
}

/**
 * 公开给转盘的字段。
 * gender 只用于前端画「模拟人像」剪影的性别区分（扇区里那个头像位置）；
 * 转盘本身就是异性配对，性别不构成额外信息泄露。除此之外不含任何标识。
 */
function publicCandidate(u) {
  return {
    uid: u._id,
    nickname: u.nickname || 'TA',
    avatar: u.avatar || null,
    gender: u.gender || null,
    age: u.age || null,
    city: u.city || null,
    tags: Array.isArray(u.tags) ? u.tags.slice(0, 6) : [],
    intro: u.intro || '',
  };
}

/**
 * 取候选池并打分排序。
 * @returns {Promise<{items: Array, total: number, excludedRecent: number}>}
 */
export async function loadCandidates(me, { limit = env.wheelSectors } = {}) {
  const db = getDB();
  const targetGender = oppositeGender(me.gender);
  if (!targetGender) throw badRequest('请先完善资料（需要性别）', 'E_NEED_PROFILE');

  // 最近转到过的人，短期内不再出现
  const recent = await db
    .collection('spin_logs')
    .find({ uid: me._id }, { projection: { targetUid: 1 }, sort: { createdAt: -1 }, limit: env.wheelRecentExclude })
    .toArray();
  const recentIds = recent.map((r) => r.targetUid);

  const filter = {
    _id: { $nin: [me._id, ...recentIds] },
    gender: targetGender,
    status: USER_STATUS.ACTIVE,
    nickname: { $nin: [null, ''] },
  };

  const pool = await db
    .collection('users')
    .find(filter, { projection: CANDIDATE_PROJECTION })
    .limit(env.wheelPoolLimit)
    .toArray();

  const scored = pool
    .map((u) => ({ user: u, score: candidateScore(me, u) }))
    .sort((a, b) => b.score - a.score);

  return {
    items: scored.slice(0, Math.max(1, limit)),
    total: scored.length,
    excludedRecent: recentIds.length,
  };
}

/** 我的资料是否足以转盘 */
async function loadMe(uid) {
  const me = await getDB().collection('users').findOne({ _id: uid });
  if (!me) throw badRequest('请先完善自己的资料', 'E_NEED_PROFILE');
  if (!me.nickname || !me.gender) throw badRequest('请先完善资料（昵称与性别必填）', 'E_NEED_PROFILE');
  return me;
}

/** 今日已用掉的会员免费转动次数 */
export async function spinsUsedToday(uid) {
  return getDB()
    .collection('spin_logs')
    .countDocuments({ uid, reason: 'member_daily_spin', createdAt: { $gte: startOfDayCN() } });
}

/** 转动报价：只算不扣 */
export async function quoteSpin({ uid, membership }) {
  const price = env.wheelPrice;
  const base = { price, enforce: env.enforceBilling };
  if (!env.enforceBilling) return { ...base, amount: 0, reason: 'billing_disabled', label: '计费未开启（灰度）' };
  if (price <= 0) return { ...base, amount: 0, reason: 'wheel_free', label: '转盘免费' };
  if (membership?.active) {
    const used = await spinsUsedToday(uid);
    if (used < env.memberDailySpins) {
      return {
        ...base,
        amount: 0,
        reason: 'member_daily_spin',
        label: `会员每日免费（今日还可免 ${Math.max(0, env.memberDailySpins - used)} 次）`,
      };
    }
  }
  return { ...base, amount: price, reason: 'wheel_spin', label: `每次 ¥${price}` };
}

/**
 * 转一次：**先确认有候选 → 再扣费 → 再抽签落库**。
 *
 * @param {{uid:string, membership?:object, idempotencyKey?:string}} params
 */
export async function spin({ uid, membership, idempotencyKey = null }) {
  const db = getDB();
  const me = await loadMe(uid);

  // ① 先看有没有候选。**空态不扣费** —— 不能出现「扣了钱但转盘没东西可指」
  const { items, total, excludedRecent } = await loadCandidates(me);
  if (!items.length) {
    return {
      empty: true,
      reason: 'NO_CANDIDATES',
      candidatesCount: 0,
      excludedRecent,
      price: env.wheelPrice,
      hint:
        '现在还没有可配对的真实用户。转盘只会指向真实活跃账号，不会用假人充数 —— ' +
        '可以先生成邀请链接发给朋友，对方填写资料后就会进入候选池。',
    };
  }

  // ② 报价并扣费（幂等，重复请求只扣一次）
  const bill = await quoteSpin({ uid, membership });
  const paid = await spend(uid, bill.amount, {
    reason: bill.reason,
    idempotencyKey,
    meta: { kind: 'wheel_spin', candidates: items.length },
  });

  // 幂等重放：返回上一次的抽签结果，而不是再抽一次（抽签有随机性，重放必须一致）
  if (paid.replayed) {
    if (paid.failed) {
      throw new ApiError(
        402,
        `余额不足：转一次需要 ¥${bill.price.toFixed(2)}，当前余额 ¥${Number(paid.balance || 0).toFixed(2)}`,
        'E_INSUFFICIENT_BALANCE',
      );
    }
    const prev = await db.collection('spin_logs').findOne({ idempotencyKey });
    if (prev) {
      const target = await db.collection('users').findOne({ _id: prev.targetUid }, { projection: CANDIDATE_PROJECTION });
      return {
        spinId: String(prev._id),
        replayed: true,
        sectors: prev.sectorsSnapshot || [],
        targetIndex: prev.targetIndex,
        target: target ? publicCandidate(target) : null,
        score: prev.matchedScore,
        candidatesCount: prev.candidatesCount ?? null,
        billing: { ...bill, charged: 0, balance: paid.entry?.balanceAfter ?? null, replayed: true },
      };
    }
  }

  // ③ 服务端抽签：在打分靠前的候选里随机（不是纯随机，也不是全按分数）
  const targetIndex = randomInt(0, items.length);
  const chosen = items[targetIndex];
  const now = new Date();

  const doc = {
    uid,
    targetUid: chosen.user._id,
    targetIndex,
    sectorsSnapshot: items.map((x) => publicCandidate(x.user)),
    matchedScore: Number(chosen.score.toFixed(4)),
    amount: paid.charged,
    reason: bill.reason,
    tier: null,
    candidatesCount: total,
    idempotencyKey,
    createdAt: now,
  };
  const { insertedId } = await db.collection('spin_logs').insertOne(doc);
  if (idempotencyKey) {
    await db.collection('wallet_ledger').updateOne({ idempotencyKey }, { $set: { ref: String(insertedId) } });
  }

  return {
    spinId: String(insertedId),
    replayed: false,
    sectors: doc.sectorsSnapshot,
    targetIndex,
    target: publicCandidate(chosen.user),
    score: doc.matchedScore,
    candidatesCount: total,
    excludedRecent,
    billing: { ...bill, charged: paid.charged, balance: paid.balance, replayed: false },
  };
}

/** 转盘历史 */
export async function listSpins(uid, limit = 20) {
  const items = await getDB()
    .collection('spin_logs')
    .find({ uid }, { projection: { sectorsSnapshot: 0 } })
    .sort({ createdAt: -1 })
    .limit(Math.min(50, Math.max(1, limit)))
    .toArray();
  return items.map((x) => ({
    id: String(x._id),
    targetUid: x.targetUid,
    matchedScore: x.matchedScore,
    amount: x.amount,
    reason: x.reason,
    createdAt: x.createdAt,
  }));
}

/** 转盘统计（运营台用） */
export async function spinStats() {
  const db = getDB();
  const today = startOfDayCN();
  const [total, todayCount, revenue] = await Promise.all([
    db.collection('spin_logs').estimatedDocumentCount(),
    db.collection('spin_logs').countDocuments({ createdAt: { $gte: today } }),
    db
      .collection('spin_logs')
      .aggregate([{ $match: { amount: { $gt: 0 } } }, { $group: { _id: null, sum: { $sum: '$amount' } } }])
      .toArray(),
  ]);
  return { total, today: todayCount, revenue: Math.round((revenue[0]?.sum || 0) * 100) / 100 };
}
