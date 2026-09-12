/**
 * 资料接口
 *
 * 路线 B 的一切都建立在这里：没有资料就没有向量，没有向量就没有报告。
 * 因此本文件把「资料合法性 + 向量重算」绑在同一个写路径上，
 * 杜绝计划书里「改资料不重算向量」导致的匹配漂移。
 */
import { Router } from 'express';
import { getDB } from '../config/db.js';
import { USER_STATUS } from '../constants.js';
import { badRequest, notFound, ok, wrap } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { embedOne, profileText } from '../services/embed.js';
import { assertSafe } from '../services/content-safety.js';

const router = Router();

const NICKNAME_MAX = 20;
const INTRO_MAX = 200;
const TAGS_MAX = 10;
const TAG_LEN_MAX = 8;

/** 未成年保护 + 明显联系方式/引流词的拦截（长文本审核走后续内容安全接入） */
const CONTACT_RE = /(1[3-9]\d{9})|(微信|威信|vx|VX|薇信)\s*[:：]?\s*[A-Za-z0-9_-]{5,}|(QQ|qq)\s*[:：]?\s*\d{5,}/;

function sanitizeTags(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input) {
    const t = String(raw || '').trim();
    if (!t || t.length > TAG_LEN_MAX) continue;
    if (!out.includes(t)) out.push(t);
    if (out.length >= TAGS_MAX) break;
  }
  return out;
}

function validateProfileInput(body = {}, { partial = false } = {}) {
  const patch = {};

  if (body.nickname !== undefined) {
    const nickname = String(body.nickname || '').trim();
    if (!nickname) throw badRequest('昵称不能为空', 'E_NICKNAME');
    if (nickname.length > NICKNAME_MAX) throw badRequest(`昵称最长 ${NICKNAME_MAX} 字`, 'E_NICKNAME');
    if (CONTACT_RE.test(nickname)) throw badRequest('昵称中请勿填写联系方式', 'E_CONTACT');
    patch.nickname = nickname;
  } else if (!partial) {
    throw badRequest('请填写昵称', 'E_NICKNAME');
  }

  if (body.gender !== undefined) {
    const g = String(body.gender || '').trim();
    if (!['male', 'female'].includes(g)) throw badRequest('性别只能是 male 或 female', 'E_GENDER');
    patch.gender = g;
  } else if (!partial) {
    throw badRequest('请选择性别', 'E_GENDER');
  }

  if (body.age !== undefined) {
    const age = Number(body.age);
    if (!Number.isInteger(age) || age < 18 || age > 80) {
      throw badRequest('本平台仅面向 18 岁以上用户，年龄需在 18–80 之间', 'E_AGE');
    }
    patch.age = age;
  }

  if (body.city !== undefined) patch.city = String(body.city || '').trim().slice(0, 20);
  if (body.job !== undefined) patch.job = String(body.job || '').trim().slice(0, 30);
  if (body.height !== undefined) {
    const h = Number(body.height);
    patch.height = Number.isFinite(h) && h > 100 && h < 250 ? Math.round(h) : null;
  }
  if (body.tags !== undefined) patch.tags = sanitizeTags(body.tags);
  if (body.intro !== undefined) {
    const intro = String(body.intro || '').trim();
    if (intro.length > INTRO_MAX) throw badRequest(`自我介绍最长 ${INTRO_MAX} 字`, 'E_INTRO');
    if (CONTACT_RE.test(intro)) throw badRequest('自我介绍中请勿填写联系方式', 'E_CONTACT');
    patch.intro = intro;
  }

  return patch;
}

/** 资料是否足以生成报告 */
function completeness(u) {
  const checks = {
    nickname: !!u.nickname,
    gender: !!u.gender,
    age: !!u.age,
    city: !!u.city,
    tags: Array.isArray(u.tags) && u.tags.length >= 1,
    intro: !!u.intro && u.intro.length >= 5,
  };
  const missing = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  const score = (Object.values(checks).filter(Boolean).length / Object.keys(checks).length);
  return { score: Number(score.toFixed(2)), missing, ready: missing.length <= 1 };
}

