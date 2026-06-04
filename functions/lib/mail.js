/**
 * 联系客服邮件通知
 * 支持 SMTP（Cloudflare TCP connect，465 SSL）与 Resend HTTP API
 *
 * 环境变量见 docs/MAIL-SMTP.md
 */

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function encodeMimeHeader(str) {
  return `=?UTF-8?B?${utf8ToBase64(str)}?=`;
}

function wrapBase64Lines(b64) {
  return b64.replace(/.{1,76}/g, '$&\r\n').trim();
}

function mailConfig(env) {
  const provider = String(env.MAIL_PROVIDER || 'smtp').toLowerCase();
  const to = String(env.SMTP_TO || env.MAIL_TO || 'qtvq@qtvq.cn').trim();
  const from = String(env.SMTP_FROM || env.MAIL_FROM || env.SMTP_USER || 'qtvq@qtvq.cn').trim();

  if (provider === 'resend') {
    const apiKey = env.RESEND_API_KEY;
    if (!apiKey) return null;
    return { provider: 'resend', apiKey, from, to };
  }

  const host = String(env.SMTP_HOST || '').trim();
  const user = String(env.SMTP_USER || '').trim();
  const pass = String(env.SMTP_PASS || '').trim();
  if (!host || !user || !pass) return null;

  const port = Number(env.SMTP_PORT || 465);
  const secure = String(env.SMTP_SECURE || 'true').toLowerCase() !== 'false';
  return { provider: 'smtp', host, port, secure, user, pass, from, to };
}

export function isMailConfigured(env) {
  return !!mailConfig(env);
}

function buildContactPlainText(record) {
  const lines = [
    '【我心永恒 - Q问】用户留言',
    '',
    `留言 ID：${record.id}`,
    `时间：${record.createdAt}`,
    `设备编号：${record.clientId}`,
    record.replyEmail ? `回复邮箱：${record.replyEmail}` : '回复邮箱：（未填写）',
    '',
    '--- 留言内容 ---',
    record.message,
    '',
  ];
  if (record.images?.length) {
    lines.push(`附件：${record.images.length} 张图片（见邮件附件）`);
  }
  lines.push('', '— 本邮件由 qtvq.cn 联系表单自动发送');
  return lines.join('\r\n');
}

