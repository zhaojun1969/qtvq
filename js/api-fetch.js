/** API 请求：Cloudflare 优先，超时/失败时读阿里云 OSS 备份 */

import { apiUrl, BACKUP_ORIGIN, CROSS_ORIGIN, DIRECT_CANDIDATES, PROBE_MAX_MS, setDirectOrigin } from './config.js';
/*
 * 探测直连 Pages 的候选源站，决定**下次页面加载**走哪条主路径。
 *
 * 为什么不在本次加载就用：API_ORIGIN 在模块加载时同步求值，而探测是异步的。
 * 「本次探测、下次生效」换来零闪烁；失败时天然退回同源。
 *
 * 两个候选并行探测，取「成功且最快」且 <1500ms 的那个：
 *   · api.qtvq.cn       —— 理想形态，依赖一条 DNS 记录（可能尚未就绪）；
 *   · qtvq-api.pages.dev —— 不需要任何 DNS 改动，今天就能绕开 ECS 中转。
 * 实测客户端直连 pages.dev 约 0.94s，而同源路径（经 ECS 中转）2.9s —— 慢的一直是 ECS↔Pages 那段。
 */
let directProbeStarted = false;
export function probeDirectOrigin() {
  if (directProbeStarted || typeof location === 'undefined' || !location.origin) return;
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;
  directProbeStarted = true;

  const probe = (origin) =>
    new Promise((resolve) => {
      const started = Date.now();
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 2500) : null;
      fetch(`${origin}/api/health`, { method: 'GET', signal: ctrl ? ctrl.signal : undefined })
        .then((res) => resolve(res.ok ? { origin, ms: Date.now() - started } : null))
        .catch(() => resolve(null))
        .finally(() => {
          if (timer) clearTimeout(timer);
        });
    });

  /*
   * 三方同场竞速：api.qtvq.cn / pages.dev / 同源，取最快的一个。
   * 让同源也参与，是为了在网络好的时候**不要把用户从快的路径切到慢的路径**；
   * 选到同源就等于"不切换"（setDirectOrigin('')）。
   */
  const sameOrigin = location.origin;
  const candidates = [...DIRECT_CANDIDATES, sameOrigin];
  Promise.all(candidates.map(probe)).then((results) => {
    const usable = results.filter(Boolean).sort((a, b) => a.ms - b.ms);
    const best = usable[0];
    if (!best || best.ms > PROBE_MAX_MS || best.origin === sameOrigin) setDirectOrigin('');
    else setDirectOrigin(best.origin);
  });
}import { DAILY_ASK_LIMIT, PLANS } from './quota.js';

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
    // 主接口与备接口互为 failover。候选顺序按"能不用 Cloudflare 中转就不用"：
    //   同源（qtvq.cn → nginx 反代 Pages）：现状，实测典型 1.6s 但也可能被跨太平洋链路拖到数秒；
    //   独立域名（api.qtvq.cn → 直连 Pages）：只剩一跳，但依赖 DNS；
    //   pages.dev：国内常超时，仅作最后的外部尝试。
    // 三选二的思路：**除了 primary 本身，其余两个都试**，这样无论 API_ORIGIN 指向哪一个，
    // 都还有同源与 pages.dev 两条退路（2026-09-16 事故就是链条缺了一段才报"API 不可用且无备份"）。
    const originOf = (u) => {
      try {
        return new URL(u, typeof location !== 'undefined' ? location.href : 'https://local.invalid').origin;
      } catch {
        return '';
      }
    };
    const pageOrigin = typeof location !== 'undefined' && location.origin ? location.origin : '';
    const primaryOrigin = originOf(path);
    const alts = [];
    if (pageOrigin && primaryOrigin !== pageOrigin) alts.push(`${pageOrigin}${path}`);
    if (primaryOrigin !== CROSS_ORIGIN) alts.push(`${CROSS_ORIGIN}${path}`);

    for (const alt of alts) {
      const altTimeout = alt.startsWith(CROSS_ORIGIN) ? CROSS_ORIGIN_TIMEOUT_MS : PRIMARY_TIMEOUT_MS;
      try {
        const res = await fetchWithTimeout(alt, { method: 'GET', headers }, altTimeout);
        if (res.ok) return res;
      } catch {
        /* 这个备选也失败，继续下一个 */
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
