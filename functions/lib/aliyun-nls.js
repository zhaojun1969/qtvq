/**
 * 阿里云智能语音 NLS：Token + 一句话识别
 * 环境变量：NLS_APP_KEY，以及 OSS_ACCESS_KEY_ID / OSS_SECRET_ACCESS_KEY（或 ALIYUN_ACCESS_KEY_*）
 */

const NLS_META = 'nls-meta.cn-shanghai.aliyuncs.com';
const NLS_GATEWAY = 'nls-gateway-cn-shanghai.aliyuncs.com';
const TOKEN_CACHE_KEY = 'nls:token:cache';

function nlsConfig(env) {
  const appKey = String(env.NLS_APP_KEY || env.ALIYUN_NLS_APPKEY || '').trim();
  // 凭据优先级（2026-09-17 修）：
  //   1) NLS_ACCESS_KEY_ID / NLS_ACCESS_KEY_SECRET —— 给 NLS 用的专用 RAM 子账号（推荐）
  //   2) ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET
  //   3) OSS_ACCESS_KEY_ID / OSS_SECRET_ACCESS_KEY —— 兜底复用
  // 原来 OSS 排在最前，结果是"OSS 凭据赢"，而 OSS 那个 RAM 用户**没有 NLS 权限**，
  // CreateToken 直接返回 ErrCode 40020503 No permission! —— 语音因此从未成功过，
  // 而线上只回一句 "No permission!"，完全指不出问题在哪。
  const pairs = [
    ['NLS_ACCESS_KEY_ID', 'NLS_ACCESS_KEY_SECRET'],
    ['ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET'],
    ['OSS_ACCESS_KEY_ID', 'OSS_SECRET_ACCESS_KEY'],
  ];
  for (const [idKey, skKey] of pairs) {
    const ak = String(env[idKey] || '').trim();
    const sk = String(env[skKey] || '').trim();
    if (appKey && ak && sk) return { appKey, ak, sk, source: idKey };
  }
  return null;
}

/** 把阿里云的错误码翻译成人能直接执行的一句话（原始信息保留在 raw 里） */
function nlsErrorHint(code, message) {
  const map = {
    40020503:
      '语音识别所用的阿里云 AccessKey 没有「智能语音交互(NLS)」权限，或该账号未开通智能语音交互服务。'
      + '请在 RAM 控制台给这个 AccessKey 所属用户授予 NLS 权限（或改用专用的 NLS 子账号 AK），'
      + '并确认控制台已开通智能语音交互。',
    40020502: '该 AccessKey 被禁用。',
    'InvalidAccessKeyId.NotFound': 'AccessKey 不存在（可能已删除或复制错）。',
    SignatureDoesNotMatch: 'AccessKeySecret 与 AccessKeyId 不匹配。',
  };
  return map[code] || message || '';
}

export function isNlsConfigured(env) {
  return !!nlsConfig(env);
}

function percentEncode(str) {
  return encodeURIComponent(String(str))
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

async function hmacSha1Base64(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  const bytes = new Uint8Array(sig);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function aliyunRpc(env, host, action, version, extra = {}) {
  const cfg = nlsConfig(env);
  if (!cfg) throw new Error('NLS 未配置');

  const params = {
    Action: action,
    Version: version,
    Format: 'JSON',
    AccessKeyId: cfg.ak,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...extra,
  };

  const canonicalized = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&');
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonicalized)}`;
  const signature = await hmacSha1Base64(`${cfg.sk}&`, stringToSign);
  const url = `https://${host}/?${canonicalized}&Signature=${percentEncode(signature)}`;

  const res = await fetch(url, { method: 'GET' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.Code || data.ErrCode) {
    const code = data.Code || data.ErrCode || `HTTP_${res.status}`;
    const hint = nlsErrorHint(code, data.Message || data.ErrMsg);
    // 原始错误码必须带出去：只回 "No permission!" 时，业务方在页面上看到的是一句无用的英文，
    // 而真正可执行的信息是 40020503 = 缺 NLS 权限。（这个坑本项目实际吃了一个多月。）
    const err = new Error(hint || `NLS ${action} 失败`);
    err.nlsCode = code;
    err.raw = data.Message || data.ErrMsg || '';
    throw err;
  }
  return data;
}

async function fetchTokenFromAliyun(env) {
  const data = await aliyunRpc(env, NLS_META, 'CreateToken', '2019-02-28');
  const token = data.Token?.Id || data.Token?.token || data.Id;
  const expireTime = Number(data.Token?.ExpireTime || data.ExpireTime || 0);
  if (!token) throw new Error('CreateToken 未返回 Token');
  return { token, expireTime };
}

async function getNlsToken(env) {
  const kv = env?.QTVQ_KV;
  if (kv) {
    try {
      const cached = JSON.parse((await kv.get(TOKEN_CACHE_KEY)) || 'null');
      if (cached?.token && cached.expireTime > Date.now() / 1000 + 120) {
        return cached.token;
      }
    } catch {
      /* refresh */
    }
  }

  const fresh = await fetchTokenFromAliyun(env);
  if (kv) {
    await kv.put(
      TOKEN_CACHE_KEY,
      JSON.stringify(fresh),
      { expirationTtl: 60 * 60 * 12 }
    );
  }
  return fresh.token;
}

/**
 * 真实就绪探测：能不能真的换到 NLS token（token 本身在 KV 里缓存 12 小时，所以代价很低）。
 *
 * 存在的理由：`isNlsConfigured()` 只检查"环境变量非空"，而本项目实际出现过
 * "变量齐全但 AccessKey 没有 NLS 权限"的情况 —— 于是健康检查说 configured:true、
 * 前端按钮亮着，用户点下去才失败。**配置存在 ≠ 服务可用**，必须能区分。
 */
export async function probeNls(env) {
  if (!isNlsConfigured(env)) {
    return { ready: false, reason: '语音识别未配置（缺少 NLS_APP_KEY 或 AccessKey）', nlsCode: 'SPEECH_NOT_CONFIGURED' };
  }
  try {
    await getNlsToken(env);
    return { ready: true, reason: null, nlsCode: null };
  } catch (err) {
    return { ready: false, reason: err.message, nlsCode: err.nlsCode || 'TOKEN_FAILED' };
  }
}

/**
 * @param {Record<string,string>} env
 * @param {ArrayBuffer|Uint8Array} audioBytes
 * @param {{ format?: string, sampleRate?: number }} opts
 */
export async function recognizeOneSentence(env, audioBytes, opts = {}) {
  const cfg = nlsConfig(env);
  if (!cfg) return { ok: false, error: 'speech_not_configured' };

  const format = opts.format || 'wav';
  const sampleRate = opts.sampleRate || 16000;
  const token = await getNlsToken(env);

  const url = new URL(`https://${NLS_GATEWAY}/stream/v1/asr`);
  url.searchParams.set('appkey', cfg.appKey);
  url.searchParams.set('format', format);
  url.searchParams.set('sample_rate', String(sampleRate));
  url.searchParams.set('enable_punctuation', 'true');
  url.searchParams.set('enable_inverse_text_normalization', 'true');

  const body = audioBytes instanceof Uint8Array ? audioBytes : new Uint8Array(audioBytes);
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'X-NLS-Token': token,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.byteLength),
    },
    body,
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`ASR 响应异常: ${text.slice(0, 120)}`);
  }

  if (data.status && data.status !== 20000000) {
    throw new Error(data.message || `ASR status ${data.status}`);
  }

  const result = String(data.result || '').trim();
  if (!result) {
    return { ok: false, error: 'no_speech', message: '未识别到有效语音' };
  }

  return { ok: true, text: result };
}
