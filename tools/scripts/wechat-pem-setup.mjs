#!/usr/bin/env node
/**
 * 微信支付 PEM 装配工具（本地，只读 PEM + 写 .dev.vars，不碰线上）
 *
 * 存在的理由：微信支付要填 3 个东西，历史上**两次**事故都出在"手抄/复制 PEM"这一步
 * （一次把 27 字符的 BEGIN 头当成了私钥推上线，把支付打成 502）。
 * 所以这里不再让人手抄：把下载的文件丢进 .secrets/wechat/，由程序识别、配对、读序列号、写文件。
 *
 * 用法：
 *   node tools/scripts/wechat-pem-setup.mjs            # 只检查并打印将要写入的内容（不动文件）
 *   node tools/scripts/wechat-pem-setup.mjs --write    # 备份 .dev.vars 后写入
 *
 * 识别规则（按文件内容，不按文件名）：
 *   -----BEGIN PRIVATE KEY-----  → 商户 API 证书私钥 → WECHAT_MCH_PRIVATE_KEY
 *   -----BEGIN CERTIFICATE-----  → 商户 API 证书     → 只取序列号 → WECHAT_MCH_SERIAL
 *   -----BEGIN PUBLIC KEY-----   → 微信支付公钥      → WECHAT_PLATFORM_PUBLIC_KEY
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_DIR = path.join(ROOT, '.secrets', 'wechat');
const DEV_VARS = path.join(ROOT, '.dev.vars');
const write = process.argv.includes('--write');

/** 只统计指纹，绝不打印密钥本体 */
function fp(text) {
  return crypto.createHash('sha256').update(text.trim()).digest('hex').slice(0, 12);
}

function readPemFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => /\.(pem|crt|cer|key|txt)$/i.test(n))
    .map((n) => ({ name: n, text: fs.readFileSync(path.join(dir, n), 'utf8') }));
}

function normalizePem(text) {
  // 兼容 \r\n 与"整段无换行"两种粘贴形态，统一成 64 字符一行的标准 PEM
  const m = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(text.replace(/\\n/g, '\n'));
  if (!m) return null;
  const label = m[1].trim();
  const body = m[2].replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) || [body];
  return { label, pem: `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----` };
}

const files = readPemFiles(SRC_DIR);
if (files.length === 0) {
  console.error(`没找到 PEM 文件。请把下载的 apiclient_key.pem / apiclient_cert.pem / pub_key.pem 放进：`);
  console.error(`  ${SRC_DIR}`);
  console.error('（该目录已在 .gitignore 里，不会入库。细节见同目录 README.md）');
  process.exit(1);
}

console.log(`=== 扫描 ${path.relative(ROOT, SRC_DIR)} ===`);
const privateKeys = [];
const certs = [];
const publicKeys = [];
for (const f of files) {
  const norm = normalizePem(f.text);
  if (!norm) {
    console.log(`  ⏭  ${f.name}：不是 PEM（跳过）`);
    continue;
  }
  const item = { ...norm, file: f.name };
  console.log(`  ·  ${f.name.padEnd(24)} ${norm.label.padEnd(20)} fp=${fp(norm.pem)}  行数=${norm.pem.split('\n').length}`);
  if (norm.label === 'PRIVATE KEY' || norm.label === 'RSA PRIVATE KEY') privateKeys.push(item);
  else if (norm.label === 'CERTIFICATE') certs.push(item);
  else if (norm.label === 'PUBLIC KEY') publicKeys.push(item);
}

console.log('');
if (privateKeys.length === 0) {
  console.error('❌ 缺少商户私钥（-----BEGIN PRIVATE KEY-----，来自 apiclient_key.pem）');
  process.exit(1);
}
if (certs.length === 0) {
  console.error('❌ 缺少商户 API 证书（-----BEGIN CERTIFICATE-----，来自 apiclient_cert.pem）—— 需要它才能拿到证书序列号');
  process.exit(1);
}
if (publicKeys.length === 0) {
  console.warn('⚠️  缺少微信支付公钥（-----BEGIN PUBLIC KEY-----，来自 pub_key.pem）—— 回调验签仍会失败');
}