function buildMimeMessage({ from, to, replyTo, subject, text, attachments }) {
  const boundary = `----Qtvq${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  let mime = '';
  mime += `From: ${from}\r\n`;
  mime += `To: ${to}\r\n`;
  if (replyTo) mime += `Reply-To: ${replyTo}\r\n`;
  mime += `Subject: ${encodeMimeHeader(subject)}\r\n`;
  mime += `MIME-Version: 1.0\r\n`;
  mime += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;

  mime += `--${boundary}\r\n`;
  mime += `Content-Type: text/plain; charset=UTF-8\r\n`;
  mime += `Content-Transfer-Encoding: base64\r\n\r\n`;
  mime += `${wrapBase64Lines(utf8ToBase64(text))}\r\n\r\n`;

  for (const att of attachments || []) {
    const raw = String(att.data || '');
    const base64 = raw.includes(',') ? raw.split(',')[1] : raw;
    if (!base64) continue;
    const name = String(att.name || 'image.jpg').replace(/[\r\n"]/g, '');
    const type = String(att.type || 'application/octet-stream');
    mime += `--${boundary}\r\n`;
    mime += `Content-Type: ${type}; name="${name}"\r\n`;
    mime += `Content-Transfer-Encoding: base64\r\n`;
    mime += `Content-Disposition: attachment; filename="${name}"\r\n\r\n`;
    mime += `${wrapBase64Lines(base64)}\r\n\r\n`;
  }

  mime += `--${boundary}--\r\n`;
  return mime;
}

async function readSmtpResponse(reader) {
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\r\n').filter((l) => l.length > 0);
    if (!lines.length) continue;
    const last = lines[lines.length - 1];
    if (/^\d{3} /.test(last)) {
      const code = Number(last.slice(0, 3));
      return { code, raw: buf };
    }
  }
  throw new Error('SMTP 连接意外关闭');
}

async function smtpWrite(writer, data) {
  await writer.write(new TextEncoder().encode(data));
}

async function smtpExpect(reader, codes, step) {
  const res = await readSmtpResponse(reader);
  if (!codes.includes(res.code)) {
    throw new Error(`${step} 失败 (${res.code}): ${res.raw.trim()}`);
  }
  return res;
}

async function smtpDialog(writer, reader, cmd, expectCodes, step) {
  if (cmd) await smtpWrite(writer, `${cmd}\r\n`);
  return smtpExpect(reader, expectCodes, step);
}

async function sendViaSmtp(cfg, { subject, text, replyTo, attachments }) {
  let connectFn;
  try {
    ({ connect: connectFn } = await import('cloudflare:sockets'));
  } catch {
    throw new Error('当前环境不支持 SMTP 连接（需 Cloudflare Workers TCP）');
  }

  if (!cfg.secure || cfg.port !== 465) {
    throw new Error('当前仅支持 SMTP 465 + SSL，请设置 SMTP_PORT=465 SMTP_SECURE=true');
  }

  const socket = connectFn(
    { hostname: cfg.host, port: cfg.port },
    { secureTransport: 'on', allowHalfOpen: false }
  );
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();

  try {
    await smtpExpect(reader, [220], 'SMTP 握手');
    await smtpDialog(writer, reader, `EHLO qtvq.cn`, [250], 'EHLO');

    await smtpDialog(writer, reader, 'AUTH LOGIN', [334], 'AUTH LOGIN');
    await smtpDialog(writer, reader, utf8ToBase64(cfg.user), [334], 'SMTP 用户名');
    await smtpDialog(writer, reader, utf8ToBase64(cfg.pass), [235], 'SMTP 密码');

    await smtpDialog(writer, reader, `MAIL FROM:<${cfg.from}>`, [250], 'MAIL FROM');
    await smtpDialog(writer, reader, `RCPT TO:<${cfg.to}>`, [250, 251], 'RCPT TO');
    await smtpDialog(writer, reader, 'DATA', [354], 'DATA');

    const mime = buildMimeMessage({
      from: cfg.from,
      to: cfg.to,
      replyTo,
      subject,
      text,
      attachments,
    });
    await smtpWrite(writer, `${mime}\r\n.\r\n`);
    await smtpExpect(reader, [250], '邮件正文');

    try {
      await smtpDialog(writer, reader, 'QUIT', [221], 'QUIT');
    } catch {
      /* ignore */
    }
  } finally {
    try {
      writer.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  }

  return { ok: true, provider: 'smtp' };
}

async function sendViaResend(cfg, { subject, text, replyTo, attachments }) {
  const payload = {
    from: cfg.from,
    to: [cfg.to],
    subject,
    text,
  };
  if (replyTo) payload.reply_to = replyTo;
  if (attachments?.length) {
    payload.attachments = attachments
      .map((att) => {
        const raw = String(att.data || '');
        const content = raw.includes(',') ? raw.split(',')[1] : raw;
        if (!content) return null;
        return {
          filename: String(att.name || 'image.jpg'),
          content,
        };
      })
      .filter(Boolean);
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.error || `Resend HTTP ${res.status}`);
  }
  return { ok: true, provider: 'resend', id: data.id };
}

/**
 * @param {Record<string, string>} env
 * @param {{ id: string, message: string, replyEmail?: string|null, clientId: string, images?: Array, createdAt: string }} record
 */
export async function sendContactMail(env, record) {
  const cfg = mailConfig(env);
  if (!cfg) {
    return { ok: false, skipped: true, reason: 'mail_not_configured' };
  }

  const subject = `[Q问留言] ${record.message.slice(0, 40)}${record.message.length > 40 ? '…' : ''}`;
  const text = buildContactPlainText(record);
  const replyTo = record.replyEmail || undefined;
  const attachments = record.images || [];

  const timeoutMs = 20000;
  const sendPromise =
    cfg.provider === 'resend'
      ? sendViaResend(cfg, { subject, text, replyTo, attachments })
      : sendViaSmtp(cfg, { subject, text, replyTo, attachments });

  try {
    const result = await Promise.race([
      sendPromise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('邮件发送超时')), timeoutMs);
      }),
    ]);
    return result;
  } catch (err) {
    return { ok: false, error: err.message || String(err), provider: cfg.provider };
  }
}
