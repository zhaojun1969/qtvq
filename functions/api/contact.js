import { corsPreflight, jsonResponse } from '../lib/http.js';
import { sendContactMail, isMailConfigured } from '../lib/mail.js';

const MAX_MESSAGE = 5000;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 400 * 1024;

function contactKey(id) {
  return `contact:${id}`;
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

  const kv = env?.QTVQ_KV;
  if (kv) {
    await kv.put(contactKey(id), JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 90 });
    await kv.put(`contact:index:${id}`, '1', { expirationTtl: 60 * 60 * 24 * 90 });
  }

  try {
    const { backupContactRecord } = await import('../lib/oss-backup.js');
    await backupContactRecord(env, record);
  } catch {
    /* OSS 未配置 */
  }

  const mailResult = await sendContactMail(env, record);
  if (mailResult.ok) {
    record.emailSent = true;
    record.emailProvider = mailResult.provider;
    if (kv) {
      await kv.put(contactKey(id), JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 90 });
    }
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
  });
}
