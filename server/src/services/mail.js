/**
 * 通知邮件（2026-10-26）
 *
 * Node 侧此前没有任何发邮件能力，导致 `/api/contact`（留言）与
 * `/api/payment`（提交付款核实）这类"必须通知客服"的接口只能留在 Pages 上，
 * 用户提交一次就要跨境 700ms+。
 *
 * ── 实现选择 ──────────────────────────────────────────────────────────────
 * 服务器 `.env` 里已有 `SMTP_HOST/SMTP_USER/SMTP_PASS/SMTP_FROM/SMTP_TO`，
 * 但没有 `nodemailer`。这里**不加依赖**，用 Node 自带的 `node:tls` 直接说 SMTP：
 * `EHLO → AUTH LOGIN → MAIL FROM → RCPT TO → DATA → QUIT`。
 * 只支持 465 端口隐式 TLS（与现有 SMTP 配置一致）。
 *
 * ── 失败语义 ──────────────────────────────────────────────────────────────
 * **永不抛异常**，只返回 `{ ok, skipped, provider, error }`：
 * 邮件发不出去不应该让用户的留言/付款登记丢失 —— 那些已经落库，
 * 客服仍能在运营台看到。这与 Pages 侧 `mail.js` 的约定一致。
 */

import tls from 'node:tls';

const SMTP_TIMEOUT_MS = Number(process.env.SMTP_TIMEOUT_MS) > 0 ? Number(process.env.SMTP_TIMEOUT_MS) : 15000;

function smtpConfig() {
  const host = String(process.env.SMTP_HOST || '').trim();
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '').trim();
  if (!host || !user || !pass) return null;
  return {
    host,
    port: Number(process.env.SMTP_PORT || 465),
    user,
    pass,
    from: String(process.env.SMTP_FROM || process.env.SMTP_USER || 'qtvq@qtvq.cn').trim(),
    to: String(process.env.SMTP_TO || 'qtvq@qtvq.cn').trim(),
  };
}

export function isMailConfigured() {
  return smtpConfig() !== null;
}

/** 按 SMTP 多行响应规则读完一个响应（"250-STARTTLS" 这类续行） */
function readResponse(socket, buffer) {
  return new Promise((resolve, reject) => {
    let acc = buffer.value;
    const onData = (chunk) => {
      acc += chunk.toString('utf8');
      // 响应最后一行形如 "250 xxx"（第 4 个字符是空格，而不是 '-'）
      const lines = acc.split(/\r?\n/).filter((l) => l.length > 0);
      const last = lines[lines.length - 1] || '';
      if (/^\d{3} /.test(last)) {
        cleanup();
        buffer.value = '';
        resolve({ code: Number(last.slice(0, 3)), text: acc });
      } else {
        buffer.value = acc;
      }
    };
    const onErr = (err) => {
      cleanup();
      reject(err);
    };
    function cleanup() {
      socket.off('data', onData);
      socket.off('error', onErr);
    }
    socket.on('data', onData);
    socket.on('error', onErr);
  });
}

/**
 * 发送一封纯文本邮件。
 * @returns {Promise<{ok:boolean, skipped?:boolean, provider?:string, error?:string}>}
 */
export async function sendMail({ subject, text }) {
  const cfg = smtpConfig();
  if (!cfg) return { ok: false, skipped: true, error: 'SMTP 未配置' };

  const buffer = { value: '' };
  let socket = null;
  try {
    socket = tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host, timeout: SMTP_TIMEOUT_MS });
    await new Promise((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
      socket.once('timeout', () => reject(new Error('SMTP 连接超时')));
    });

    const greet = await readResponse(socket, buffer);
    if (greet.code !== 220) throw new Error(`SMTP 问候异常：${greet.text.slice(0, 80)}`);

    const cmd = async (line, expect) => {
      socket.write(`${line}\r\n`);
      const r = await readResponse(socket, buffer);
      if (expect && !expect.includes(r.code)) throw new Error(`SMTP "${line.split(' ')[0]}" → ${r.text.slice(0, 80)}`);
      return r;
    };

    await cmd(`EHLO ${cfg.host}`, [250]);
    await cmd('AUTH LOGIN', [334]);
    await cmd(Buffer.from(cfg.user).toString('base64'), [334]);
    await cmd(Buffer.from(cfg.pass).toString('base64'), [235]);
    await cmd(`MAIL FROM:<${cfg.from}>`, [250]);
    await cmd(`RCPT TO:<${cfg.to}>`, [250, 251]);
    await cmd('DATA', [354]);

    const body = [
      `From: ${cfg.from}`,
      `To: ${cfg.to}`,
      `Subject: =?UTF-8?B?${Buffer.from(String(subject || 'Q问通知')).toString('base64')}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(String(text || '')).toString('base64').replace(/(.{76})/g, '$1\r\n'),
      '.',
    ].join('\r\n');
    socket.write(`${body}\r\n`);

    const done = await readResponse(socket, buffer);
    if (done.code !== 250) throw new Error(`SMTP 投递失败：${done.text.slice(0, 120)}`);

    try {
      socket.write('QUIT\r\n');
    } catch {
      /* 关连接失败无所谓 */
    }
    return { ok: true, provider: 'smtp' };
  } catch (err) {
    console.error('[mail] 发送失败：', err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  } finally {
    try {
      socket?.end();
    } catch {
      /* ignore */
    }
  }
}

/** 留言通知 */
export async function sendContactMail(record) {
  const lines = [
    '收到一条新的站内留言。',
    '',
    `时间：${record.createdAt || new Date().toISOString()}`,
    `设备：${record.clientId || '未知'}`,
    `回信邮箱：${record.replyEmail || '（未填）'}`,
    record.images?.length ? `图片：${record.images.length} 张（见运营台）` : '图片：无',
    '',
    '内容：',
    String(record.message || '').slice(0, 2000),
    '',
    `记录 ID：${record.id}`,
  ];
  return sendMail({ subject: `【Q问留言】${String(record.message || '').slice(0, 30)}`, text: lines.join('\n') });
}

/** 付款/充值核实通知 */
export async function sendNoticeMail({ title, lines = [] }) {
  return sendMail({ subject: `【Q问通知】${String(title || '').slice(0, 60)}`, text: lines.join('\n') });
}
