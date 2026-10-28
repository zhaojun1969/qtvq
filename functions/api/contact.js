import { corsPreflight, jsonResponse } from '../lib/http.js';
import { sendContactMail, isMailConfigured } from '../lib/mail.js';

const MAX_MESSAGE = 5000;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 400 * 1024;

/**
 * 把留言写入**境内** Node 服务（MongoDB `contact_messages`）。
 *
 * 2026-10-16 · P0-1「数据境内化」：
 * 本函数此前把 `record` 写进 `env.QTVQ_KV`（`contact:<id>` 与 `contact:index:<id>`）。
 * KV 由 Cloudflare 全球网络承载，而留言里的 `replyEmail` 与自由文本 `message`
 * 属于《个人信息保护法》定义的个人信息 —— 存于境外节点即构成数据出境。
 * 现在**KV 不再承载任何留言数据**，只写境内 MongoDB。
 *
 * 失败降级链（保证不丢数据）：
 *   ① 境内 MongoDB（本函数）
 *   ② 境内 OSS 备份（`backupContactRecord`，bucket 位于 oss-cn-beijing）
 *   ③ 邮件（`sendContactMail`，阿里云企业邮，境内）
 * 任何一环失败都不回写 KV —— 宁可少一份副本，也不让 PII 出境。
 */
async function persistToNode(env, record) {
  const base = String(env?.NODE_API_BASE || '').replace(/\/+$/, '');
  const adminKey = String(env?.NODE_ADMIN_KEY || '');
  if (!base || !adminKey) return { ok: false, reason: 'not-configured' };
  try {
    const res = await fetch(`${base}/v1/admin/contact`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': adminKey,
        /* 必须带 UA：本站 nginx 对空 UA 返回 444 静默断连（2026-10-11 入账事故的根因） */
        'User-Agent': 'qtvq-contact-ingest/1.0 (+https://qtvq.cn)',
      },
      body: JSON.stringify(record),
    });
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight(request);

  if (request.method !== 'POST') {
    return jsonResponse(request, { error: 'Method not allowed' }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, { error: '无效 JSON' }, 400);
  }

  const message = String(body.message || '').trim();
  if (!message) return jsonResponse(request, { error: '请填写留言内容' }, 400);
  if (message.length > MAX_MESSAGE) {
    return jsonResponse(request, { error: `留言不超过 ${MAX_MESSAGE} 字` }, 400);
  }

  const replyEmail = String(body.replyEmail || '').trim().slice(0, 120);
  const clientId = String(body.clientId || 'anonymous').slice(0, 64);
  const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];

  const storedImages = [];
  for (const img of images) {
    const name = String(img.name || 'image').slice(0, 80);
    const type = String(img.type || 'image/jpeg').slice(0, 40);
    const data = String(img.data || '');
    if (!data.startsWith('data:image/')) {
      return jsonResponse(request, { error: '图片格式无效' }, 400);
    }
    const base64 = data.split(',')[1] || '';
    const approxBytes = Math.ceil((base64.length * 3) / 4);
    if (approxBytes > MAX_IMAGE_BYTES) {
      return jsonResponse(request, { error: `单张图片不超过 ${MAX_IMAGE_BYTES / 1024}KB` }, 400);
    }
    storedImages.push({ name, type, data });
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const record = {
    id,
    to: 'qtvq@qtvq.cn',
    message,
    replyEmail: replyEmail || null,
    clientId,
    images: storedImages,
    createdAt: new Date().toISOString(),
  };

  // ① 境内 MongoDB
  //    只送「图片元数据」，不送 base64 正文：单条最多 4×400KB ≈ 2.1MB base64，
  //    会撞上服务端 express.json 的 1mb 上限（413），而图片正文已有境内 OSS 备份。
  const imagesMeta = storedImages.map(({ name, type, data }) => ({
    name,
    type,
    bytes: Math.ceil(((data.split(',')[1] || '').length * 3) / 4),
  }));
  const dbRecord = { ...record, images: imagesMeta };
  const persisted = await persistToNode(env, dbRecord);

  // ② 境内 OSS 备份（失败不影响主流程）
  try {
    const { backupContactRecord } = await import('../lib/oss-backup.js');
    await backupContactRecord(env, record);
  } catch {
    /* OSS 未配置 */
  }

  // ③ 邮件
  const mailResult = await sendContactMail(env, record);
  if (mailResult.ok) {
    record.emailSent = true;
    record.emailProvider = mailResult.provider;
    // 库里补一次 emailSent 状态（端点按 id 幂等 upsert，不会产生重复记录）
    if (persisted.ok) await persistToNode(env, { ...dbRecord, emailSent: true, emailProvider: mailResult.provider });
  }

  let userMessage;
  if (mailResult.ok) {
    userMessage = '留言已提交，已发送至 qtvq@qtvq.cn 邮箱，客服将尽快回复。';
  } else if (mailResult.skipped) {
    userMessage = '留言已保存，客服将在系统记录中查阅（邮件服务未配置）。';
  } else {
    userMessage = '留言已保存；邮件发送失败，客服仍可在系统记录中查阅，您也可直接发邮件至 qtvq@qtvq.cn。';
  }

  return jsonResponse(request, {
    ok: true,
    id,
    emailSent: !!mailResult.ok,
    mailConfigured: isMailConfigured(env),
    message: userMessage,
    mailto: 'qtvq@qtvq.cn',
    /* 便于运维判断是否真的落到境内库；不含任何 PII */
    storage: persisted.ok ? 'mongo-cn' : 'fallback-only',
  });
}
