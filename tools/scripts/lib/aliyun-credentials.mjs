/**
 * 阿里云凭据加载（诊断工具共用，避免多个工具各自实现导致结论不一致）
 *
 * 优先级：
 *   1) 环境变量 ALIYUN_SMS_ACCESS_KEY_ID / ALIYUN_SMS_ACCESS_KEY_SECRET
 *   2) 仓库根的 .dev.vars（**线上正在用的那把**）
 *   3) Documents\阿里云短信服务\ 下的文本文件（历史留存，可能已过期）
 *
 * 为什么必须按这个顺序：2026-09-17 把短信 AK 换成新身份时，两个诊断工具原本都只读第 3 项，
 * 于是"换完密钥后跑工具复验"验的其实还是**旧密钥** —— 工具给出的结论与线上无关。
 * 同时这里会显式提示"文档里那份与线上不一致"，帮助发现遗留的明文旧凭据。
 *
 * 只返回 AK ID 尾部用于显示，绝不打印 Secret。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

export function statusOf(id) {
  return id ? `${id.slice(0, 8)}…${id.slice(-4)}` : '(缺失)';
}

function fromEnv() {
  const id = process.env.ALIYUN_SMS_ACCESS_KEY_ID;
  const secret = process.env.ALIYUN_SMS_ACCESS_KEY_SECRET;
  if (id && secret) return { id: id.trim(), secret: secret.trim(), source: '环境变量 ALIYUN_SMS_*' };
  return null;
}

function fromDevVars() {
  const file = path.join(ROOT, '.dev.vars');
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const get = (k) => {
    const line = text.split(/\r?\n/).find((l) => l.startsWith(`${k}=`));
    return line ? line.slice(k.length + 1).trim() : '';
  };
  const id = get('ALIYUN_SMS_ACCESS_KEY_ID');
  const secret = get('ALIYUN_SMS_ACCESS_KEY_SECRET');
  if (id && secret) return { id, secret, source: '.dev.vars（线上正在使用）' };
  return null;
}

export function fromDocuments() {
  const dir = path.join(process.env.USERPROFILE || '', 'Documents', '阿里云短信服务');
  if (!fs.existsSync(dir)) return null;
  const candidates = [];
  const walk = (d, depth = 0) => {
    if (depth > 2) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.(txt|env|json)$/i.test(e.name) && fs.statSync(p).size < 200000) candidates.push(p);
    }
  };
  walk(dir);
  for (const file of candidates) {
    const text = fs.readFileSync(file, 'utf8');
    const id = /accessKeyId\s*[:=：]\s*([A-Za-z0-9]+)/.exec(text)?.[1];
    const secret = /accessKeySecret\s*[:=：]\s*([A-Za-z0-9]+)/.exec(text)?.[1];
    if (id && secret) return { id, secret, source: `文档目录 ${path.basename(file)}（历史留存）` };
  }
  return null;
}

/** @returns {{id: string, secret: string, source: string, staleDocId?: string}|null} */
export function loadAliyunCredentials() {
  const cred = fromEnv() || fromDevVars() || fromDocuments();
  if (!cred) return null;

  // 提示遗留的明文旧凭据（换了密钥之后，文档目录里那份就成了"旧的但仍能用"的风险）
  const doc = fromDocuments();
  if (doc && doc.id !== cred.id) {
    cred.staleDocId = doc.id;
  }
  return cred;
}
