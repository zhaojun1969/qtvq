/**
 * 内容安全预检：前端在提交资料/提问前可以自检，避免填完才被拒。
 * 不鉴权（纯文本检查，无副作用），但做了长度限制防止被当免费内容审核网关刷。
 */
import { Router } from 'express';
import { badRequest, ok, wrap } from '../lib/http.js';
import { checkText, safetyStatus } from '../services/content-safety.js';

const router = Router();

const ALLOWED_FIELDS = ['profile', 'question', 'moderation', 'default'];

router.get(
  '/status',
  wrap(async (req, res) => ok(res, safetyStatus())),
);

router.post(
  '/check',
  wrap(async (req, res) => {
    const { text, field = 'default' } = req.body || {};
    if (typeof text !== 'string') throw badRequest('缺少 text', 'E_NO_TEXT');
    if (text.length > 2000) throw badRequest('文本过长（≤2000 字）', 'E_TEXT_LONG');
    if (!ALLOWED_FIELDS.includes(field)) throw badRequest('无效的 field', 'E_BAD_FIELD');

    const result = await checkText(text, { field });
    return ok(res, {
      clean: result.clean,
      action: result.action,
      categories: result.categories || [],
      hits: result.hits || [],
      provider: result.provider,
    });
  }),
);

export default router;
