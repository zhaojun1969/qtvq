/**
 * 阿里云内容安全（Green / 内容审核 2022-03-02）客户端
 *
 * ## 为什么必须接持牌服务，而不是只靠本地词表
 * 本地词表（`packages/safety/src/words.js`）**刻意不含涉政类词**，原因写在那个文件里：
 * 手工维护的政治敏感词表既不可能完整（漏词 = 漏审），又容易误伤（把正常表述判成违规），
 * 而且这类内容的合规判断本应由**持牌内容安全服务**来做。
 * 业务方 2026-10-11 明确要求：**阿里云 Green + 本地 OCR + 敏感词，双重/三重方案**。
 * 所以本文件的定位是"外部权威判定"，本地词表是**兜底与快速拦截**，两者都要过。
 *
 * ## 与本地词表的分工（重要）
 *   · 本地词表：命中最快、零成本、可离线；负责涉黄/涉赌/涉毒/诈骗/引流/辱骂/广告法。
 *   · Green：负责本地词表**覆盖不到**的（涉政、暴恐、违禁品、更深层的色情变体）+ 图片审核。
 *   · 两者是 **AND 关系**：任一说违规就拦（见 content-safety.js 的 checkText）。
 *   · **Green 不可用时不能假装通过**：调用失败时返回 `degraded: true`，
 *     由上层决定"放行但记录"还是"转人工"（当前策略见 checkText 的注释）。
 *
 * ## 配置（放 server/.env）
 *   GREEN_ACCESS_KEY_ID / GREEN_ACCESS_KEY_SECRET   —— 建议用只授权内容安全(绿网)的 RAM 子账号
 *   GREEN_REGION  默认 cn-shanghai
 *   GREEN_TEXT_SERVICE / GREEN_IMAGE_SERVICE  默认 comment_detection / baselineCheck
 *   未配置时 `isGreenConfigured()` 返回 false，`checkText` 会跳过外部检查并如实标注 provider。
 *
 * ## 排错
 * 阿里云 RPC 接口的错误码很有信息量，本文件**原样带出**（不吞掉）：
 *   · `InvalidApiKey`/`SignatureDoesNotMatch` → AK/Secret 不对或区域不对
 *   · `Forbidden`/`NoPermission` → 子账号没有内容安全权限
 *   · `ServiceNotOpened`/`NotActivated` → 内容安全服务未开通（需在控制台开通后才有配额）
 *   · `Throttling`/`QuotaExceeded` → 限流或配额用尽（充值/提额）
 * 诊断脚本：`npm run diag:green`（server 目录）会把这些原因直接打印出来。
 */
import crypto from 'node:crypto';

const API_HOST = 'green-cip.cn-shanghai.aliyuncs.com';
const API_VERSION = '2022-03-02';

function cfg() {
  const region = process.env.GREEN_REGION || 'cn-shanghai';
  return {
    keyId: process.env.GREEN_ACCESS_KEY_ID || process.env.ALIYUN_SMS_ACCESS_KEY_ID || '',
    keySecret: process.env.GREEN_ACCESS_KEY_SECRET || process.env.ALIYUN_SMS_ACCESS_KEY_SECRET || '',
    host: region === 'cn-shanghai' ? API_HOST : API_HOST,
    region,
    textService: process.env.GREEN_TEXT_SERVICE || 'comment_detection',
    imageService: process.env.GREEN_IMAGE_SERVICE || 'baselineCheck',
    timeoutMs: Number(process.env.GREEN_TIMEOUT_MS || 8000),
  };
}

export function isGreenConfigured() {
  const c = cfg();
  return !!(c.keyId && c.keySecret);
}

/** 给诊断脚本用：不泄漏密钥，只报"配没配、用的是哪个区域/服务" */
export function greenStatus() {
  const c = cfg();
  return {
    configured: isGreenConfigured(),
    region: c.region,
    textService: c.textService,
    imageService: c.imageService,
    keySource: process.env.GREEN_ACCESS_KEY_ID
      ? 'GREEN_ACCESS_KEY_ID'
      : process.env.ALIYUN_SMS_ACCESS_KEY_ID
        ? 'ALIYUN_SMS_ACCESS_KEY_ID（回落）'
        : 'none',
  };
}

/* ------------------------------ 阿里云 RPC 签名 ------------------------------ */

