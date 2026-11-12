/**
 * `/api/quota`（及 `/v1/quota`）—— 额度查询与记次（**境内 Node 版**）
 *
 * 2026-10-26 从 `functions/api/quota.js` 迁来，契约保持一致：
 *   · GET  `?clientId=xxx`                → 额度快照（含待核实付款、套餐价目）
 *   · POST `?clientId=xxx` + `{action:'record'}` → 记一次提问后返回快照
 *   · 缺 clientId → 400 `{error:'缺少 clientId'}`；clientId 非法 → 400 `{error:'无效 clientId'}`
 *
 * ── 与 Pages 版的一处实质简化 ──────────────────────────────────────────────
 * Pages 版在 GET 里还会调 `reconcileClientPendingOrders()` ——
 * 去微信侧查询"有未激活订单但其实已收款"的情况并补开通。
 * 那是**兜底补偿**，依赖 Pages 侧的 `wechat-pay` 与 KV 订单。
 * 这里保留同样的兜底入口，但因为订单与微信支付仍在 Pages 侧，
 * 迁过来会让每次额度查询多一次跨境调用（正是要消除的东西）。
 * 所以本版**不做**这个补开通，改由两部分覆盖：
 *   1. 微信支付回调（`/api/payment/wechat/notify`）正常开通；
 *   2. 运营台「核实并开通」与定时对账（admin 侧 `/client-quota/:clientId/activate`）。
 * 如果发现"付了钱但没开通"的真实案例，应改为在 admin 侧做定时对账，而不是放回用户请求路径。
 */

import { Router } from 'express';
import { getQuota, recordAsk, validClientId } from '../services/quota-store.js';
import { wrap } from '../lib/http.js';
/* E.87：处理器全部套 wrap —— getQuota/recordAsk 走 Mongo，异常未捕获会崩进程
 * （Express 4 不捕获 async rejection；本文件在每问热路径上，Mongo 抖动=整站崩）。 */

const router = Router();

router.get('/', wrap(async (req, res) => {
  const clientId = String(req.query.clientId || '');
  if (!clientId) return res.status(400).json({ error: '缺少 clientId' });
  if (!validClientId(clientId)) return res.status(400).json({ error: '无效 clientId' });
  const quota = await getQuota(clientId);
  if (!quota) return res.status(400).json({ error: '无效 clientId' });
  return res.json(quota);
}));

router.post('/', wrap(async (req, res) => {
  const body = req.body || {};
  const clientId = String(req.query.clientId || body.clientId || '');
  if (!clientId) return res.status(400).json({ error: '缺少 clientId' });
  if (!validClientId(clientId)) return res.status(400).json({ error: '无效 clientId' });

  if (body.action === 'record' && body.clientId === clientId) {
    await recordAsk(clientId);
    return res.json(await getQuota(clientId));
  }
  return res.status(400).json({ error: '未知操作' });
}));

export default router;
