/**
 * 短信验证码：发送 + 校验（用于「找回密码」）
 *
 * 设计取舍：
 * - **不暴露手机号是否已注册**：无论是否存在，对外都返回同一句话（防枚举）。
 * - 验证码只存**哈希**，不存明文；5 分钟有效；最多试 5 次；用过即失效。
 * - 三重节流（同一号码 60 秒内一次 / 每天 10 条 / 同一 IP 每小时 20 条），
 *   避免被人拿去当短信轰炸机（短信是真花钱的：约 ¥0.045/条）。
 */

import { corsPreflight, jsonResponse } from '../../lib/http.js';
import { sendVerifyCodeSms, isSmsConfigured } from '../../lib/aliyun-sms.js';
import { adminResetPassword } from '../../lib/auth-store.js';

const CODE_TTL_SECONDS = 300;
const COOLDOWN_SECONDS = 60;
const PER_PHONE_DAILY = 10;
const PER_IP_HOURLY = 20;
const MAX_TRIES = 5;

const PHONE_RE = /^1[3-9]\d{9}$/;

function getKv(env) {
  return env?.QTVQ_KV || null;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function todayKey() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function hourKey() {
  return new Date().toISOString().slice(0, 13).replace(/[-T]/g, '');
}

/** KV 计数器：读到值 +1 写回；不存在则写 1 */
async function bumpCounter(kv, key, ttlSeconds) {
  const cur = Number(await kv.get(key)) || 0;
  const next = cur + 1;
  await kv.put(key, String(next), { expirationTtl: ttlSeconds });
  return next;
}

function clientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Real-IP') ||
    (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() ||
    'unknown'
  );
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsPreflight(request);
  if (request.method !== 'POST') return jsonResponse(request, { error: 'Method not allowed' }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, { error: '无效 JSON' }, 400);
  }

  const { action, phone, code, newPassword } = body;

  if (action === 'status') {
    // 前端用它决定是否展示短信找回入口（未配置时不展示，避免点了没反应）
    return jsonResponse(request, { ok: true, smsConfigured: isSmsConfigured(env) });
  }

  if (!PHONE_RE.test(String(phone || ''))) {
    return jsonResponse(request, { error: '请输入正确的 11 位手机号' }, 400);
  }

  const kv = getKv(env);
  if (!kv) return jsonResponse(request, { error: '服务暂不可用（存储未绑定）' }, 503);

  // ── 发送验证码 ──
  if (action === 'send') {
    if (!isSmsConfigured(env)) {
      return jsonResponse(request, { error: '短信服务尚未配置，请改用微信扫码找回' }, 503);
    }

    const cooldownKey = `sms:cd:${phone}`;
    if (await kv.get(cooldownKey)) {
      return jsonResponse(request, { error: `请求过于频繁，请 ${COOLDOWN_SECONDS} 秒后再试` }, 429);
    }

    const dayCount = Number(await kv.get(`sms:day:${phone}:${todayKey()}`)) || 0;
    if (dayCount >= PER_PHONE_DAILY) {
      return jsonResponse(request, { error: '该手机号今日验证码次数已达上限，请明日再试' }, 429);
    }

    const ipCount = Number(await kv.get(`sms:ip:${clientIp(request)}:${hourKey()}`)) || 0;
    if (ipCount >= PER_IP_HOURLY) {
      return jsonResponse(request, { error: '请求过于频繁，请稍后再试' }, 429);
    }

    const code6 = String(Math.floor(100000 + Math.random() * 900000));
    const result = await sendVerifyCodeSms(env, { phone, code: code6 });
    if (!result.ok) {
      console.error('[sms] 发送失败：', result.error);
      // 把实际使用的签名/模板带出来：SMS_SIGNATURE_ILLEGAL 时最需要知道"线上到底是哪个签名"
      // （曾经因为 PowerShell 管道把中文变成 ??? 而签名不合法，排查时正是靠这个细节定位的）
      const cfg = { signName: env.SMS_SIGN_NAME || '', templateCode: env.SMS_TEMPLATE_CODE || '' };
      return jsonResponse(
        request,
        {
          error: '验证码发送失败，请稍后再试或改用微信扫码找回',
          detail: result.error,
          smsConfig: cfg,
        },
        502,
      );
    }

    await kv.put(
      `sms:code:${phone}`,
      JSON.stringify({ h: await sha256Hex(`${phone}:${code6}`), exp: Date.now() + CODE_TTL_SECONDS * 1000, tries: 0 }),
      { expirationTtl: CODE_TTL_SECONDS },
    );
    await kv.put(cooldownKey, '1', { expirationTtl: COOLDOWN_SECONDS });
    await bumpCounter(kv, `sms:day:${phone}:${todayKey()}`, 86400);
    await bumpCounter(kv, `sms:ip:${clientIp(request)}:${hourKey()}`, 3600);

    // 不暴露该手机号是否存在
    return jsonResponse(request, {
      ok: true,
      message: `若该手机号已注册，验证码已发送，${CODE_TTL_SECONDS / 60} 分钟内有效`,
    });
  }

  // ── 校验验证码并重置密码 ──
  if (action === 'reset') {
    if (!/^\d{6}$/.test(String(code || ''))) {
      return jsonResponse(request, { error: '请输入 6 位验证码' }, 400);
    }
    if (!newPassword || String(newPassword).length < 6) {
      return jsonResponse(request, { error: '新密码至少 6 位' }, 400);
    }

    const key = `sms:code:${phone}`;
    const raw = await kv.get(key);
    if (!raw) return jsonResponse(request, { error: '验证码已过期，请重新获取' }, 400);

    let rec;
    try {
      rec = JSON.parse(raw);
    } catch {
      return jsonResponse(request, { error: '验证码状态异常，请重新获取' }, 400);
    }
    if (Date.now() > (rec.exp || 0)) {
      await kv.delete(key);
      return jsonResponse(request, { error: '验证码已过期，请重新获取' }, 400);
    }

    const tries = (rec.tries || 0) + 1;
    if (tries > MAX_TRIES) {
      await kv.delete(key);
      return jsonResponse(request, { error: '尝试次数过多，请重新获取验证码' }, 429);
    }

    const expect = await sha256Hex(`${phone}:${code}`);
    if (expect !== rec.h) {
      // 记一次失败尝试（保持原 TTL）
      await kv.put(key, JSON.stringify({ ...rec, tries }), { expirationTtl: CODE_TTL_SECONDS });
      return jsonResponse(request, { error: `验证码不正确（还可尝试 ${MAX_TRIES - tries} 次）` }, 400);
    }

    await kv.delete(key); // 用过即失效
    const reset = await adminResetPassword(env, { phone, newPassword });
    if (reset.error) return jsonResponse(request, { error: reset.error }, 400);
    return jsonResponse(request, { ok: true, message: '密码已重置，请用新密码登录' });
  }

  return jsonResponse(request, { error: '未知操作' }, 400);
}
