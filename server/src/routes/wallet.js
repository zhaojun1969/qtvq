/** 钱包：余额、流水、报价预览 */
import { Router } from 'express';
import { TIERS } from '../constants.js';
import { ok, wrap } from '../lib/http.js';
import { env } from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';
import { getWallet, listLedger, quote } from '../services/wallet.js';

const router = Router();

router.get(
  '/',
  requireAuth,
  wrap(async (req, res) => {
    const wallet = await getWallet(req.uid);
    // 各档位「对我会收多少」——前端据此显示价格与「会员每日免费」提示
    const quotes = {};
    for (const key of Object.keys(TIERS)) {
      // eslint-disable-next-line no-await-in-loop
      quotes[key] = await quote({ uid: req.uid, tier: key, membership: req.membership });
    }
    return ok(res, {
      wallet,
      membership: req.membership || { active: false },
      tiers: TIERS,
      quotes,
      billing: {
        enforce: env.enforceBilling,
        freeTiers: env.freeTiers,
        memberDailyFree: env.memberDailyFree,
      },
    });
  }),
);

router.get(
  '/ledger',
  requireAuth,
  wrap(async (req, res) => {
    const limit = Number(req.query.limit) || 30;
    return ok(res, { items: await listLedger(req.uid, limit) });
  }),
);

export default router;
