/**
 * 阿里云智能语音 NLS：Token + 一句话识别
 * 环境变量：NLS_APP_KEY，以及 OSS_ACCESS_KEY_ID / OSS_SECRET_ACCESS_KEY（或 ALIYUN_ACCESS_KEY_*）
 */

const NLS_META = 'nls-meta.cn-shanghai.aliyuncs.com';
const NLS_GATEWAY = 'nls-gateway-cn-shanghai.aliyuncs.com';
const TOKEN_CACHE_KEY = 'nls:token:cache';

function nlsConfig(env) {
  const appKey = String(env.NLS_APP_KEY || env.ALIYUN_NLS_APPKEY || '').trim();
  const ak = String(env.OSS_ACCESS_KEY_ID || env.ALIYUN_ACCESS_KEY_ID || '').trim();
  const sk = String(env.OSS_SECRET_ACCESS_KEY || env.ALIYUN_ACCESS_KEY_SECRET || '').trim();
  if (!appKey || !ak || !sk) return null;
  return { appKey, ak, sk };
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
    throw new Error(data.Message || data.ErrMsg || data.msg || `NLS RPC ${action} failed`);
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
