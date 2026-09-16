/** API 请求：Cloudflare 优先，超时/失败时读阿里云 OSS 备份 */

import { apiUrl, BACKUP_ORIGIN, CROSS_ORIGIN } from './config.js';
import { DAILY_ASK_LIMIT, PLANS } from './quota.js';

/**
 * 主接口超时：生产走同源（qtvq.cn → nginx 反代 Pages），典型 1.6s，
 * 但上游偶发 9–14s，所以给 15s 预算，避免把"慢但能成"的请求误判为失败。
 */
const PRIMARY_TIMEOUT_MS = 15000;
/** 备接口超时：直连 Cloudflare Pages，国内常超时，只给 8s 试一次 */
const CROSS_ORIGIN_TIMEOUT_MS = 8000;
/** 语音识别 / 对话等较慢接口 */
const PATH_TIMEOUT_MS = {
  '/api/speech': 25000,
  '/api/chat': 20000,
};
const OFFLINE_QUEUE_KEY = 'qtvq_offline_queue';

const CHAT_FALLBACK = {
  reply:
    '【直线方案 · 备份模式】\n1. 当前 AI 服务繁忙或网络较慢，已启用本地备份答复。\n2. 请稍后刷新重试获取完整 AI 方案。\n3. 紧急问题可点页脚 qtvq@qtvq.cn 留言。',
  qCoins: 5,
  wisdom: 1,
  fallback: true,
  fallbackReason: 'OSS_BACKUP',
  followUpHint: '网络恢复后请重新提问',
};

function backupUrlForPath(path) {
  if (!BACKUP_ORIGIN) return null;
  const base = BACKUP_ORIGIN.replace(/\/$/, '');
  const u = new URL(path, 'https://local.invalid');

  if (u.pathname === '/api/payment') return `${base}/api/payment.json`;
  if (u.pathname === '/api/health') return `${base}/api/health.json`;

  if (u.pathname === '/api/quota') {
    const clientId = u.searchParams.get('clientId');
    if (clientId) return `${base}/kv/clients/${encodeURIComponent(clientId)}.json`;
    return `${base}/api/quota-default.json`;
  }
  return null;
}

async function fetchWithTimeout(url, options = {}, ms = PRIMARY_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function timeoutForPath(path) {
  try {
    const u = new URL(path, 'https://local.invalid');
    return PATH_TIMEOUT_MS[u.pathname] || PRIMARY_TIMEOUT_MS;
  } catch {
    return PRIMARY_TIMEOUT_MS;
  }
}

function normalizeQuotaBackup(json, clientId) {
  if (json.unlimited !== undefined && json.remaining !== undefined) {
    return { ...json, storage: json.storage || 'oss-backup', source: 'oss-backup' };
  }
  if (json.record) {
    const rec = json.record;
    const now = Date.now();
    const ts = (rec.timestamps || []).filter((t) => t > now - 24 * 60 * 60 * 1000);
    const unlimited = rec.subscription?.activeUntil > now;
    return {
      unlimited,
      used: ts.length,
      remaining: unlimited ? null : Math.max(0, DAILY_ASK_LIMIT - ts.length),
      limit: DAILY_ASK_LIMIT,
      resetAt: ts.length ? Math.min(...ts) + 24 * 60 * 60 * 1000 : null,
      subscription: rec.subscription,
      paymentPending: rec.paymentPending,
      plans: PLANS,
      storage: 'oss-backup',
      source: 'oss-backup',
      clientId,
    };
  }
  return json;
}

function fakeJsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function enqueueOffline(path, bodyObj) {
  try {
    const q = JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]');
    q.push({ path, body: bodyObj, at: Date.now() });
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(q.slice(-20)));
  } catch {
    /* ignore */
  }
}

export async function flushOfflineQueue() {
  let q;
  try {
    q = JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]');
  } catch {
    return;
  }
  if (!q.length) return;

  const remain = [];
  for (const item of q) {
    try {
      const res = await fetchWithTimeout(apiUrl(item.path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item.body),
      });
      if (!res.ok) remain.push(item);
    } catch {
      remain.push(item);
    }
  }
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(remain));
}

/** @param {string} path 如 /api/quota?clientId=xxx */
export async function apiFetch(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const primary = apiUrl(path);
  const headers = { ...(options.headers || {}) };
  try {
    const token = localStorage.getItem('qtvq_auth_token');
    if (token && !headers.Authorization) headers.Authorization = `Bearer ${token}`;
  } catch {
    /* ignore */
  }
  const reqOptions = { ...options, headers };

  try {
    const res = await fetchWithTimeout(primary, reqOptions, timeoutForPath(path));
    if (res.ok || method !== 'GET') return res;
  } catch {
    if (method !== 'GET') {
      /* 写入失败走离线队列 */
    }
  }

  if (method === 'GET') {
    // 主接口与备接口互为 failover：
    //   主 = 同源（qtvq.cn → nginx 反代 Pages），实测典型 1.6s；
    //   备 = 直连 Cloudflare Pages，国内偶尔 8–14s 甚至直接失败。
    // 两条都失败才读阿里云 OSS 备份（最后一道，要求桶里 backup/api 前缀为公共读）。
    // 2026-09-16 线上正是因为这条链缺了中间一段、且 OSS 兜底是私有的 403，
    // 才在点「微信在线支付」时直接抛「API 不可用且无备份」。
    const alt = primary.startsWith(CROSS_ORIGIN)
      ? (typeof location !== 'undefined' && location.origin ? `${location.origin}${path}` : null)
      : `${CROSS_ORIGIN}${path}`;
    if (alt) {
      const altTimeout = alt.startsWith(CROSS_ORIGIN) ? CROSS_ORIGIN_TIMEOUT_MS : PRIMARY_TIMEOUT_MS;
      try {
        const res = await fetchWithTimeout(alt, { method: 'GET', headers }, altTimeout);
        if (res.ok) return res;
      } catch {
        /* 备接口也失败，继续走 OSS 备份 */
      }
    }

    const backup = backupUrlForPath(path);
    if (backup) {
      try {
        const res = await fetchWithTimeout(backup, { method: 'GET' }, 12000);
        if (res.ok) {
          const data = await res.json();
          const u = new URL(path, 'https://local.invalid');
          if (u.pathname === '/api/quota') {
            const clientId = u.searchParams.get('clientId');
            return fakeJsonResponse(normalizeQuotaBackup(data, clientId));
          }
          return fakeJsonResponse(data);
        }
      } catch {
        /* fall through */
      }
    }
    throw new Error('API 不可用且无备份');
  }

  if (path.startsWith('/api/chat')) {
    let body;
    try {
      body = options.body ? JSON.parse(options.body) : {};
    } catch {
      body = {};
    }
    return fakeJsonResponse({
      ...CHAT_FALLBACK,
      quota: null,
      message: body.message,
    });
  }

  if (path.startsWith('/api/payment') || path.startsWith('/api/contact') || path.startsWith('/api/quota')) {
    let body;
    try {
      body = options.body ? JSON.parse(options.body) : {};
    } catch {
      body = {};
    }
    enqueueOffline(path, body);
    return fakeJsonResponse({
      ok: true,
      offline: true,
      message: '主 API 暂不可用，信息已本地暂存，恢复后将自动同步',
      fallback: true,
    });
  }

  throw new Error('API 不可用');
}
