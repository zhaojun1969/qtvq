/**
 * 微信支付 V3 加密工具（**server 侧**，2026-10-27）
 *
 * 移植自 `functions/lib/wechat-crypto.js`，但实现换成 Node 原生 `node:crypto`：
 *   · Workers 那份用 Web Crypto（`crypto.subtle` + 手工 PEM 拆装）；
 *   · Node 的 `createSign/createVerify` 直接吃 PEM 字符串，少一层手工解码，
 *     也避免 pkcs8/rsa 两种 PEM 头在 Web Crypto 里的兼容坑。
 *
 * **算法参数必须与 Workers 那份完全一致**，否则同一个商户私钥在两侧签出的名字对不上：
 *   · 签名：RSASSA-PKCS1-v1_5 + SHA-256（即 RSA-SHA256），Base64 输出；
 *   · 通知签名串：`timestamp\nnonce\nbody\n`；
 *   · 请求签名串：`method\nurl\ntimestamp\nnonce\nbody\n`（url 含 query，body 无则空串）；
 *   · 回调解密：AEAD_AES_256_GCM，key = APIv3 密钥原文（32 字节），
 *     iv = nonce 原文，AAD = associated_data，密文尾部 16 字节是 auth tag。
 */

import crypto from 'node:crypto';

export function randomNonce(length = 32) {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

/** 把各种形态的私钥（带 \n 字面量、缺头尾、单行）规范成合法 PEM */
export function normalizePrivateKeyPem(raw) {
  if (!raw) return '';
  let pem = String(raw).trim();
  if (pem.includes('\\n')) pem = pem.replace(/\\n/g, '\n');

  const wrap = (body, label) => {
    const lines = body.match(/.{1,64}/g) || [body];
    return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
  };
  const extract = (begin, end) => {
    const start = pem.indexOf(begin);
    const finish = pem.indexOf(end);
    if (start === -1 || finish === -1) return null;
    return pem.slice(start + begin.length, finish).replace(/\s+/g, '');
  };

  const pkcs8 = extract('-----BEGIN PRIVATE KEY-----', '-----END PRIVATE KEY-----');
  if (pkcs8) return wrap(pkcs8, 'PRIVATE KEY');

  const rsa = extract('-----BEGIN RSA PRIVATE KEY-----', '-----END RSA PRIVATE KEY-----');
  if (rsa) return wrap(rsa, 'RSA PRIVATE KEY');

  return wrap(pem.replace(/\s+/g, ''), 'PRIVATE KEY');
}

export function normalizePublicKeyPem(raw) {
  if (!raw) return '';
  let pem = String(raw).trim();
  if (pem.includes('\\n')) pem = pem.replace(/\\n/g, '\n');
  if (pem.includes('BEGIN CERTIFICATE') || pem.includes('BEGIN PUBLIC KEY')) return pem;
  const body = pem.replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) || [body];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----`;
}

/** 用商户私钥签名，返回 Base64 */
export function rsaSignBase64(privateKeyPem, message) {
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(message, 'utf8');
  return signer.sign(normalizePrivateKeyPem(privateKeyPem), 'base64');
}

/** 用微信支付公钥验签 */
export function rsaVerifyBase64(publicKeyPem, message, signatureB64) {
  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(message, 'utf8');
    return verifier.verify(normalizePublicKeyPem(publicKeyPem), signatureB64, 'base64');
  } catch (err) {
    console.error('[wechat-crypto] 验签异常：', err?.message || err);
    return false;
  }
}

/**
 * 解密回调 resource（AEAD_AES_256_GCM）。
 * 失败抛异常 —— 调用方据此返回 `resource 解密失败`，不要吞掉。
 */
export function decryptWechatResource(apiV3Key, { associatedData = '', nonce, ciphertext }) {
  const key = Buffer.from(String(apiV3Key || ''), 'utf8');
  if (key.length !== 32) throw new Error(`APIv3 密钥长度应为 32 字节，实际 ${key.length}`);
  const data = Buffer.from(String(ciphertext || ''), 'base64');
  if (data.length <= 16) throw new Error('密文长度异常');
  const iv = Buffer.from(String(nonce || ''), 'utf8');
  const aad = Buffer.from(String(associatedData || ''), 'utf8');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  return plain.toString('utf8');
}

/**
 * 仅用于本地自测：按微信的 AES-256-GCM 规则加密（生产不会用到）。
 * 有了它，回调 e2e 不必依赖真实微信回调 —— 用测试密钥造一条"合法"通知。
 */
export function encryptWechatResource(apiV3Key, { associatedData = '', nonce, plaintext }) {
  const key = Buffer.from(String(apiV3Key || ''), 'utf8');
  const iv = Buffer.from(String(nonce || ''), 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(associatedData || ''), 'utf8'));
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return Buffer.concat([enc, cipher.getAuthTag()]).toString('base64');
}
