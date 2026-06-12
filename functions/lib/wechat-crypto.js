/** 微信支付 V3 所需的 PEM / Base64 / AES-GCM / RSA 工具（Workers Web Crypto） */

export function randomNonce(length = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function normalizePrivateKeyPem(raw) {
  if (!raw) return '';
  let pem = String(raw).trim();
  if (pem.includes('\\n')) pem = pem.replace(/\\n/g, '\n');

  const extractBody = (begin, end) => {
    const start = pem.indexOf(begin);
    const finish = pem.indexOf(end);
    if (start === -1 || finish === -1) return null;
    return pem.slice(start + begin.length, finish).replace(/\s+/g, '');
  };

  let body = extractBody('-----BEGIN PRIVATE KEY-----', '-----END PRIVATE KEY-----');
  if (body) {
    const lines = body.match(/.{1,64}/g) || [body];
    return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`;
  }

  body = extractBody('-----BEGIN RSA PRIVATE KEY-----', '-----END RSA PRIVATE KEY-----');
  if (body) {
    const lines = body.match(/.{1,64}/g) || [body];
    return `-----BEGIN RSA PRIVATE KEY-----\n${lines.join('\n')}\n-----END RSA PRIVATE KEY-----`;
  }

  const compact = pem.replace(/\s+/g, '');
  const lines = compact.match(/.{1,64}/g) || [compact];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`;
}

export function normalizePublicKeyPem(raw) {
  if (!raw) return '';
  let pem = String(raw).trim();
  if (pem.includes('\\n')) pem = pem.replace(/\\n/g, '\n');
  if (pem.includes('BEGIN CERTIFICATE') || pem.includes('BEGIN PUBLIC KEY')) {
    return pem;
  }
  const body = pem.replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) || [body];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----`;
}

function pemBodyToArrayBuffer(pem) {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function importPrivateKey(pemRaw) {
  const pem = normalizePrivateKeyPem(pemRaw);
  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      pemBodyToArrayBuffer(pem),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch {
    throw new Error('Invalid merchant private key (check WECHAT_MCH_PRIVATE_KEY PEM in .dev.vars)');
  }
}

export async function importPublicKey(pemRaw) {
  const pem = normalizePublicKeyPem(pemRaw);
  return crypto.subtle.importKey(
    'spki',
    pemBodyToArrayBuffer(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function rsaSignBase64(privateKeyPem, message) {
  const key = await importPrivateKey(privateKeyPem);
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(message),
  );
  return bytesToBase64(new Uint8Array(sig));
}

export async function rsaVerifyBase64(publicKeyPem, message, signatureB64) {
  const key = await importPublicKey(publicKeyPem);
  const sig = base64ToBytes(signatureB64);
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    sig,
    new TextEncoder().encode(message),
  );
}

/** 解密微信支付通知 resource（AEAD_AES_256_GCM） */
export async function decryptWechatResource(apiV3Key, { associatedData = '', nonce, ciphertext }) {
  const keyBytes = new TextEncoder().encode(apiV3Key);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
  const data = base64ToBytes(ciphertext);
  const iv = new TextEncoder().encode(nonce);
  const aad = new TextEncoder().encode(associatedData || '');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, data);
  return new TextDecoder().decode(plain);
}
