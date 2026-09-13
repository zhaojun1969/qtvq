/**
 * 转盘接口
 *
 * GET  /v1/wheel/candidates  拿候选头像（用于转盘扇区预览）
 * POST /v1/wheel/spin        转一次：服务端抽签 + 幂等扣费
 * GET  /v1/wheel/history     我的转动记录
 *
 * 注意：**抽签结果的权威来源是服务端**。前端先调 `/spin` 拿到 `targetIndex` 与 `sectors`，
 * 再播放动画停到该扇区 —— 前端只做呈现，不做决策。
 */
import { Router } from 'express';
import { env } from '../config/env.js';
import { ok, wrap } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { loadCandidates, listSpins, quoteSpin, spin } from '../services/wheel.js';

const router = Router();

router.get(
  '/candidates',
  requireAuth,
  wrap(async (req, res) => {
    const { getDB } = await import('../config/db.js');
    const me = await getDB().collection('users').findOne({ _id: req.uid });
    if (!me?.gender) {
      return ok(res, { items: [], needsProfile: true, sectors: env.wheelSectors });
    }
    const { items, total, excludedRecent } = await loadCandidates(me);
    return ok(res, {
      // 只返回展示所需字段，绝不含 profileVector
      items: items.map((x) => ({
        uid: x.user._id,
        nickname: x.user.nickname || 'TA',
        avatar: x.user.avatar || null,
        age: x.user.age || null,
        city: x.user.city || null,
        tags: Array.isArray(x.user.tags) ? x.user.tags.slice(0, 6) : [],
      })),
      sectors: env.wheelSectors,
      candidatesCount: total,
      excludedRecent,
      // 空态要能被前端识别，而不是静默给一个空转盘
      empty: total === 0,
      hint: total === 0 ? '还没有可配对的真实用户，可以先生成邀请链接发给朋友' : null,
      price: env.wheelPrice,
    });
  }),
);

router.post(
  '/spin',
  requireAuth,
  wrap(async (req, res) => {
    const idempotencyKey =
      String(req.body?.idempotencyKey || req.headers['x-idempotency-key'] || '').trim().slice(0, 80) || null;
    const result = await spin({ uid: req.uid, membership: req.membership, idempotencyKey });
    return ok(res, result);
  }),
);

/** 转一次要花多少（前端在按钮上显示价格用） */
router.get(
  '/quote',
  requireAuth,
  wrap(async (req, res) => {
    const bill = await quoteSpin({ uid: req.uid, membership: req.membership });
    return ok(res, { ...bill, sectors: env.wheelSectors });
  }),
);

router.get(
  '/history',
  requireAuth,
  wrap(async (req, res) => {
    const limit = Number(req.query.limit) || 20;
    return ok(res, { items: await listSpins(req.uid, limit) });
  }),
);

export default router;
