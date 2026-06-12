import { corsPreflight, jsonResponse } from '../lib/http.js';
import { isMailConfigured } from '../lib/mail.js';
import { isRagReady } from '../lib/rag.js';
import { isNlsConfigured } from '../lib/aliyun-nls.js';
import { getWechatPayConfig, isWechatPayConfigured } from '../lib/wechat-pay.js';

const PROBE_MODELS = [
  '@cf/zai-org/glm-4.7-flash',
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/meta/llama-3-8b-instruct',
];

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight(request);

  const result = {
    project: 'qtvq-api',
    aiBound: !!env.AI,
    kvBound: !!env.QTVQ_KV,
    mailConfigured: isMailConfigured(env),
    ragReady: isRagReady(),
    speechConfigured: isNlsConfigured(env),
    wechatPayConfigured: isWechatPayConfigured(env),
    wechatMchId: getWechatPayConfig(env).mchId || null,
    aiProbe: null,
    aiError: null,
    hint: null,
  };

  if (!env.AI) {
    result.hint =
      'Workers AI 未绑定。Dashboard → qtvq-api → Settings → Functions → Bindings → 添加 Workers AI，变量名 AI，然后 npm run deploy';
    return jsonResponse(request, result);
  }

  for (const model of PROBE_MODELS) {
    try {
      const response = await env.AI.run(model, {
        messages: [{ role: 'user', content: '回复一个字：好' }],
        max_tokens: 16,
      });
      const text =
        response?.response ||
        response?.result?.response ||
        (typeof response === 'string' ? response : null);
      if (text) {
        result.aiProbe = { ok: true, model, sample: String(text).slice(0, 40) };
        return jsonResponse(request, result);
      }
    } catch (err) {
      result.aiError = `${model}: ${err.message || String(err)}`;
    }
  }

  result.aiProbe = { ok: false };
  result.hint =
    'AI 已绑定但调用失败。检查 Cloudflare 账号 Workers AI 是否开通、额度是否用尽，或换模型后重新 deploy';
  return jsonResponse(request, result);
}
