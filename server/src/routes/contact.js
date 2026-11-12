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

import crypto from 'node:crypto';
import { Router } from 'express';
import { getDB } from '../config/db.js';
import { requireAuth } from '../middleware/auth.js';
import { wrap } from '../lib/http.js';
import { sendContactMail, isMailConfigured } from '../services/mail.js';
import { assertSafe } from '../services/content-safety.js';

const router = Router();

const MAX_MESSAGE = 2000;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 400 * 1024;
const CONTACT_RETENTION_DAYS = Number(process.env.CONTACT_RETENTION_DAYS) > 0
  ? Number(process.env.CONTACT_RETENTION_DAYS)
  : 365;

router.post('/', wrap(async (req, res) => {
  const body = req.body || {};

  const message = String(body.message || '').trim();
  if (!message) return res.status(400).json({ error: '请填写留言内容' });
  if (message.length > MAX_MESSAGE) return res.status(400).json({ error: `留言不超过 ${MAX_MESSAGE} 字` });

  // 内容安全（E.77）：留言是自由文本 UGC，与 chat/profile 同一条审核线（本地词表必过，
  // 阿里云绿网外部服务降级为待复核）。命中阻断类直接 400，不入库不进邮件。
  await assertSafe(message, { field: 'contact', label: '客服留言' });

  const replyEmail = String(body.replyEmail || '').trim().slice(0, 120);
  const clientId = String(body.clientId || 'anonymous').slice(0, 64);
  const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];

  /* 幂等窗口（E.86）：60 秒内同 clientId + 同内容视为同一提交。
   * 为什么在服务端：前端已有提交中禁用，但网络重试风暴、脚本直打仍会产生
   * 重复留言+重复告警邮件。命中窗口直接返回首次结果（对用户表现为成功，
   * 不产生第二条记录与第二封邮件）。
   * 位置教训：此块必须放在 clientId 声明**之后**——E.86 首版插在其前面，
   * ReferenceError 让 Express 4 async handler 崩掉进程（systemd restart 循环+502）。 */
  const dedupKey = crypto
    .createHash('sha256')
    .update(`${clientId}|${message}`)
    .digest('hex')
    .slice(0, 32);
  const recent = await getDB().collection('contact_messages').findOne({
    clientId,
    dedupKey,
    createdAt: { $gte: new Date(Date.now() - 60_000).toISOString() }, // record.createdAt 为 ISO 字符串
  });
  if (recent) {
    return res.json({
      ok: true,
      id: recent.id,
      duplicate: true,
      message: '留言已提交（请勿重复发送）。',
    });
  }

  const imagesMeta = [];
  const imageChecks = [];
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
    imageChecks.push(data);
  }

  /* 图片内容审核（E.89）：并行审至多 4 张，block 级直接 400；
   * 外部服务异常/未开通时与文字层同语义——标记待复核，不阻塞留言。
   * 单张超时 6s，Promise.all 并行，最坏 6s。 */
  if (imageChecks.length) {
    let imageReview = 'passed';
    try {
      const results = await Promise.all(
        imageChecks.map((d) =>
          greenImageCheckByBase64(d)
            .then((r) => (r.blocked ? 'blocked' : 'passed'))
            .catch((err) => {
              console.error('[contact] 图片审核失败（待复核）：', err?.message?.slice(0, 80));
              return 'degraded';
            }),
        ),
      );
      if (results.includes('blocked')) {
        return res.status(400).json({ error: '图片包含不允许的内容，请更换后重试', code: 'E_IMAGE_BLOCKED' });
      }
      if (results.includes('degraded')) imageReview = 'degraded';
    } catch (err) {
      imageReview = 'degraded';
      console.error('[contact] 图片审核异常（待复核）：', err?.message?.slice(0, 80));
    }
    var __imageReview = imageReview;
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const record = {
    id,
    dedupKey,
    imageReview: typeof __imageReview !== 'undefined' ? __imageReview : (images.length ? 'degraded' : 'none'),
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
}));

/* ─────────────────────────── 联系方式二次限流（E.78） ───────────────────────────
 *
 * 为什么邮箱要遮蔽 + 登录后查看：页脚/帮助页的明文邮箱是爬虫收割的头号目标
 * （收割一次 → 垃圾邮件/撞库信件轰炸）。全站 HTML 源码已去除明文（法务文本除外），
 * 完整地址只经由本接口发放，且：
 *   · 必须登录（requireAuth）—— 匿名爬虫拿不到；
 *   · 每账号每日 5 次 —— 批量脚本的成本高于收益；
 *   · 每次查看落审计（uid/clientId/ip/UA）—— 泄漏可回溯到具体账号与时间窗；
 *   · 另有蜜罐地址埋在页面源码（trap-*@qtvq.cn，每页唯一），发信即可定位泄漏页。
 */
const CONTACT_EMAIL = 'qtvq@qtvq.cn';
const CONTACT_REVEAL_DAILY_LIMIT = Number(process.env.CONTACT_REVEAL_DAILY_LIMIT) > 0
  ? Number(process.env.CONTACT_REVEAL_DAILY_LIMIT)
  : 5;

router.post(
  '/reveal',
  requireAuth,
  async (req, res) => {
    try {
      const uid = req.uid;
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const db = getDB();
      const used = await db
        .collection('contact_reveals')
        .countDocuments({ uid, at: { $gte: dayStart } });
      if (used >= CONTACT_REVEAL_DAILY_LIMIT) {
        return res.status(429).json({
          error: `今日查看次数已用完（每日 ${CONTACT_REVEAL_DAILY_LIMIT} 次）`,
          code: 'E_REVEAL_LIMIT',
        });
      }
      await db.collection('contact_reveals').insertOne({
        uid,
        clientId: String(req.body?.clientId || '').slice(0, 64) || null,
        ip: String(req.headers['x-real-ip'] || req.socket?.remoteAddress || '').slice(0, 64),
        ua: String(req.headers['user-agent'] || '').slice(0, 120),
        at: new Date(),
      });
      return res.json({
        ok: true,
        email: CONTACT_EMAIL,
        remaining: CONTACT_REVEAL_DAILY_LIMIT - used - 1,
      });
    } catch (err) {
      console.error('[contact] reveal 失败：', err?.message || err);
      return res.status(500).json({ error: '查看失败，请稍后重试' });
    }
  },
);

export default router;
