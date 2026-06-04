import { corsPreflight, jsonResponse } from '../lib/http.js';
import { isNlsConfigured, recognizeOneSentence } from '../lib/aliyun-nls.js';

const MAX_AUDIO_BYTES = 512 * 1024;

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight(request);

  if (request.method !== 'POST') {
    return jsonResponse(request, { error: 'Method not allowed' }, 405);
  }

  if (!isNlsConfigured(env)) {
    return jsonResponse(
      request,
      {
        error: '语音识别服务未配置',
        code: 'SPEECH_NOT_CONFIGURED',
        hint: '请在 Cloudflare 配置 NLS_APP_KEY 与阿里云 AccessKey',
      },
      503
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, { error: '无效 JSON' }, 400);
  }

  const b64 = String(body.audio || '').trim();
  if (!b64) return jsonResponse(request, { error: '缺少 audio（base64）' }, 400);

  let raw;
  try {
    const bin = atob(b64);
    raw = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
  } catch {
    return jsonResponse(request, { error: 'audio 非合法 base64' }, 400);
  }

  if (raw.byteLength > MAX_AUDIO_BYTES) {
    return jsonResponse(request, { error: '录音过长，请控制在 30 秒内' }, 400);
  }

  const format = String(body.format || 'wav').slice(0, 10);
  const sampleRate = Number(body.sampleRate || 16000);

  try {
    const result = await recognizeOneSentence(env, raw, { format, sampleRate });
    if (!result.ok) {
      return jsonResponse(request, {
        ok: false,
        code: result.error,
        message: result.message || '未识别到语音',
      }, 422);
    }
    return jsonResponse(request, { ok: true, text: result.text });
  } catch (err) {
    console.error('[speech]', err);
    return jsonResponse(request, {
      error: err.message || '语音识别失败',
      code: 'SPEECH_FAILED',
    }, 502);
  }
}
