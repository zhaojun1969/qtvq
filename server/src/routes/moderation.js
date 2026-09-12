/** 举报入口：用户提交 / 查看自己的举报 */
import { Router } from 'express';
import { ok, wrap } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { createReport, listMyReports } from '../services/moderation.js';
import { checkText } from '../services/content-safety.js';

const router = Router();

router.post(
  '/report',
  requireAuth,
  wrap(async (req, res) => {
    const { targetType, targetId, reason, detail = '', evidence = [] } = req.body || {};

    // 举报补充说明不拦截（否则用户没法描述违规内容），但把命中的类别记下来供运营参考
    const safety = await checkText(detail, { field: 'moderation' });

    const result = await createReport({
      reporterUid: req.uid,
      targetType,
      targetId,
      reason,
      detail,
      evidence,
    });

    return ok(res, {
      ...result,
      safety: safety.clean ? null : { categories: safety.categories },
    });
  }),
);

router.get(
  '/mine',
  requireAuth,
  wrap(async (req, res) => {
    const limit = Number(req.query.limit) || 20;
    return ok(res, { items: await listMyReports(req.uid, limit) });
  }),
);

export default router;
