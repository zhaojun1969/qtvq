/**
 * 运维告警入口：`POST /api/ops/alert`
 *
 * 用途：服务器上的防护脚本（nginx 滥用统计、fail2ban 等）发现异常时，
 * 调这个接口把告警邮件发给运营。
 *
 * ## 为什么不在服务器上直接发邮件
 * 实测：ECS 上**没有 SMTP 配置、也没有 mail/msmtp/sendmail**（`which mail msmtp sendmail` → NONE）。
 * 而 SMTP 凭据已在 Cloudflare Pages 的环境变量里、邮件库也现成（`lib/mail.js`）。
 * 与其在服务器上再配一套邮件出口（多一处密钥、多一处可能失效的链路），
 * 不如复用已验证可用的那条 —— 而且运营收件人只需要维护一处。
 *
 * ## 鉴权与防滥用
 *   · 必须带 `X-Admin-Key`（优先 `OPS_ALERT_KEY`，未配置时回落到 `PAYMENT_ADMIN_KEY`）；
 *   · 未配置任何 key 时**直接 404**（与运营台同一策略：不暴露接口是否存在）；
 *   · subject/text 长度截断，避免被拿来当大文件投递通道；
 *   · 邮件正文强制带来源标记，便于与真实客户邮件区分。
 *
 * 调用方（服务器上的脚本）：
 *   curl -sS -X POST https://qtvq.cn/api/ops/alert \
 *     -H "Content-Type: application/json" -H "X-Admin-Key: $KEY" \
 *     -d '{"subject":"[Q问告警] nginx 429/444 突增","text":"最近5分钟 429=120 444=80"}'
 */
import { jsonResponse } from '../../lib/http.js';
import { isMailConfigured, sendNoticeMail } from '../../lib/mail.js';

/** 最大长度：告警只需要几十个字，不给人当文件通道用 */
const MAX_SUBJECT = 120;
const MAX_TEXT = 2000;

function resolveKey(env) {
  return String(env.OPS_ALERT_KEY || env.PAYMENT_ADMIN_KEY || '').trim();
}

function clip(v, n) {
  const s = typeof v === 'string' ? v : '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const expected = resolveKey(env);
  // 没配 key 就当这个接口不存在（返回 404 而不是 401，与运营台一致，避免暴露存在性）
  if (!expected) {
    return jsonResponse(request, { error: 'Not Found' }, 404);
  }
  const provided = request.headers.get('X-Admin-Key') || '';
  if (provided !== expected) {
    return jsonResponse(request, { error: 'unauthorized' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, { error: '无效 JSON' }, 400);
  }

  const subject = clip(body?.subject, MAX_SUBJECT) || '[Q问告警] 未命名告警';
  const text = clip(body?.text, MAX_TEXT) || '(无正文)';

  if (!isMailConfigured(env)) {
    // 邮件没配不是"成功"：如实返回，让脚本可以在日志里体现出来（否则告警静默丢失）
    return jsonResponse(request, { ok: false, error: '邮件未配置，告警未发出', mailConfigured: false }, 503);
  }

  const result = await sendNoticeMail(env, {
    subject,
    text:
      `${text}\n\n` +
      '——\n' +
      `来源：服务器防护脚本（${request.headers.get('CF-Connecting-IP') || 'unknown'}）\n` +
      `时间：${new Date().toISOString()}\n` +
      '处理建议：先看 /var/log/nginx/qtvq-abuse.log 与 fail2ban-client status qtvq-nginx。',
  });

  // sendNoticeMail 刻意不抛异常（邮件失败绝不能影响主流程），这里把它转成 HTTP 状态，
  // 以便调用脚本能重试或至少在日志里留痕 —— 告警链路本身静默失败是最坏的情况。
  return jsonResponse(request, { ok: !!result?.ok, result }, result?.ok ? 200 : 502);
}

export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return jsonResponse(context.request, { error: 'Method Not Allowed' }, 405);
}
