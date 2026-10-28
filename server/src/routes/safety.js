/**
 * 内容安全预检：前端在提交资料/提问前可以自检，避免填完才被拒。
 * 不鉴权（纯文本检查，无副作用），但做了长度限制防止被当免费内容审核网关刷。
 */
import { Router } from 'express';
import { badRequest, ApiError, ok, wrap } from '../lib/http.js';
import { checkText, safetyStatus } from '../services/content-safety.js';
import { greenStatus, greenImageCheckByUrl, isGreenConfigured } from '../services/aliyun-green.js';

const router = Router();

const ALLOWED_FIELDS = ['profile', 'question', 'moderation', 'default'];

router.get(
  '/status',
  wrap(async (req, res) =>
    ok(res, {
      ...safetyStatus(),
      // 外部权威审核（阿里云内容安全）的真实状态：未配置时**如实报** ——
      // "本地词表兜底"与"有持牌服务在审"是两件事，不能让人误以为已经全覆盖
      green: greenStatus(),
    }),
  ),
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
      // 外部审核是否真的参与判定（ok / skipped / degraded / error）
      external: result.external || null,
      // true = 外部服务不可用，本次结论不完整，建议转人工复核
      needsReview: !!result.needsReview,
    });
  }),
);

/**
 * 图片审核：`POST /v1/safety/image { url }`
 *
 * 只支持 **URL**（不支持 base64）：本项目目前的图片都是外链 URL（没有上传通道），
 * 而 base64 会让请求体膨胀 4/3、接口对体积有限制 —— 与其写一个"大图必失败"的实现，
 * 不如明确要求"先上传拿 URL"。
 *
 * ⚠️ 未配置内容安全时返回 **503 + 明确原因**，而不是 `clean:true`：
 * 后者会让调用方以为"已审核通过"，是最危险的假安全。
 */
router.post(
  '/image',
  wrap(async (req, res) => {
    const { url } = req.body || {};
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      throw badRequest('缺少 url（必须是 http/https 图片地址）', 'E_BAD_IMAGE_URL');
    }
    if (url.length > 1000) throw badRequest('url 过长', 'E_IMAGE_URL_LONG');
    if (!isGreenConfigured()) {
      // expose:true —— 这条 503 的原因必须让运维看到（否则只看到一个 503，不知道该配什么）
      const e = new ApiError(
        503,
        '图片审核未启用：需在 server/.env 配置 GREEN_ACCESS_KEY_ID / GREEN_ACCESS_KEY_SECRET 并开通阿里云内容安全',
        'E_GREEN_NOT_CONFIGURED',
      );
      e.expose = true;
      throw e;
    }
    try {
      const r = await greenImageCheckByUrl(url);
      return ok(res, {
        clean: r.clean,
        categories: r.categories,
        labels: r.labels,
        riskLevel: r.riskLevel,
        provider: r.provider,
      });
    } catch (err) {
      // 上游失败必须让调用方知道"没审成"，不能吞掉变成"通过"
      throw new ApiError(502, `图片审核失败：${err.message}`, 'E_GREEN_UPSTREAM');
    }
  }),
);

export default router;
