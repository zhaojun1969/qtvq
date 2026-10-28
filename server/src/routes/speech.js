/**
 * `/api/speech` —— 语音识别（阿里云 NLS 一句话识别），自建 Node 版本。
 *
 * ── 为什么迁它（而不是 `/api/chat`）────────────────────────────────────────
 * `/api/chat` 与 **额度/计费**强耦合（`functions/api/chat.js:5` 引 `canAsk/recordAsk/getQuota`
 * 来自 `functions/lib/quota-store.js`，数据在 Cloudflare KV），迁它等于把「KV → Mongo」一起拖进来，
 * 违背"一次只动一个变量"。而 `/api/speech` **不查额度、不碰 KV、不写库**，是干净的一个变量。
 *
 * ── 契约逐字对齐 `functions/api/speech.js`（前端不改一行就能切）──────────────
 *   GET  / → { configured, ready, reason, nlsCode }（真实换一次 token，能发现"变量齐全但没权限"）
 *   POST / → { ok:true, text }
 *          · 非 JSON           → 400 { error:'无效 JSON' }
 *          · 缺 audio          → 400 { error:'缺少 audio（base64）' }
 *          · base64 非法       → 400 { error:'audio 非合法 base64' }
 *          · 超过 512KB        → 400 { error:'录音过长，请控制在 30 秒内' }
 *          · 未配置            → 503 { error, code:'SPEECH_NOT_CONFIGURED', hint }
 *          · 识别失败          → 422 { ok:false, code, message }
 *          · 上游异常          → 502 { error, code:'SPEECH_FAILED', nlsCode, raw, hint }
 *   注意 Pages 侧 `isNlsConfigured` 检查不通过时返回 **503**，而识别失败返回 **422** ——
 *   这两个码前端是用来区分"功能没开"和"这次没听清"的，不能混。
 */
import express, { Router } from 'express';
import { isNlsConfigured, recognizeOneSentence, probeNls } from '../lib/aliyun-nls.js';

const MAX_AUDIO_BYTES = 512 * 1024;

// Pages 侧把 env 当参数传；Node 侧的等价物就是 process.env（aliyun-nls.js 只读 env.NLS_* 等键）
const env = process.env;
const router = Router();

/** GET = 真实就绪探测（前端据此决定语音按钮是否可用） */
router.get('/', async (req, res) => {
  const probe = await probeNls(env);
  res.json({
    configured: isNlsConfigured(env),
    ready: probe.ready,
    reason: probe.reason,
    nlsCode: probe.nlsCode,
  });
});

/*
 * ⚠️ 单独的 body 解析器，且 limit 必须 ≥1mb：
 * base64 会把体积放大约 1/3，上限 512KB 的录音 → JSON 里约 683KB。
 * 全局 `express.json({ limit: '256kb' })` 会先把它判成 413，所以这里必须显式放大
 * （app.js 里的全局限制也相应放宽，见那里的注释）。
 */
router.post('/', express.json({ limit: '1mb' }), async (req, res) => {
  if (!isNlsConfigured(env)) {
    return res.status(503).json({
      error: '语音识别服务未配置',
      code: 'SPEECH_NOT_CONFIGURED',
      hint: '请在 server/.env 配置 NLS_APP_KEY，以及一组有「智能语音交互」权限的 AccessKey（NLS_ACCESS_KEY_ID / NLS_ACCESS_KEY_SECRET）',
    });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const b64 = String(body.audio || '').trim();
  if (!b64) return res.status(400).json({ error: '缺少 audio（base64）' });

  let raw;
  try {
    const bin = Buffer.from(b64, 'base64');
    // Buffer.from 对非法 base64 很宽容（会静默丢弃非法字符），所以要自己校验一次
    if (!bin.length || bin.toString('base64').replace(/=+$/, '') !== b64.replace(/=+$/, '')) {
      throw new Error('bad base64');
    }
    raw = new Uint8Array(bin);
  } catch {
    return res.status(400).json({ error: 'audio 非合法 base64' });
  }

  if (raw.byteLength > MAX_AUDIO_BYTES) {
    return res.status(400).json({ error: '录音过长，请控制在 30 秒内' });
  }

  const format = String(body.format || 'wav').slice(0, 10);
  const sampleRate = Number(body.sampleRate || 16000);

  try {
    const result = await recognizeOneSentence(env, raw, { format, sampleRate });
    if (!result.ok) {
      return res.status(422).json({
        ok: false,
        code: result.error,
        message: result.message || '未识别到语音',
      });
    }
    return res.json({ ok: true, text: result.text });
  } catch (err) {
    console.error('[speech]', err?.nlsCode || '', err?.message);
    return res.status(502).json({
      error: err?.message || '语音识别失败',
      code: 'SPEECH_FAILED',
      nlsCode: err?.nlsCode || null,
      raw: err?.raw || null,
      hint: err?.nlsCode
        ? `阿里云返回 ${err.nlsCode}。若为 40020503：该 AccessKey 缺少「智能语音交互」权限，或账号未开通该服务。`
        : null,
    });
  }
});

export default router;
