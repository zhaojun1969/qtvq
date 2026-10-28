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
const WECHAT_APP_URL = 'https://api.mch.weixin.qq.com/v3/pay/transactions/app';
const WECHAT_QUERY_URL = 'https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no';

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

/**
 * App 内支付（鸿蒙 / Android / iOS）：微信 V3 `trade_type=APP`。
 *
 * 与 JSAPI/Native 的三点关键差别（写清楚，免得照抄出错）：
 *   1. **appid 必须是「微信开放平台 → 移动应用」的 appid**，不是小程序的 appid。
 *      用错会在微信侧报 appid 与商户号不匹配 —— 所以这里要求单独配 `WECHAT_APP_PAY_ID`，
 *      没配就返回 stub 并把原因写明白（宁可明确不可用，也不要抛一个看不懂的微信错误）。
 *   2. 下单接口是 `/v3/pay/transactions/app`，返回 `prepay_id`（不是 code_url）。
 *   3. 客户端要的是 **orderInfo 字符串**：把 appid/partnerid/prepayid/package/noncestr/timestamp
 *      拼成 JSON 并**用商户私钥再签一次**（签名串是 6 行，与 JSAPI 的 4 行不同）。
 *      拿到后由客户端调 `uni.requestPayment({ provider:'wxpay', orderInfo })`。
 */
export function getWechatAppPayId(env) {
  // 只认开放平台移动应用的 appid；**刻意不回退**到小程序 appid（回退会得到一个看不懂的微信报错）
  return String(env.WECHAT_APP_PAY_ID || '').trim();
}

export async function createWechatAppOrder(env, request, { orderId, description, amountFen }) {
  const appId = getWechatAppPayId(env);
  if (!isWechatPayConfigured(env)) {
    return { stub: true, orderInfo: null, prepayId: null, message: '微信商户号未配置，已创建本地订单 stub' };
  }
  if (!appId) {
    return {
      stub: true,
      orderInfo: null,
      prepayId: null,
      message:
        'App 内支付需要「微信开放平台 → 移动应用」的 appid：请在 .dev.vars 配置 WECHAT_APP_PAY_ID 后再试；' +
        '在此之前 App 端可继续用扫码/网页支付。',
    };
  }

  const c = getWechatPayConfig(env);
  const body = {
    appid: appId,
    mchid: c.mchId,
    description: description.slice(0, 127),
    out_trade_no: orderId,
    notify_url: resolveNotifyUrl(env, request),
    amount: { total: amountFen, currency: 'CNY' },
  };

  const data = await wechatPayRequest(env, 'POST', WECHAT_APP_URL, body);
  const prepayId = data.prepay_id || null;
  if (!prepayId) throw new Error('微信未返回 prepay_id');
  return { stub: false, orderInfo: await buildAppPayOrderInfo(env, prepayId, appId), prepayId };
}

/** 组装客户端需要的 orderInfo（App 支付的签名串是 6 行，行尾都有 \n） */
async function buildAppPayOrderInfo(env, prepayId, appId) {
  const c = getWechatPayConfig(env);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = randomNonce(16);
  const packageStr = 'Sign=WXPay';
  const message = `${appId}\n${c.mchId}\n${prepayId}\n${packageStr}\n${nonceStr}\n${timestamp}\n`;
  const sign = await rsaSignBase64(c.privateKey, message);
  return JSON.stringify({
    appid: appId,
    partnerid: c.mchId,
    prepayid: prepayId,
    package: packageStr,
    noncestr: nonceStr,
    timestamp,
    sign,
  });
}


async function wechatPayRequest(env, method, fullUrl, body) {  const c = getWechatPayConfig(env);
  const authorization = await buildWechatAuthorization(env, method, fullUrl, body);
  const res = await fetch(fullUrl, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'qtvq-api/1.0',
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
 * 主动查询订单在**微信侧**的真实交易状态。
 *
 * 为什么需要它：回调（notify）可能因为公钥没配好、验签失败、外网不可达、丢包而永远不到；
 * 一旦如此，客户钱已进账但会员不会开通 —— 这是本项目真实发生过的故障。
 * 因此前端轮询本地订单状态时，这里会直接问微信要权威状态，作为自愈兜底。
 *
 * 注意：返回 NOTPAY / CLOSED 等都算 ok:true（查询本身成功），只有查询失败才 ok:false。
 */
export async function queryWechatOrder(env, outTradeNo) {
  if (!outTradeNo) return { ok: false, error: '缺少订单号' };
  if (!isWechatPayConfigured(env)) return { ok: false, error: '微信商户号未配置' };

  const c = getWechatPayConfig(env);
  const url = `${WECHAT_QUERY_URL}/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(c.mchId)}`;
  const authorization = await buildWechatAuthorization(env, 'GET', url, null);

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'qtvq-api/1.0',
      'Accept-Language': 'zh-CN',
      Authorization: authorization,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      error: data.message || data.code || `微信查询失败(${res.status})`,
    };
  }
  return {
    ok: true,
    tradeState: data.trade_state || '',
    tradeStateDesc: data.trade_state_desc || '',
    transactionId: data.transaction_id || '',
    amountTotal: data.amount?.total,
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

  // 验签**必须**做，且必须与商户平台当前使用的公钥一致。
  //
  // 旧代码是 `if (platformPublicKey && signature && ...)`：公钥没配置时会**静默跳过验签**，
  // 等于任何人构造一个回调就把自己变成会员 —— 这既是功能缺陷也是安全漏洞（2026-09-16 修复）。
  //
  // 另外这是一个真实事故：本商户号（1113936939）已使用**「微信支付公钥」模式**，
  // 微信不再提供平台证书（/v3/certificates 返回 RESOURCE_NOT_EXISTS）。若这里继续用旧的
  // 平台证书公钥验签，则每次回调都失败 → 客户付款成功但会员不会自动开通。
  // 正确做法：商户平台 → 账户中心 → API 安全 → 申请公钥，把下载到的**微信支付公钥**
  // 填入 WECHAT_PLATFORM_PUBLIC_KEY（回调头 Wechatpay-Serial 会是 PUB_KEY_ID_xxx）。
  if (!signature || !timestamp || !nonce) {
    return { ok: false, error: '缺少微信回调签名头' };
  }
  if (!/BEGIN (PUBLIC KEY|CERTIFICATE)/.test(c.platformPublicKey || '')) {
    return {
      ok: false,
      error:
        '未配置微信支付公钥（WECHAT_PLATFORM_PUBLIC_KEY）；本商户号为「微信支付公钥」模式，'
        + '请到商户平台 → 账户中心 → API 安全 → 申请公钥，下载后填入该变量',
    };
  }
  {
    const signMessage = `${timestamp}\n${nonce}\n${rawBody}\n`;
    const valid = await rsaVerifyBase64(c.platformPublicKey, signMessage, signature);
    if (!valid) {
      const notifySerial = request.headers.get('Wechatpay-Serial') || '';
      return { ok: false, error: `验签失败（公钥与商户平台不一致？回调 serial=${notifySerial}）` };
    }
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
