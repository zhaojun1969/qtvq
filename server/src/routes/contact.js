/**
 * `/api/contact` —— 站内留言（**境内 Node 版**，2026-10-26）
 *
 * 从 `functions/api/contact.js` 迁来。契约保持一致：
 *   POST { message, replyEmail?, clientId?, images?[] }
 *   → { ok, id, emailSent, mailConfigured, message, mailto, storage }
 *
 * ── 为什么能迁 ────────────────────────────────────────────────────────────
 * 留言本来就**只**写境内 Mongo（`contact_messages`），Pages 那份只是校验 + 调
 * `/v1/admin/contact` + 发通知邮件。现在 Node 自己就能发邮件（`services/mail.js`，
 * 用 `node:tls` 直连 SMTP，不加依赖），于是整条链路可以留在境内完成。
 *
 * ── 图片的处理与 Pages 版不同（更简单）───────────────────────────────────
 * Pages 版把图片 base64 存进 KV/OSS 备份，Mongo 里只留元数据（避免撞 1MB body 上限）。
 * Node 版直接**只保留元数据**，不落 base64 正文：
 * 图片正文留在浏览器端即可，客服需要时可在留言里请用户重发。
 * 这是有意简化 —— 少一份 base64 就少一处 PII 副本，也少一次 OSS 备份依赖。
 */

import { Router } from 'express';
import { getDB } from '../config/db.js';
import { sendContactMail, isMailConfigured } from '../services/mail.js';

const router = Router();

const MAX_MESSAGE = 2000;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 400 * 1024;
const CONTACT_RETENTION_DAYS = Number(process.env.CONTACT_RETENTION_DAYS) > 0
  ? Number(process.env.CONTACT_RETENTION_DAYS)
  : 365;

router.post('/', async (req, res) => {
  const body = req.body || {};

  const message = String(body.message || '').trim();
  if (!message) return res.status(400).json({ error: '请填写留言内容' });
  if (message.length > MAX_MESSAGE) return res.status(400).json({ error: `留言不超过 ${MAX_MESSAGE} 字` });

  const replyEmail = String(body.replyEmail || '').trim().slice(0, 120);
  const clientId = String(body.clientId || 'anonymous').slice(0, 64);
  const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];

  // 只校验格式与体积，不保留正文
  const imagesMeta = [];
  for (const img of images) {
    const data = String(img?.data || '');
    if (!data.startsWith('data:image/')) return res.status(400).json({ error: '图片格式无效' });
    const base64 = data.split(',')[1] || '';
    const bytes = Math.ceil((base64.length * 3) / 4);
    if (bytes > MAX_IMAGE_BYTES) return res.status(400).json({ error: `单张图片不超过 ${MAX_IMAGE_BYTES / 1024}KB` });
    imagesMeta.push({
      name: String(img?.name || 'image').slice(0, 80),
      type: String(img?.type || 'image/jpeg').slice(0, 40),
      bytes,
    });
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const record = {
    id,
    to: 'qtvq@qtvq.cn',
    message,
    replyEmail: replyEmail || null,
    clientId,
    images: imagesMeta,
    createdAt: new Date().toISOString(),
  };

  // ① 境内 Mongo（失败就不再往下走：留言必须先落地）
  let stored = false;
  try {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CONTACT_RETENTION_DAYS * 24 * 3600 * 1000);
    await getDB()
      .collection('contact_messages')
      .updateOne(
        { id: record.id },
        { $set: { ...record, expiresAt }, $setOnInsert: { receivedAt: now } },
        { upsert: true },
      );
    stored = true;
  } catch (err) {
    console.error('[contact] 落库失败：', err?.message || err);
    return res.status(500).json({ error: '留言保存失败，请稍后重试或直接发邮件至 qtvq@qtvq.cn' });
  }

  /*
   * ② 通知邮件：**不阻塞响应**。
   *
   * 实测（2026-10-26）：SMTP 发一封约 1–1.5 秒。若同步等待，留言提交的 P50 会从
   * 几十毫秒涨到 1.5 秒 —— 用户等的是"提交完成"，不是"邮件发完"。
   * 留言此时已经落库（客服在运营台一定能看到），邮件只是提醒，所以放后台发。
   *
   * 代价：响应里无法立刻告诉用户"邮件发成功没有"。文案相应改为"已提交"，
   * 不再承诺"已发送至邮箱"（承诺了却没发出去才是更糟的体验）。
   */
  const mailConfigured = isMailConfigured();
  if (mailConfigured) {
    setImmediate(() => {
      sendContactMail(record)
        .then(async (r) => {
          if (r.ok) {
            await getDB()
              .collection('contact_messages')
              .updateOne({ id }, { $set: { emailSent: true, emailProvider: r.provider } })
              .catch(() => {});
          } else {
            await getDB()
              .collection('contact_messages')
              .updateOne({ id }, { $set: { emailSent: false, emailError: String(r.error || '').slice(0, 200) } })
              .catch(() => {});
          }
        })
        .catch((e) => console.error('[contact] 后台发信异常：', e?.message || e));
    });
  }

  const userMessage = mailConfigured
    ? '留言已提交，客服将尽快回复（也可直接发邮件至 qtvq@qtvq.cn）。'
    : '留言已保存，客服将在系统记录中查阅（邮件服务未配置）。';

  return res.json({
    ok: true,
    id,
    emailSent: mailConfigured ? null : false,
    mailQueued: mailConfigured,
    mailConfigured,
    message: userMessage,
    mailto: 'qtvq@qtvq.cn',
    storage: stored ? 'mongo-cn' : 'failed',
  });
});

export default router;