/** 找到与该私钥配对的那张证书，并顺带校验 */
function pickPair() {
  for (const k of privateKeys) {
    let privObj;
    try {
      privObj = crypto.createPrivateKey(k.pem);
    } catch (err) {
      console.log(`  ❌ ${k.file} 私钥无法解析：${err.message}`);
      continue;
    }
    const derivedPub = crypto.createPublicKey(privObj).export({ type: 'spki', format: 'pem' }).toString();
    for (const c of certs) {
      let cert;
      try {
        cert = new crypto.X509Certificate(c.pem);
      } catch (err) {
        console.log(`  ❌ ${c.file} 证书无法解析：${err.message}`);
        continue;
      }
      const certPub = cert.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      if (certPub.trim() === derivedPub.trim()) return { key: k, cert, certFile: c.file };
    }
    console.log(`  ⚠️  ${k.file} 与已放入的任何证书都**不配对**（说明下载串了，或放了两套证书中的另一套）`);
  }
  return null;
}

console.log('=== 配对校验（私钥 ↔ 证书）===');
const pair = pickPair();
if (!pair) {
  console.error('❌ 没有找到"私钥与证书配对"的一套。请确认 apiclient_key.pem 与 apiclient_cert.pem 是同一次申请的同一套。');
  process.exit(1);
}
const serial = pair.cert.serialNumber.toUpperCase();
const notBefore = new Date(pair.cert.validFrom);
const notAfter = new Date(pair.cert.validTo);
const now = Date.now();
console.log(`  ✅ ${pair.key.file}  ↔  ${pair.certFile} 配对成功`);
console.log(`     证书序列号（写入 WECHAT_MCH_SERIAL）：${serial}`);
console.log(`     证书有效期：${notBefore.toISOString().slice(0, 10)} → ${notAfter.toISOString().slice(0, 10)}`);
if (now < notBefore.getTime() || now > notAfter.getTime()) {
  console.log('  ❌ 证书**当前不在有效期内**，微信会拒绝该证书的签名');
  process.exit(1);
}
console.log(`     证书主体：${pair.cert.subject.replace(/\n/g, ' ')}`);

/* ── 组装将要写入 .dev.vars 的三段 ── */
const blocks = [
  ['WECHAT_MCH_PRIVATE_KEY', pair.key.pem],
  ['WECHAT_MCH_SERIAL', serial],
];
if (publicKeys.length > 0) blocks.push(['WECHAT_PLATFORM_PUBLIC_KEY', publicKeys[0].pem]);

console.log('');
console.log('=== 将写入 .dev.vars ===');
for (const [k, v] of blocks) {
  const oneLine = v.replace(/\n/g, ' ');
  console.log(`  ${k} = ${v.includes('\n') ? '(多行 PEM) ' : ''}${oneLine.slice(0, 46)}${oneLine.length > 46 ? '…' : ''}  [长度 ${v.length}, fp ${fp(v)}]`);
}

/* ── 重写 .dev.vars：替换这几个键（连同其多行续行），其余原样保留 ── */
function stripKey(lines, key) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!new RegExp(`^${key}=`).test(lines[i])) {
      out.push(lines[i]);
      continue;
    }
    const val = lines[i].slice(key.length + 1);
    if (val.includes('BEGIN') && !val.includes('END')) {
      for (let j = i + 1; j < lines.length; j += 1) {
        i = j;
        if (lines[j].includes('END') || /^[A-Z][A-Z0-9_]+=/.test(lines[j])) break;
      }
    }
  }
  return out;
}

if (!write) {
  console.log('');
  console.log('（预演模式，未改动任何文件。加 --write 才会写入 .dev.vars）');
  process.exit(0);
}

if (!fs.existsSync(DEV_VARS)) {
  console.error('❌ 找不到 .dev.vars');
  process.exit(1);
}
const original = fs.readFileSync(DEV_VARS, 'utf8');
const backup = `${DEV_VARS}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.writeFileSync(backup, original, 'utf8');

let lines = original.split(/\r?\n/);
for (const [k] of blocks) lines = stripKey(lines, k);
while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
const appended = blocks.map(([k, v]) => `${k}=${v}`);
const text = `${[...lines, '', `# ── 微信支付凭据（由 tools/scripts/wechat-pem-setup.mjs 于 ${new Date().toISOString()} 写入）──`, ...appended].join('\n')}\n`;
fs.writeFileSync(DEV_VARS, text, 'utf8');

console.log('');
console.log(`✅ 已写入 .dev.vars（原文件备份：${path.basename(backup)}）`);
console.log('   下一步：powershell -ExecutionPolicy Bypass -File tools/scripts/upload-wechat-secrets.ps1');
console.log('   然后：node tools/scripts/deploy.ps1   ← 密钥变更必须重新部署才生效');
console.log('   最后：node tools/scripts/wechat-verify-platform-key.mjs   ← 用微信真实签名验公钥');
