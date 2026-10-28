/**
 * 微信支付 V3（**server 侧**，2026-10-27）
 *
 * 从 `functions/lib/wechat-pay.js` 移植。这是《再改造技术实施书》P0-T0.1 的核心：
 * 报告/转盘的新支付必须落在 server 栈上（D2 绞杀者原则），而 server 此前**完全没有**
 * 微信支付能力 —— 一切支付都在 Cloudflare Functions 侧。
 *
 * ── 契约与 Workers 版一致（不要改）────────────────────────────────────────
 *   · 签名串：`method\nurl\ntimestamp\nnonce\nbody\n`
 *   · 请求头：`WECHATPAY2-SHA256-RSA2048 mchid="…",nonce_str="…",signature="…",timestamp="…",serial_no="…"`
 *   · 查询：`GET /v3/pay/transactions/out-trade-no/{out_trade_no}?mchid=…`
 *   · 回调验签：`timestamp\nnonce\nrawBody\n`，再 AES-256-GCM 解密 `resource`
 *
 * ── 一个真实事故（照抄自 Workers 版注释，务必保留）──────────────────────
 * 本商户号（1113936939）用的是**「微信支付公钥」模式**，微信不再下发平台证书
 * （`/v3/certificates` 返回 RESOURCE_NOT_EXISTS）。所以验签**必须**用
 * `WECHAT_PLATFORM_PUBLIC_KEY`；旧实现写成"公钥没配就跳过验签"，
 * 那等于任何人构造一个回调就能给自己开通会员 —— 功能缺陷 + 安全漏洞。
 * 这里保持「没配公钥 → 直接拒绝」，绝不静默跳过。
 */

import {
  decryptWechatResource,
  normalizePrivateKeyPem,
  randomNonce,
  rsaSignBase64,
  rsaVerifyBase64,
} from '../lib/wechat-crypto.js';

const API = 'https://api.mch.weixin.qq.com';
const URL_NATIVE = `${API}/v3/pay/transactions/native`;
const URL_JSAPI = `${API}/v3/pay/transactions/jsapi`;
const URL_APP = `${API}/v3/pay/transactions/app`;
const URL_QUERY = `${API}/v3/pay/transactions/out-trade-no`;

/** 只支持 64 位以内的纯字母数字/下划线/斜杠；微信对 serial 有格式要求 */
function normalizeMchSerial(serial) {
  return String(serial || '')
    .trim()
    .replace(/\s+/g, '')
    .toUpperCase();
}

export function getWechatPayConfig() {
  return {
    appId: String(process.env.WECHAT_APP_ID || '').trim(),
    mchId: String(process.env.WECHAT_MCH_ID || '').trim(),
    apiV3Key: String(process.env.WECHAT_API_V3_KEY || '').trim(),
    mchSerial: normalizeMchSerial(process.env.WECHAT_MCH_SERIAL),
    privateKey: normalizePrivateKeyPem(process.env.WECHAT_MCH_PRIVATE_KEY || ''),
    notifyUrl: String(process.env.WECHAT_PAY_NOTIFY_URL || '').trim(),
    platformPublicKey: String(process.env.WECHAT_PLATFORM_PUBLIC_KEY || '').trim(),
    appPayId: String(process.env.WECHAT_APP_PAY_ID || '').trim(),
  };
}

export function isWechatPayConfigured() {
  const c = getWechatPayConfig();
  return Boolean(c.appId && c.mchId && c.apiV3Key && c.mchSerial && c.privateKey);
}