export function publicUser(u, { self = false } = {}) {
  const base = {
    uid: u._id,
    nickname: u.nickname || null,
    avatar: u.avatar || null,
    gender: u.gender || null,
    age: u.age || null,
    city: u.city || null,
    job: u.job || null,
    height: u.height || null,
    tags: Array.isArray(u.tags) ? u.tags : [],
    intro: u.intro || '',
    status: u.status || USER_STATUS.ACTIVE,
  };
  if (!self) {
    base.completeness = completeness(u);
    return base;
  }
  return {
    ...base,
    hasProfileVector: Array.isArray(u.profileVector) && u.profileVector.length > 0,
    profileVectorDims: Array.isArray(u.profileVector) ? u.profileVector.length : 0,
    profileVectorUpdatedAt: u.profileVectorUpdatedAt || null,
    completeness: completeness(u),
    createdAt: u.createdAt || null,
    updatedAt: u.updatedAt || null,
  };
}

/** 重算向量：资料向量 + 简介向量（分开存，供不同维度使用） */
async function recomputeVectors(doc) {
  const text = profileText(doc);
  const [profileVector, introVector] = await Promise.all([
    text ? embedOne(text) : Promise.resolve(null),
    doc.intro ? embedOne(doc.intro) : Promise.resolve(null),
  ]);
  return { profileVector, introVector };
}

router.get(
  '/me',
  requireAuth,
  wrap(async (req, res) => {
    const db = getDB();
    const me = await db.collection('users').findOne({ _id: req.uid });
    if (!me) {
      // 老用户可能是第一次进入新服务：先给出空壳，等 PATCH 落地
      return ok(res, { user: { uid: req.uid, nickname: null, status: USER_STATUS.ACTIVE }, isNew: true });
    }
    return ok(res, { user: publicUser(me, { self: true }), isNew: false });
  }),
);

router.patch(
  '/me',
  requireAuth,
  wrap(async (req, res) => {
    const db = getDB();
    const patch = validateProfileInput(req.body, { partial: true });
    if (!Object.keys(patch).length) throw badRequest('没有需要更新的字段', 'E_EMPTY_PATCH');

    // 词表级内容安全（涉黄/涉赌/涉毒/诈骗/引流/辱骂）。
    // 上面 validateProfileInput 里的 CONTACT_RE 是同步快速拦截、错误码更精确；
    // 这里再用词表过一遍，两层互补而不是互相替代。
    const safetyText = [patch.nickname, patch.intro, ...(patch.tags || [])].filter(Boolean).join(' ');
    if (safetyText) await assertSafe(safetyText, { field: 'profile', label: '资料' });

    const existing = (await db.collection('users').findOne({ _id: req.uid })) || { _id: req.uid, createdAt: new Date() };
    const merged = { ...existing, ...patch };

    const needsVector = ['gender', 'age', 'city', 'job', 'height', 'tags', 'intro'].some((k) => k in patch);
    const { profileVector, introVector } = needsVector
      ? await recomputeVectors(merged)
      : { profileVector: existing.profileVector || null, introVector: existing.introVector || null };

    const now = new Date();
    await db.collection('users').updateOne(
      { _id: req.uid },
      {
        $set: {
          ...patch,
          profileVector,
          introVector,
          status: existing.status || USER_STATUS.ACTIVE,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );

    const saved = await db.collection('users').findOne({ _id: req.uid });
    return ok(res, {
      user: publicUser(saved, { self: true }),
      vectorUpdated: needsVector,
      vectorDims: Array.isArray(profileVector) ? profileVector.length : 0,
    });
  }),
);

router.get(
  '/:uid',
  requireAuth,
  wrap(async (req, res) => {
    const db = getDB();
    const u = await db.collection('users').findOne({ _id: String(req.params.uid) });
    if (!u) throw notFound('用户不存在');
    if (u.status === USER_STATUS.BANNED) throw notFound('用户不存在');
    return ok(res, { user: publicUser(u) });
  }),
);

export default router;
