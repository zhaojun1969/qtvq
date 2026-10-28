/**
 * 阿里云短信（Dysmsapi 2017-05-25）—— 只用于发送验证码。
 *
 * 与 tools/scripts/check-aliyun-sms.mjs 保持一致的签名细节（那两个坑都踩过了）：
 *   1) 必须用 **POST** 提交，用 GET 会得到 "This http method is not supported."
 *   2) string-to-sign 的前缀必须与提交方法一致：`POST&%2F&`（文档示例常写 GET&%2F&，照抄会签名不匹配）
 *
 * 环境变量：ALIYUN_SMS_ACCESS_KEY_ID / ALIYUN_SMS_ACCESS_KEY_SECRET / SMS_SIGN_NAME / SMS_TEMPLATE_CODE
 */

const ENDPOINT = 'https://dysmsapi.aliyuncs.com/';
const VERSION = '2017-05-25';

function getSmsConfig(env) {
  return {
    accessKeyId: env.ALIYUN_SMS_ACCESS_KEY_ID || '',
    accessKeySecret: env.ALIYUN_SMS_ACCESS_KEY_SECRET || '',
    signName: env.SMS_SIGN_NAME || '',
    templateCode: env.SMS_TEMPLATE_CODE || '',
  };
}

export function isSmsConfigured(env) {
  const c = getSmsConfig(env);
  return !!(c.accessKeyId && c.accessKeySecret && c.signName && c.templateCode);
}

/** 阿里云要求的百分号编码：RFC3986，且空格→%20、*→%2A、~ 不编码 */
function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

async function hmacSha1Base64(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  const bytes = new Uint8Array(sig);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * 发送验证码短信。
 * @returns {Promise<{ok: boolean, code?: string, message?: string, error?: string}>}
 */
export async function sendVerifyCodeSms(env, { phone, code }) {
  const c = getSmsConfig(env);
  if (!isSmsConfigured(env)) {
    return { ok: false, error: '短信服务未配置（ALIYUN_SMS_* / SMS_SIGN_NAME / SMS_TEMPLATE_CODE）' };
  }

  const params = {
    Format: 'JSON',
    Version: VERSION,
    AccessKeyId: c.accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    RegionId: 'cn-hangzhou',
    Action: 'SendSms',
    PhoneNumbers: String(phone),
    SignName: c.signName,
    TemplateCode: c.templateCode,
    TemplateParam: JSON.stringify({ code: String(code) }),
  };

  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(String(params[k]))}`)
    .join('&');
  const stringToSign = `POST&%2F&${percentEncode(canonical)}`;
  const signature = await hmacSha1Base64(`${c.accessKeySecret}&`, stringToSign);

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: `${canonical}&Signature=${percentEncode(signature)}`,
  });

  const data = await res.json().catch(() => ({}));
  const aliCode = data.Code || '';
  if (aliCode === 'OK') return { ok: true, code: aliCode, message: data.Message || 'OK' };

  // 常见的可诊断错误，直接给出人能看懂的原因（避免只抛一个 Code 让人猜）
  const hints = {
    'isv.SMS_SIGNATURE_ILLEGAL': '短信签名不合法/未过审（阿里云「国内消息 → 签名管理」核对 SMS_SIGN_NAME 是否完全一致）',
    'isv.SMS_TEMPLATE_ILLEGAL': '模板不存在或未过审（核对 SMS_TEMPLATE_CODE）',
    'isv.MOBILE_NUMBER_ILLEGAL': '手机号格式不合法',
    'isv.AMOUNT_NOT_ENOUGH': '阿里云账户短信余额不足',
    'isv.BUSINESS_LIMIT_CONTROL': '触发阿里云流控（同一号码发送过于频繁）',
    'SignatureDoesNotMatch': '签名不匹配（AK/Secret 不是一对，或 string-to-sign 前缀不对）',
    'InvalidAccessKeyId.NotFound': 'AccessKeyId 无效',
  };
  return {
    ok: false,
    code: aliCode,
    message: data.Message || '',
    error: `${aliCode || res.status} ${data.Message || ''}${hints[aliCode] ? ` —— ${hints[aliCode]}` : ''}`.trim(),
  };
}
