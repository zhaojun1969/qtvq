#!/usr/bin/env node
/**
 * 微信支付订单状态查询 / 回调失效诊断（本地工具，不修改任何数据）
 *
 * 为什么需要它：2026-09-16 发现线上 24 笔订单全部停在 pending 且没有交易号，
 * 说明**微信回调从未成功**。此时"客户到底付没付钱"必须能查证 —— 真金白银不能靠猜。
 * 微信商户平台 V3 接口可以按商户订单号查真实交易状态，这是唯一权威来源。
 *
 * 顺带做一件重要验证：/v3/certificates 的返回是**用 APIv3 密钥加密**的，
 * 能解开就证明轮换后的 APIv3 密钥与商户平台一致（解不开就说明密钥填错了）。
 *
 * 用法：
 *   node tools/scripts/wechat-order-status.mjs                 # 只验证密钥 + 列平台证书序列号
 *   node tools/scripts/wechat-order-status.mjs ord_xxx ord_yyy # 查这些订单的真实状态
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = 'https://api.mch.weixin.qq.com';

function loadDevVars() {
  const file = path.join(ROOT, '.dev.vars');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const env = {};
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    // 多行值（微信商户私钥）：一直取到 END 行
    if (key === 'WECHAT_MCH_PRIVATE_KEY' && val.includes('BEGIN') && !val.includes('END')) {
      const parts = [val];
      for (let j = i + 1; j < lines.length; j += 1) {
        parts.push(lines[j]);
        if (lines[j].includes('END PRIVATE KEY')) break;
      }
      val = parts.join('\n');
    }
    env[key] = val.trim();
  }
  return env;
}

const env = loadDevVars();
const mchId = env.WECHAT_MCH_ID || '';
const serial = env.WECHAT_MCH_SERIAL || '';
const apiV3Key = env.WECHAT_API_V3_KEY || '';
const privateKey = (env.WECHAT_MCH_PRIVATE_KEY || '').replace(/\\n/g, '\n');

if (!mchId || !serial || !apiV3Key || !privateKey.includes('BEGIN')) {
  console.error('缺少配置：需要 WECHAT_MCH_ID / WECHAT_MCH_SERIAL / WECHAT_API_V3_KEY / WECHAT_MCH_PRIVATE_KEY');
  process.exit(1);
}

function authorization(method, urlPath, body = '') {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = `${method}\n${urlPath}\n${ts}\n${nonce}\n${body}\n`;
  const signature = crypto.createSign('RSA-SHA256').update(message).sign(privateKey, 'base64');
  return `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${ts}",serial_no="${serial}"`;
}

async function wxRequest(method, urlPath, body) {
  const raw = body ? JSON.stringify(body) : '';
  const res = await fetch(BASE + urlPath, {
    method,
    headers: {
      Authorization: authorization(method, urlPath, raw),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      // 微信要求带 User-Agent，否则可能被拒
      'User-Agent': 'qtvq-api/1.0',
      // Node 的 fetch 会带上微信不认的 Accept-Language，显式给一个合法值
      'Accept-Language': 'zh-CN',
    },
    body: raw || undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

function aesGcmDecrypt(key, { associated_data: aad, nonce, ciphertext }) {
  const buf = Buffer.from(ciphertext, 'base64');
  const tag = buf.subarray(buf.length - 16);
  const data = buf.subarray(0, buf.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'utf8'), Buffer.from(nonce, 'utf8'));
  d.setAuthTag(tag);
  d.setAAD(Buffer.from(aad || '', 'utf8'));
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

async function checkApiV3Key() {
  console.log('=== 1) 验证 APIv3 密钥（解 /v3/certificates 的密文）===');
  const { status, json } = await wxRequest('GET', '/v3/certificates');

  // 「微信支付公钥」模式下，微信**不再提供平台证书**，/v3/certificates 返回
  // 404 RESOURCE_NOT_EXISTS「无可用的平台证书，请在商户平台-API安全申请使用微信支付公钥」。
  // 这种情况不是"密钥错了"——只是这条路已经不存在了。旧版本会在这里打印
  // "APIv3 密钥不正确"，把人往错误方向带（已经误导过一次排查），所以必须单独识别。
  const isPublicKeyMode =
    status === 404 &&
    (json?.code === 'RESOURCE_NOT_EXISTS' || /微信支付公钥|平台证书/.test(json?.message || ''));
  if (isPublicKeyMode) {
    console.log(`  本商户号已使用「微信支付公钥」模式：/v3/certificates 返回 404（${json?.code || ''}）。`);
    console.log('  → 平台证书已不存在，因此**无法**用解密平台证书的方式验证 APIv3 密钥；');
    console.log('    这**不代表**密钥是错的（旧版本在这里误报"APIv3 密钥不正确"，属误导）。');
    console.log('    真正能证明 APIv3 密钥的方式只有一个：一笔真实付款触发的回调能否解密成功。');
    console.log('    相关：node tools/scripts/wechat-verify-platform-key.mjs（验公钥/验签链路）');
    console.log('');
    return null; // unknown，而不是 false
  }

  if (status !== 200 || !json?.data) {
    console.log(`  ❌ 请求失败 HTTP ${status}:`, JSON.stringify(json || {}).slice(0, 200));
    return false;
  }
  const list = Array.isArray(json.data) ? json.data : [];
  console.log(`  返回 ${list.length} 张平台证书`);
  let okCount = 0;
  for (const item of list) {
    const enc = item.encrypt_certificate || {};
    try {
      const pem = aesGcmDecrypt(apiV3Key, enc);
      const cert = new crypto.X509Certificate(pem);
      const sn = cert.serialNumber.toLowerCase();
      const validTo = cert.validTo;
      console.log(`  ✅ 解密成功  序列号=${sn}  证书有效期至 ${validTo}`);
      okCount += 1;
    } catch (err) {
      console.log(`  ❌ 解密失败: ${err.message}`);
    }
  }
  if (okCount > 0) {
    console.log('  → **APIv3 密钥正确**（与商户平台一致），回调解密这一步没问题');
  } else {
    console.log('  → **APIv3 密钥不对**：所有密文都解不开。这就是回调失败的原因，需在商户平台核对并重填。');
  }
  console.log('');
  return okCount > 0;
}

async function queryOrder(orderId) {
  const urlPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderId)}?mchid=${mchId}`;
  const { status, json } = await wxRequest('GET', urlPath);
  if (status !== 200) {
    const code = json?.code || '';
    const msg = json?.message || '';
    console.log(`  ${orderId}  HTTP ${status}  ${code} ${msg}`.trimEnd());
    return { orderId, state: `HTTP_${status}`, code, msg };
  }
  const state = json.trade_state || '';
  const amount = json.amount?.total;
  console.log(
    `  ${orderId}  trade_state=${state}  金额=${amount}  交易号=${json.transaction_id || '-'}  支付完成时间=${json.success_time || '-'}`,
  );
  // 微信订单里记录了创建时提交的 notify_url：用它证明"回调会打到我们配置的那个地址"，
  // 而不是靠人肉确认环境变量改没改生效（改完必须重新部署才生效）。
  if (json.notify_url) console.log(`      notify_url=${json.notify_url}`);
  return { orderId, state, amount, transactionId: json.transaction_id || null, successTime: json.success_time || null };
}

async function main() {
  console.log('商户号:', mchId, ' 证书序列号:', serial.slice(0, 8) + '***', ' APIv3密钥长度:', apiV3Key.length);
  console.log('');
  const keyOk = await checkApiV3Key();

  const orderIds = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (orderIds.length === 0) {
    console.log('（未指定订单号，只做了密钥验证。传订单号可查真实交易状态）');
    return;
  }
  console.log('=== 2) 逐笔查询真实交易状态 ===');
  const results = [];
  for (const id of orderIds) {
    results.push(await queryOrder(id));
  }
  const paid = results.filter((r) => r.state === 'SUCCESS');
  console.log('');
  console.log(`=== 汇总：共 ${results.length} 笔，其中**已支付成功 ${paid.length} 笔** ===`);
  for (const p of paid) {
    console.log(`  ✅ ${p.orderId}  ¥${(p.amount || 0) / 100}  交易号 ${p.transactionId}`);
  }
  if (keyOk === false) {
    console.log('');
    console.log('⚠️ APIv3 密钥不正确（平台证书密文解不开）→ 客户付款后不会自动开通；需先修密钥再逐笔补开通。');
  } else if (keyOk === null) {
    console.log('');
    console.log('ℹ️ 公钥模式下无法用平台证书验证 APIv3 密钥：它的正确性只能由一笔真实付款的回调来证明。');
  }
}

main().catch((e) => {
  console.error('执行失败:', e.message);
  process.exit(1);
});
