import { corsPreflight, jsonResponse } from '../lib/http.js';
import { isMailConfigured } from '../lib/mail.js';
import { isRagReady } from '../lib/rag.js';
import { isNlsConfigured } from '../lib/aliyun-nls.js';
import { isWechatMpLoginConfigured } from '../lib/wechat-mp.js';
import { isWechatOpenLoginConfigured } from '../lib/wechat-open.js';
import { getWechatPayConfig, isWechatPayConfigured } from '../lib/wechat-pay.js';
import { runChatChain, describeChain, isLlmReady } from '../lib/llm-chain.js';

/*
 * 模型链已统一到 `lib/llm-chain.js`（百炼/通义 → Workers AI）。
 *
 * 这里原来自己维护一份 PROBE_MODELS，与 chat.js 各写一份，于是"改了一处忘另一处"
 * 造成过两次假阴性（链里留着已废弃的 llama-3-8b，/api/health 永远报"AI 挂了"，
 * 而聊天接口完全正常）。现在探测与聊天用的是**同一个 resolveChain(env)**，
 * 不一致这种故障模式从结构上消失。
 */

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight(request);

  const payConfig = getWechatPayConfig(env);
  const platformKeyConfigured = /BEGIN (PUBLIC KEY|CERTIFICATE)/.test(payConfig.platformPublicKey || '');

  const result = {
    project: 'qtvq-api',
    aiBound: !!env.AI,
    // 当前生效的模型链（provider + model + 是否具备调用条件）；不含任何密钥。
    // 换模型后不必猜"到底生效没生效"，这一眼就能看到。
    llmChain: describeChain(env),
    llmReady: isLlmReady(env),
    kvBound: !!env.QTVQ_KV,
    mailConfigured: isMailConfigured(env),
    ragReady: isRagReady(),
    speechConfigured: isNlsConfigured(env),
    wechatPayConfigured: isWechatPayConfigured(env),
    // 回调验签依赖它：没有它，微信回调一律被拒（宁可不入账也不接受伪造），
    // 客户付款后会走"主动查询自愈"开通，但即时性不如回调。
    wechatPlatformKeyConfigured: platformKeyConfigured,
    // 微信回调实际会打到的地址（非机密）。改完 WECHAT_PAY_NOTIFY_URL 必须重新部署才生效，
    // 这里把它显示出来，避免"改了环境变量但线上没生效"却无人察觉。
    wechatNotifyUrl: payConfig.notifyUrl || null,
    wechatMchId: payConfig.mchId || null,
    checkedAt: new Date().toISOString(),
    aiProbe: null,
    aiError: null,
    aiErrors: [],
    hint: null,
  };

  if (!isLlmReady(env)) {
    result.hint =
      '模型链里没有一条可用：既未配置 DASHSCOPE_API_KEY（百炼/通义），也没有绑定 Workers AI。' +
      '配 key：npm run llm:secrets 后 npm run deploy:api-only；或 Dashboard → Settings → Functions → Bindings 添加 Workers AI（变量名 AI）。';
    return jsonResponse(request, result);
  }

  /*
   * AI 探测结果缓存 5 分钟。
   *
   * 原因（2026-09-18 性能实测）：/api/health 每 5 次里有 1 次接近 30 秒（最大 29557ms），
   * 因为它每次都同步调 AI 模型 —— 谁在页面加载时调用它，谁就会被拖住。
   * 缓存后：中位从 ~2s 降到几十毫秒，同时"AI 到底能不能用"仍然是**真实探测结果**（最多旧 5 分钟）。
   * 手动加 ?fresh=1 可强制重新探测（排查时用）。
   */
  const kv = env.QTVQ_KV;
  const wantFresh = new URL(request.url).searchParams.has('fresh');
  if (kv && !wantFresh) {
    try {
      const cached = JSON.parse((await kv.get('health:aiprobe')) || 'null');
      if (cached && Date.now() - cached.at < 5 * 60 * 1000) {
        result.aiProbe = cached.probe;
        result.aiErrors = cached.errors || [];
        result.aiError = cached.probe?.ok ? null : cached.errors?.[0]?.error || null;
        result.hint = cached.hint || null;
        result.aiProbeCachedAt = new Date(cached.at).toISOString();
        return jsonResponse(request, result);
      }
    } catch {
      /* 缓存不可用则照常实时探测 */
    }
  }

  // 用与聊天**完全相同**的链做一次真实探测（只问一个字，成本可忽略）
  const probe = await runChatChain(env, {
    messages: [{ role: 'user', content: '回复一个字：好' }],
    maxTokens: 64,
    temperature: 0.2,
  });

  if (probe.text) {
    result.aiProbe = {
      ok: true,
      provider: probe.provider,
      model: probe.model,
      attempts: probe.attempts,
      sample: probe.text.slice(0, 40),
    };
    result.aiErrors = probe.errors || [];
    if (kv) {
      try {
        await kv.put(
          'health:aiprobe',
          JSON.stringify({ at: Date.now(), probe: result.aiProbe, errors: [], hint: null }),
          { expirationTtl: 3600 },
        );
      } catch {
        /* 缓存写失败不影响结果 */
      }
    }
    return jsonResponse(request, result);
  }

  result.aiProbe = { ok: false, tried: probe.attempts };
  // 逐条列出失败原因，而不是只留最后一条（"只留最后一条"曾经把排查带偏两次）
  result.aiErrors = probe.errors || [];
  result.aiError = result.aiErrors[0]?.error || null;
  result.hint =
    '整条模型链都失败了。逐条看 aiErrors：`Free quota exhausted` = 百炼免费额度用尽（控制台关闭"仅免费额度"或充值）；' +
    '`InvalidApiKey` = key 不对；`ModelNotFound` = 模型名不存在；Workers AI 的报错另见 aiErrors。改完需重新 deploy。';
  if (kv) {
    try {
      await kv.put(
        'health:aiprobe',
        JSON.stringify({ at: Date.now(), probe: result.aiProbe, errors: result.aiErrors, hint: result.hint }),
        { expirationTtl: 3600 },
      );
    } catch {
      /* 缓存写失败不影响结果 */
    }
  }
  return jsonResponse(request, result);
}