/** 请求签名 Authorization 头 */
export function buildAuthorization(method, fullUrl, body) {
  const c = getWechatPayConfig();
  const url = new URL(fullUrl);
  const canonicalUrl = `${url.pathname}${url.search}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomNonce(16);
  const bodyStr = body ? JSON.stringify(body) : '';
  const message = `${method}\n${canonicalUrl}\n${timestamp}\n${nonce}\n${bodyStr}\n`;
  const signature = rsaSignBase64(c.privateKey, message);
  return (
    `WECHATPAY2-SHA256-RSA2048 mchid="${c.mchId}",nonce_str="${nonce}",` +
    `signature="${signature}",timestamp="${timestamp}",serial_no="${c.mchSerial}"`
  );
}

async function request(method, fullUrl, body) {
  const c = getWechatPayConfig();
  const res = await fetch(fullUrl, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Accept-Language': 'zh-CN',
      'User-Agent': 'qtvq-server/1.0',
      Authorization: buildAuthorization(method, fullUrl, body),
      'Wechatpay-Serial': c.mchSerial,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.detail ? JSON.stringify(data.detail) : '';
    const err = new Error(data.message || data.code || detail || `微信 API 失败 (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function resolveNotifyUrl(override) {
  const c = getWechatPayConfig();
  return String(override || c.notifyUrl || '').trim();
}

/** 统一下单的公共 body */
function orderBody({ orderId, description, amountFen, notifyUrl, extra = {} }) {
  const c = getWechatPayConfig();
  const url = resolveNotifyUrl(notifyUrl);
  if (!url) throw new Error('缺少回调地址（WECHAT_PAY_NOTIFY_URL）');
  return {
    appid: c.appId,
    mchid: c.mchId,
    description: String(description || 'Q问').slice(0, 127),
    out_trade_no: String(orderId),
    notify_url: url,
    amount: { total: Math.round(amountFen), currency: 'CNY' },
    ...extra,
  };
}

/** Native（扫码支付）：返回 code_url */
export async function createNativeOrder({ orderId, description, amountFen, notifyUrl }) {
  if (!isWechatPayConfigured()) {
    return { stub: true, codeUrl: null, prepayId: null, message: '微信商户号未配置，已创建本地订单 stub' };
  }
  const data = await request('POST', URL_NATIVE, orderBody({ orderId, description, amountFen, notifyUrl }));
  return { stub: false, codeUrl: data.code_url || null, prepayId: null };
}

/** JSAPI（小程序内支付）：返回 prepay_id + 可直接调 uni.requestPayment 的参数 */
export async function createJsapiOrder({ orderId, description, amountFen, notifyUrl, openid }) {
  if (!isWechatPayConfigured()) {
    return { stub: true, prepayId: null, payParams: null, message: '微信商户号未配置，已创建本地订单 stub' };
  }
  if (!openid) throw new Error('缺少 openid（JSAPI 下单必需）');
  const data = await request(
    'POST',
    URL_JSAPI,
    orderBody({ orderId, description, amountFen, notifyUrl, extra: { payer: { openid: String(openid) } } }),
  );
  return { stub: false, prepayId: data.prepay_id || null, payParams: buildJsapiPayParams(data.prepay_id) };
}

/** APP 内支付：appid 必须是开放平台的移动应用 appid（WECHAT_APP_PAY_ID） */
export async function createAppOrder({ orderId, description, amountFen, notifyUrl }) {
  const c = getWechatPayConfig();
  if (!c.appPayId) {
    throw new Error('App 支付需要「微信开放平台 → 移动应用」的 appid：请配置 WECHAT_APP_PAY_ID');
  }
  if (!isWechatPayConfigured()) {
    return { stub: true, orderInfo: null, message: '微信商户号未配置，已创建本地订单 stub' };
  }
  const data = await request(
    'POST',
    URL_APP,
    orderBody({ orderId, description, amountFen, notifyUrl, extra: { appid: c.appPayId } }),
  );
  return { stub: false, prepayId: data.prepay_id || null };
}

/** JSAPI 支付参数签名（4 行签名串） */
export function buildJsapiPayParams(prepayId) {
  const c = getWechatPayConfig();
  const timeStamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = randomNonce(16);
  const packageStr = `prepay_id=${prepayId}`;
  const message = `${c.appId}\n${timeStamp}\n${nonceStr}\n${packageStr}\n`;
  return {
    appId: c.appId,
    timeStamp,
    nonceStr,
    package: packageStr,
    signType: 'RSA',
    paySign: rsaSignBase64(c.privateKey, message),
  };
}

/**
 * 查询订单。注意语义：`NOTPAY`/`CLOSED` 等也算 `ok: true`（查询本身成功），
 * 只有查询失败才 `ok: false`。
 */
export async function queryOrder(outTradeNo) {
  if (!outTradeNo) return { ok: false, error: '缺少订单号' };
  if (!isWechatPayConfigured()) return { ok: false, error: '微信商户号未配置' };
  const c = getWechatPayConfig();
  const url = `${URL_QUERY}/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(c.mchId)}`;
  try {
    const data = await request('GET', url, null);
    return {
      ok: true,
      tradeState: data.trade_state || '',
      tradeStateDesc: data.trade_state_desc || '',
      transactionId: data.transaction_id || '',
      amountTotal: data.amount?.total,
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * 校验并解析回调。
 * @param {object} headers 小写键名的头对象（Express 的 req.headers 就是）
 * @param {string} rawBody 原始请求体字符串（**必须**是原文，不能是重新序列化的 JSON）
 */
export function verifyNotify(headers, rawBody) {
  const c = getWechatPayConfig();
  if (!isWechatPayConfigured()) return { ok: false, error: '微信商户号未配置' };

  const timestamp = headers['wechatpay-timestamp'] || '';
  const nonce = headers['wechatpay-nonce'] || '';
  const signature = headers['wechatpay-signature'] || '';
  const serial = headers['wechatpay-serial'] || '';

  if (!signature || !timestamp || !nonce) return { ok: false, error: '缺少微信回调签名头' };
  if (!/BEGIN (PUBLIC KEY|CERTIFICATE)/.test(c.platformPublicKey || '')) {
    return {
      ok: false,
      error:
        '未配置微信支付公钥（WECHAT_PLATFORM_PUBLIC_KEY）；本商户号为「微信支付公钥」模式，' +
        '请到商户平台 → 账户中心 → API 安全 → 申请公钥，下载后填入该变量',
    };
  }
  if (!rsaVerifyBase64(c.platformPublicKey, `${timestamp}\n${nonce}\n${rawBody}\n`, signature)) {
    return { ok: false, error: `验签失败（公钥与商户平台不一致？回调 serial=${serial}）` };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { ok: false, error: '无效通知 JSON' };
  }
  const resource = payload.resource;
  if (!resource?.ciphertext) return { ok: false, error: '缺少加密 resource' };

  let tx;
  try {
    const plain = decryptWechatResource(c.apiV3Key, {
      associatedData: resource.associated_data || '',
      nonce: resource.nonce,
      ciphertext: resource.ciphertext,
    });
    tx = JSON.parse(plain);
  } catch (err) {
    return { ok: false, error: `resource 解密失败：${err?.message || err}` };
  }

  return {
    ok: true,
    outTradeNo: tx.out_trade_no,
    transactionId: tx.transaction_id,
    tradeState: tx.trade_state,
    amountTotal: tx.amount?.total,
    eventType: payload.event_type,
    // 明文原始串留给审计：出问题要能回答"微信到底说了什么"
    raw: tx,
  };
}

/** 微信要求回调一律 200 + JSON，否则会重试 8 次 */
export function notifySuccess() {
  return { code: 'SUCCESS', message: '成功' };
}

export function notifyFail(message = '失败') {
  return { code: 'FAIL', message };
}