function percentEncode(str) {
  return encodeURIComponent(String(str))
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~')
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

/**
 * 调用阿里云 RPC 风格接口。
 *
 * ⚠️ 三个踩过的坑（与 `aliyun-sms.js` 一致）：
 *   1. string-to-sign 前缀必须与提交方法一致：**POST 用 `POST&%2F&`**，
 *      文档示例常写 `GET&%2F&`，照抄会 `SignatureDoesNotMatch`；
 *   2. 参数必须按**字典序**拼进 canonical query；
 *   3. 请求体用 `application/x-www-form-urlencoded`，参数放在 body 而不是 query。
 */
async function rpc(action, params) {
  const c = cfg();
  if (!isGreenConfigured()) throw new Error('GREEN_ACCESS_KEY_ID / GREEN_ACCESS_KEY_SECRET 未配置');

  const common = {
    Format: 'JSON',
    Version: API_VERSION,
    AccessKeyId: c.keyId,
    SignatureMethod: 'HMAC-SHA1',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Action: action,
    RegionId: c.region,
  };
  const all = { ...common, ...params };
  const canonical = Object.keys(all)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(all[k])}`)
    .join('&');
  const stringToSign = `POST&%2F&${percentEncode(canonical)}`;
  const signature = crypto.createHmac('sha1', `${c.keySecret}&`).update(stringToSign).digest('base64');

  const res = await fetch(`https://${c.host}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `${canonical}&Signature=${percentEncode(signature)}`,
    signal: AbortSignal.timeout(c.timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 保留原文用于报错 */
  }
  if (!res.ok || (json && json.Code && Number(json.Code) !== 200)) {
    const code = json?.Code || `HTTP_${res.status}`;
    const msg = json?.Message || text.slice(0, 200);
    const err = new Error(`阿里云内容安全 ${action} 失败：${code} ${msg}`);
    err.greenCode = code;
    throw err;
  }
  return json;
}

/* ------------------------------ 文本审核 ------------------------------ */

/** Green 的标签 → 我们内部的中文类别（便于与本地词表统一展示给用户/运营） */
const LABEL_ZH = {
  porn: '涉黄',
  sexy: '涉黄',
  sexual: '涉黄',
  politics: '涉政',
  political: '涉政',
  terrorism: '暴恐',
  contraband: '违禁品',
  drugs: '涉毒',
  gambling: '涉赌',
  fraud: '诈骗',
  abuse: '辱骂',
  ad: '广告违规',
  advertising: '广告违规',
  meaningless: '无意义内容',
  custom: '自定义违规',
};

/**
 * 文本审核。
 * @returns {Promise<{clean:boolean, categories:string[], labels:string[], riskLevel:string, raw:object, provider:'aliyun-green', degraded?:boolean}>}
 */
export async function greenTextCheck(text) {
  const c = cfg();
  const content = String(text || '').slice(0, 2000);
  if (!content.trim()) {
    return { clean: true, categories: [], labels: [], riskLevel: 'none', raw: null, provider: 'aliyun-green' };
  }
  // 接口要求 Content 传 base64
  const payload = {
    Service: c.textService,
    ServiceParameters: JSON.stringify({ content: content, dataId: crypto.randomUUID() }),
  };
  const json = await rpc('TextModeration', payload);

  // 返回结构：{ Code:200, Data:{ riskLevel:'high|medium|low|none', Result:[{Label,Confidence}] } }
  const data = json?.Data || {};
  const results = Array.isArray(data.Result) ? data.Result : [];
  const labels = results.map((r) => String(r.Label || '')).filter(Boolean);
  const riskLevel = String(data.riskLevel || json?.riskLevel || 'none');
  const bad = labels.length > 0 || ['high', 'medium'].includes(riskLevel);

  return {
    clean: !bad,
    categories: [...new Set(labels.map((l) => LABEL_ZH[l] || `其他(${l})`))],
    labels,
    riskLevel,
    raw: json,
    provider: 'aliyun-green',
  };
}

/* ------------------------------ 图片审核 ------------------------------ */

/**
 * 图片审核（按 URL）。
 *
 * 为什么先做 URL 版：本项目目前的图片都是**外链 URL**（头像等），没有上传通道，
 * 所以 URL 版即可覆盖现状；等有了上传（base64/OSS）再补 base64 版。
 * @returns {Promise<{clean:boolean, categories:string[], labels:string[], riskLevel:string, raw:object, provider:'aliyun-green'}>}
 */
export async function greenImageCheckByUrl(imageUrl) {
  const c = cfg();
  if (!imageUrl) throw new Error('缺少图片 URL');
  const payload = {
    Service: c.imageService,
    ServiceParameters: JSON.stringify({ imageUrl: String(imageUrl).slice(0, 1000), dataId: crypto.randomUUID() }),
  };
  const json = await rpc('ImageModeration', payload);

  const data = json?.Data || {};
  const results = Array.isArray(data.Result) ? data.Result : [];
  const labels = results.map((r) => String(r.Label || '')).filter(Boolean);
  const riskLevel = String(data.riskLevel || json?.riskLevel || 'none');
  const bad = labels.length > 0 || ['high', 'medium'].includes(riskLevel);

  return {
    clean: !bad,
    categories: [...new Set(labels.map((l) => LABEL_ZH[l] || `其他(${l})`))],
    labels,
    riskLevel,
    raw: json,
    provider: 'aliyun-green',
  };
}

/**
 * 图片审核（按 base64）。
 *
 * 上传通道还没有，这个方法先按官方文档实现好，等有上传时直接可用。
 * 注意：base64 会让请求体膨胀 4/3，接口对体积有限制，所以这里先用 OSS 中转更稳 ——
 * 因此本函数**先抛错要求改用 URL 版**，而不是写一个"看着能用但一传大图就失败"的实现。
 */
export async function greenImageCheckByBase64(_base64) {
  throw new Error(
    'base64 图片审核尚未接入：请先把图片上传到 OSS 拿到 URL，再用 greenImageCheckByUrl（避免大图请求体超限）',
  );
}
