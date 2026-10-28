#!/usr/bin/env node
/**
 * 阿里云短信：查询签名与模板审核状态（只读，不发短信、不花钱）
 *
 * 为什么要先跑这个：短信找回密码的前提是「签名」与「模板」都已审核通过。
 * 2026-06 本项目在另一个站点上就因为签名未过审而全部发送失败（isv.SMS_SIGNATURE_ILLEGAL），
 * 当时是靠翻日志才发现的。这里改成**直接问阿里云**，不猜、不等报错。
 *
 * 用法：
 *   node tools/scripts/check-aliyun-sms.mjs                 # 列出签名 + 模板及审核状态
 *   node tools/scripts/check-aliyun-sms.mjs --send=138xxxx --template=SMS_123 --sign=某签名
 *                                                          # 可选：真发一条（约 ¥0.045）
 *
 * 凭据来源（按顺序）：环境变量 → 文档目录下的 ALIYUN_ACCESS_KEY 文本文件。
 * 不打印任何密钥内容。
 */
import crypto from 'node:crypto';
import { loadAliyunCredentials, statusOf } from './lib/aliyun-credentials.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ENDPOINT = 'https://dysmsapi.aliyuncs.com/';
const VERSION = '2017-05-25';

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

function loadCredentials() {
  if (process.env.ALIYUN_SMS_ACCESS_KEY_ID && process.env.ALIYUN_SMS_ACCESS_KEY_SECRET) {
    return {
      id: process.env.ALIYUN_SMS_ACCESS_KEY_ID.trim(),
      secret: process.env.ALIYUN_SMS_ACCESS_KEY_SECRET.trim(),
      source: '环境变量 ALIYUN_SMS_*',
    };
  }
  const candidates = [
    path.join(process.env.USERPROFILE || '', 'Documents', '阿里云短信服务', '阿里云的 ALIYUN_ACCESS_KEY', '1780025769211.txt'),
    path.join(process.env.USERPROFILE || '', 'Documents', '阿里云短信服务', '阿里云AI-ALIYUN_ACCESS_KEY', '阿里云短信SMS.txt'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const id = /accessKeyId\s*[:=：]\s*([A-Za-z0-9]+)/.exec(text)?.[1];
    const secret = /accessKeySecret\s*[:=：]\s*([A-Za-z0-9]+)/.exec(text)?.[1];
    if (id && secret) return { id, secret, source: path.basename(file) };
  }
  return null;
}

const cred = loadAliyunCredentials();
if (!cred) {
  console.error('未找到阿里云短信凭据（环境变量 / .dev.vars / 文档目录都试过了）');
  process.exit(1);
}
console.log(`凭据来源：${cred.source}`);
console.log(`AK：${statusOf(cred.id)}（只显示 ID，Secret 不打印）`);
if (cred.staleDocId) {
  console.log(`⚠️ 文档目录里还留着一把不同的旧 AK（${statusOf(cred.staleDocId)}）—— 轮换完成后应删除那份明文文件`);
}
console.log('');

function signedUrl(action, params = {}) {
  const common = {
    Format: 'JSON',
    Version: VERSION,
    AccessKeyId: cred.id,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    RegionId: 'cn-hangzhou',
    Action: action,
    ...params,
  };
  const canonical = Object.keys(common)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(String(common[k]))}`)
    .join('&');
  // 关键细节：虽然官方文档示例常写 `GET&%2F&`，但**用 POST 提交时前缀必须是 `POST&%2F&`**。
  // 写错会被网关拒绝，并且报错里会回显它自己算的 string-to-sign（可据此对齐）。
  const stringToSign = `POST&%2F&${percentEncode(canonical)}`;
  const signature = crypto.createHmac('sha1', `${cred.secret}&`).update(stringToSign).digest('base64');
  return `${canonical}&Signature=${percentEncode(signature)}`;
}

async function call(action, params) {
  // 注意：这些接口虽然按 RPC 风格签名（stringToSign 里固定写 GET&%2F&），
  // 但网关要求用 **POST** 提交 —— 用 GET 会得到 "This http method is not supported."
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: signedUrl(action, params),
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

/**
 * 审核状态的**真实字段**是 AuditStatus，取值形如 AUDIT_STATE_PASS。
 *
 * 第一版按 SignStatus=1/0/2 猜（那是老控制台的写法），结果每个签名都打印 "审核状态=undefined"，
 * 最后还得出"没有审核通过的签名"——签名明明全部通过。**一个诊断工具给出错误结论，
 * 比没有这个工具更糟**（本项目已在 health.js、wechat-order-status 上栽过同类跟头）。
 */
function auditText(status) {
  const map = {
    AUDIT_STATE_PASS: '✅ 审核通过',
    AUDIT_STATE_INIT: '⏳ 审核中',
    AUDIT_STATE_WAITING: '⏳ 等待审核',
    AUDIT_STATE_FAILED: '❌ 审核未通过',
    AUDIT_STATE_REJECT: '❌ 审核被驳回',
  };
  if (!status) return '⚠️ 状态未知（阿里云未返回 AuditStatus）';
  return map[status] || `⚠️ ${status}`;
}

function reasonText(reason) {
  if (!reason || typeof reason !== 'object') return reason ? String(reason) : '无';
  const parts = [reason.RejectInfo, reason.RejectSubInfo].filter(Boolean);
  if (reason.RejectDate) parts.push(`退回时间 ${reason.RejectDate}`);
  return parts.length ? parts.join(' / ') : '无';
}

function fmtTime(t) {
  if (!t) return '-';
  return String(t).replace('T', ' ').replace(/\.\d+Z?$/, '').slice(0, 19);
}

async function listSigns() {
  console.log('=== 1) 短信签名（SignName）===');
  const { json, text } = await call('QuerySmsSignList', { PageSize: '50', CurrentPage: '1' });
  if (!json || json.Code !== 'OK') {
    console.log('  查询失败：', (json && (json.Message || json.Code)) || text.slice(0, 200));
    if (json?.Code === 'InvalidAccessKeyId.NotFound') console.log('  → 这组 AK 已失效/不存在，需要新的 RAM 凭据');
    if (json?.Code === 'SignatureDoesNotMatch') {
      console.log('  → 签名不匹配。可能是：① AccessKeySecret 与 AK 不是一对；② string-to-sign 前缀/编码不对');
      console.log('     （报错里 server string to sign 是阿里云自己算的，可用来对齐，别急着断定密钥错了）');
    }
    if (json?.Code === 'Forbidden' || json?.Code === 'NoPermission') {
      console.log('  → 该 RAM 用户没有 dysms:QuerySmsSignList 权限（收紧权限时会连带失去查询能力，不影响发短信）');
    }
    return [];
  }
  const list = json.SmsSignList || [];
  if (list.length === 0) console.log('  （没有查到任何签名 —— 说明还没在阿里云短信服务里创建签名）');
  for (const s of list) {
    console.log(`  · 签名「${s.SignName}」 ${auditText(s.AuditStatus)} 类型=${s.BusinessType || '-'} 创建=${s.CreateDate || '-'}`);
    const r = reasonText(s.Reason);
    if (r !== '无') console.log(`      原因：${r}`);
  }
  console.log('');
  return list;
}

async function listTemplates() {
  console.log('=== 2) 短信模板（TemplateCode）===');
  const { json, text } = await call('QuerySmsTemplateList', { PageSize: '50', CurrentPage: '1' });
  if (!json || json.Code !== 'OK') {
    console.log('  查询失败：', (json && (json.Message || json.Code)) || text.slice(0, 200));
    return [];
  }
  const list = json.SmsTemplateList || [];
  if (list.length === 0) console.log('  （没有查到任何模板 —— 还没创建模板）');
  for (const t of list) {
    const isCode = String(t.TemplateType) === '2';
    console.log(
      `  · 模板 ${t.TemplateCode} ${auditText(t.AuditStatus)} 类型=${isCode ? '验证码' : String(t.TemplateType)}${isCode ? '（可用于找回密码）' : ''}`,
    );
    // SignatureName 是模板**绑定的签名**：发短信时 SignName 必须在这里面（不含则报 SMS_SIGNATURE_ILLEGAL）
    if (t.SignatureName) console.log(`      绑定签名：${t.SignatureName}`);
    console.log(`      名称：${t.TemplateName || '-'}   内容：${(t.TemplateContent || '').replace(/\s+/g, ' ').slice(0, 90)}`);
    const r = reasonText(t.Reason);
    if (r !== '无') console.log(`      审核意见：${r}`);
  }
  console.log('');
  return list;
}

async function sendTest(phone, templateCode, signName) {
  console.log('=== 3) 真实发送一条（会产生费用）===');
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const { json, text } = await call('SendSms', {
    PhoneNumbers: phone,
    SignName: signName,
    TemplateCode: templateCode,
    TemplateParam: JSON.stringify({ code }),
  });
  console.log('  阿里云返回：', JSON.stringify(json || text.slice(0, 200)));
  if (json?.Code === 'OK') {
    console.log(`  ✅ 发送成功（验证码 ${code}）—— 签名与模板均可用，短信找回密码可以上线`);
  } else {
    console.log('  ❌ 发送失败：', json?.Code, json?.Message);
  }
}

const signs = await listSigns();
const templates = await listTemplates();

const approvedSign = (signs || []).find((s) => s.AuditStatus === 'AUDIT_STATE_PASS');
const approvedTemplate = (templates || []).find((t) => t.AuditStatus === 'AUDIT_STATE_PASS' && String(t.TemplateType) === '2');

console.log('=== 结论 ===');
if (approvedSign) console.log(`  ✅ 可用签名：${approvedSign.SignName}`);
else console.log('  ❌ 没有审核通过的签名 —— 短信发送会被拒（isv.SMS_SIGNATURE_ILLEGAL，2026-06 踩过）');
if (approvedTemplate) {
  console.log(`  ✅ 可用验证码模板：${approvedTemplate.TemplateCode}（${approvedTemplate.TemplateName || ''}）`);
  console.log(`     绑定签名：${approvedTemplate.SignatureName || '(未返回)'}`);
  console.log('     ⚠️ 发短信时 SignName 必须在该模板的绑定签名列表里，否则会报 SMS_SIGNATURE_ILLEGAL');
} else {
  console.log('  ❌ 没有审核通过的验证码模板 —— 需要申请一个「验证码」类型模板，含变量 ${code}');
}

const argSend = process.argv.find((a) => a.startsWith('--send='));
if (argSend) {
  const phone = argSend.slice('--send='.length);
  const tpl = (process.argv.find((a) => a.startsWith('--template=')) || '').slice('--template='.length) || approvedTemplate?.TemplateCode;
  const sign = (process.argv.find((a) => a.startsWith('--sign=')) || '').slice('--sign='.length) || approvedSign?.SignName;
  if (!tpl || !sign) {
    console.log('  没有可用的签名/模板，跳过真实发送');
  } else {
    console.log('');
    await sendTest(phone, tpl, sign);
  }
}
