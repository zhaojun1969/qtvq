/**
 * 微信支付 V3（Native / JSAPI / 回调）
 * 见 docs/PAYMENT-WECHAT-API.md
 */

import {
  randomNonce,
  rsaSignBase64,
  rsaVerifyBase64,
  decryptWechatResource,
} from './wechat-crypto.js';

const WECHAT_NATIVE_URL = 'https://api.mch.weixin.qq.com/v3/pay/transactions/native';
const WECHAT_JSAPI_URL = 'https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi';

function normalizeMchSerial(serial) {
  return String(serial || '')
    .trim()
    .replace(/^serial=/i, '')
    .replace(/:/g, '')
    .toUpperCase();
}

export function getWechatPayConfig(env) {
  return {
    appId: env.WECHAT_APP_ID || '',
    mchId: env.WECHAT_MCH_ID || '',
    apiV3Key: env.WECHAT_API_V3_KEY || '',
    mchSerial: normalizeMchSerial(env.WECHAT_MCH_SERIAL),
    privateKey: env.WECHAT_MCH_PRIVATE_KEY || '',
    notifyUrl: env.WECHAT_PAY_NOTIFY_URL || '',
    platformPublicKey: env.WECHAT_PLATFORM_PUBLIC_KEY || '',
  };
}

export function isWechatPayConfigured(env) {
  const c = getWechatPayConfig(env);
  return !!(c.appId && c.mchId && c.apiV3Key && c.privateKey && c.mchSerial && c.notifyUrl);
}

function resolveNotifyUrl(env, request) {
  const configured = getWechatPayConfig(env).notifyUrl;
  if (configured) return configured;
  const url = new URL(request.url);
  return `${url.origin}/api/payment/wechat/notify`;
}

function buildAuthorizationHeader({ mchId, mchSerial, timestamp, nonce, signature }) {
  return `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${mchSerial}"`;
}

export async function buildWechatAuthorization(env, method, fullUrl, body) {
  const c = getWechatPayConfig(env);
  const url = new URL(fullUrl);
  const canonicalUrl = `${url.pathname}${url.search}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomNonce(16);
  const bodyStr = body ? JSON.stringify(body) : '';
  const message = `${method}\n${canonicalUrl}\n${timestamp}\n${nonce}\n${bodyStr}\n`;
  const signature = await rsaSignBase64(c.privateKey, message);
  return buildAuthorizationHeader({
    mchId: c.mchId,
    mchSerial: c.mchSerial,
    timestamp,
    nonce,
    signature,
  });
}

export async function buildJsapiPayParams(env, prepayId) {
  const c = getWechatPayConfig(env);
  const timeStamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = randomNonce(16);
  const packageStr = `prepay_id=${prepayId}`;
  const message = `${c.appId}\n${timeStamp}\n${nonceStr}\n${packageStr}\n`;
  const paySign = await rsaSignBase64(c.privateKey, message);
  return {
    appId: c.appId,
    timeStamp,
    nonceStr,
    package: packageStr,
    signType: 'RSA',
    paySign,
  };
}

async function wechatPayRequest(env, method, fullUrl, body) {
  const c = getWechatPayConfig(env);
  const authorization = await buildWechatAuthorization(env, method, fullUrl, body);
  const res = await fetch(fullUrl, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: authorization,
      'Wechatpay-Serial': c.mchSerial,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.detail ? JSON.stringify(data.detail) : '';
    throw new Error(data.message || data.code || detail || `微信 API 失败 (${res.status})`);
  }
  return data;
}

export async function createWechatNativeOrder(env, request, { orderId, description, amountFen }) {
  if (!isWechatPayConfigured(env)) {
    return {
      stub: true,
      codeUrl: null,
      prepayId: null,
      message: '微信商户号未配置，已创建本地订单 stub',
    };
  }

  const c = getWechatPayConfig(env);
  const body = {
    appid: c.appId,
    mchid: c.mchId,
    description: description.slice(0, 127),
    out_trade_no: orderId,
    notify_url: resolveNotifyUrl(env, request),
    amount: { total: amountFen, currency: 'CNY' },
  };

  const data = await wechatPayRequest(env, 'POST', WECHAT_NATIVE_URL, body);
  return {
    stub: false,
    codeUrl: data.code_url || null,
    prepayId: null,
  };
}

export async function createWechatJsapiOrder(env, request, { orderId, description, amountFen, openid }) {
  if (!openid) throw new Error('JSAPI 支付需要 openid');
  if (!isWechatPayConfigured(env)) {
    return {
      stub: true,
      jsapi: null,
      prepayId: null,
      message: '微信商户号未配置，已创建本地订单 stub',
    };
  }

  const c = getWechatPayConfig(env);
  const body = {
    appid: c.appId,
    mchid: c.mchId,
    description: description.slice(0, 127),
    out_trade_no: orderId,
    notify_url: resolveNotifyUrl(env, request),
    amount: { total: amountFen, currency: 'CNY' },
    payer: { openid },
  };

  const data = await wechatPayRequest(env, 'POST', WECHAT_JSAPI_URL, body);
  const jsapi = await buildJsapiPayParams(env, data.prepay_id);
  return {
    stub: false,
    prepayId: data.prepay_id || null,
    jsapi,
  };
}

/**
 * 解析并验签微信支付结果通知（V3 JSON）
 */
export async function verifyWechatNotify(env, request) {
  const rawBody = await request.text();

  if (!isWechatPayConfigured(env)) {
    return { ok: false, error: '微信商户号未配置' };
  }

  const c = getWechatPayConfig(env);
  const timestamp = request.headers.get('Wechatpay-Timestamp') || '';
  const nonce = request.headers.get('Wechatpay-Nonce') || '';
  const signature = request.headers.get('Wechatpay-Signature') || '';

  if (c.platformPublicKey && signature && /BEGIN (PUBLIC KEY|CERTIFICATE)/.test(c.platformPublicKey)) {
    const signMessage = `${timestamp}\n${nonce}\n${rawBody}\n`;
    const valid = await rsaVerifyBase64(c.platformPublicKey, signMessage, signature);
    if (!valid) return { ok: false, error: '平台验签失败' };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { ok: false, error: '无效通知 JSON' };
  }

  const resource = payload.resource;
  if (!resource?.ciphertext) {
    return { ok: false, error: '缺少加密 resource' };
  }

  let decrypted;
  try {
    decrypted = await decryptWechatResource(c.apiV3Key, {
      associatedData: resource.associated_data || '',
      nonce: resource.nonce,
      ciphertext: resource.ciphertext,
    });
  } catch {
    return { ok: false, error: 'resource 解密失败' };
  }

  let tx;
  try {
    tx = JSON.parse(decrypted);
  } catch {
    return { ok: false, error: '解密后 JSON 无效' };
  }

  return {
    ok: true,
    outTradeNo: tx.out_trade_no,
    transactionId: tx.transaction_id,
    tradeState: tx.trade_state,
    eventType: payload.event_type,
  };
}

export function wechatNotifySuccessResponse() {
  return new Response(JSON.stringify({ code: 'SUCCESS', message: '成功' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function wechatNotifyFailResponse(message = '失败') {
  return new Response(JSON.stringify({ code: 'FAIL', message }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
