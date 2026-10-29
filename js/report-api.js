/**
 * 配对报告服务客户端（路线B：Node + Express + MongoDB 新服务）
 *
 * 基址策略 —— **生产同源**：
 *   Nginx 在 qtvq.cn 上把 /v1/ 反代到 127.0.0.1:3000，所以 base 默认是空串（相对路径），
 *   既不需要跨域，也不会有 CORS 预检。本地 `python -m http.server 8080` 预览时指向本机 3000。
 *
 * 刻意不 import 任何站内模块：`js/auth.js` → `js/app.js` → `js/quota.js` 在模块顶层就会访问
 * localStorage / document，一旦引入本模块就无法在 Node 里做端到端测试。因此这里只复制一个
 * token key 常量（下方 TOKEN_KEY），并由 `server/scripts/e2e-frontend.mjs` 校验它与
 * `js/auth.js` 保持一致，避免悄悄漂移。
 */

/** 必须与 js/auth.js 的 TOKEN_KEY 一致（有测试守卫） */
export const TOKEN_KEY = 'qtvq_auth_token';
const BASE_OVERRIDE_KEY = 'qtvq_report_api_base';

function readStore(key) {
  try {
    const ls = globalThis.localStorage;
    return ls ? ls.getItem(key) : null;
  } catch {
    return null;
  }
}

export const REPORT_API_BASE = (() => {
  const injected = globalThis.__QTVQ_REPORT_API_BASE__;
  if (typeof injected === 'string') return injected.replace(/\/$/, '');

  const override = readStore(BASE_OVERRIDE_KEY);
  if (override) return String(override).replace(/\/$/, '');

  const loc = globalThis.location;
  if (!loc || !loc.hostname) return '';
  const { hostname, port } = loc;
  // 本地静态预览：静态站与 API 不同端口，必须显式指向
  if (port === '8080' || hostname === 'localhost' || hostname === '127.0.0.1') {
    return 'http://127.0.0.1:3000';
  }
  return '';
})();

export class ReportApiError extends Error {
  constructor(message, status = 0, code = null, extra = {}) {
    super(message);
    this.name = 'ReportApiError';
    this.status = status;
    this.code = code;
    this.safety = extra.safety || null;
    // 保留原始响应体：402 E_NEED_PAY 要拿 priceFen 才能显示"还差多少钱"。
    // `data` 是 report.js 已经在用的字段名，`body` 是更直白的别名，两个都留着。
    this.body = extra.body || null;
    this.data = extra.body || null;
  }
  /** 需要用户先登录 */
  get needLogin() {
    return this.status === 401;
  }
  /** 需要先完善自己的资料 */
  get needProfile() {
    return this.code === 'E_NEED_PROFILE';
  }
  /** 余额不足 */
  get needFunds() {
    return this.code === 'E_INSUFFICIENT_BALANCE';
  }
  /** 内容被安全策略拦下 */
  get blocked() {
    return this.code === 'E_CONTENT_BLOCKED';
  }
}

/** 生成报告要走一次大模型，30 秒以上是常态，别用默认的短超时 */
const DEFAULT_TIMEOUT_MS = 90000;

async function request(method, path, { body, token, timeoutMs = DEFAULT_TIMEOUT_MS, idempotencyKey } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
  const t = token === undefined ? readStore(TOKEN_KEY) : token;
  if (t) headers.Authorization = `Bearer ${t}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${REPORT_API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* 网关返回的非 JSON（例如 Nginx 502 页面） */
    }
    if (!res.ok) {
      /*
       * 错误码有两种写法，两种都要认：
       *   · 统一错误中间件：`{ code: <非 0 数字>, error, errorCode: 'E_XXX' }`
       *   · 路由里直接 res.json 的：`{ code: 'E_NEED_PAY', error, priceFen, ... }`（402 就是这种）
       * 之前只读 `errorCode`，导致 402 的 `err.code` 恒为 null，
       * 前端「需要支付」的分支永远进不去 —— 表现为点了生成只弹一句"请先完成支付"却没有价格。
       */
      const errCode = json?.errorCode || (typeof json?.code === 'string' ? json.code : null);
      throw new ReportApiError(json?.error || `请求失败（HTTP ${res.status}）`, res.status, errCode, {
        safety: json?.safety || null,
        body: json || null,
      });
    }
    return json && Object.prototype.hasOwnProperty.call(json, 'data') ? json.data : json;
  } catch (err) {
    if (err instanceof ReportApiError) throw err;
    if (err?.name === 'AbortError') throw new ReportApiError('请求超时，请稍后重试', 0, 'E_TIMEOUT');
    throw new ReportApiError(err?.message || '网络异常，请检查网络后重试', 0, 'E_NETWORK');
  } finally {
    clearTimeout(timer);
  }
}

/** 服务健康状态（不鉴权，用来判断后端是否已部署/可用） */
export function fetchReportHealth() {
  return request('GET', '/v1/health', { timeoutMs: 8000 });
}

/** 我的资料 */
export function fetchMyProfile() {
  return request('GET', '/v1/profile/me');
}

/**
 * 保存资料（部分更新）。改资料会触发服务端重算向量。
 * @param {{nickname?:string, gender?:'male'|'female', age?:number, city?:string,
 *          job?:string, height?:number, tags?:string[], intro?:string}} patch
 */
export function saveMyProfile(patch) {
  return request('PATCH', '/v1/profile/me', { body: patch });
}

/** 查看他人公开资料 */
export function fetchProfile(uid) {
  return request('GET', `/v1/profile/${encodeURIComponent(uid)}`);
}

/**
 * 生成配对报告
 *
 * 带 `idempotencyKey`：双击、网络重试、用户反复点「生成」都只会扣一次钱。
 * 服务端用唯一索引保证，不依赖前端「按钮禁用」这种不可靠的防重。
 * @param {{targetUid:string, tier:'basic'|'advanced'|'deep'|'soul', question?:string, idempotencyKey?:string}} params
 */
export function generateReport({ sku = 'pair', targetUid, tier = 'deep', question = '', payload = null, idempotencyKey }) {
  const key = idempotencyKey || newIdempotencyKey();
  const body = { sku, tier, question };
  // pair 之外的商品（diagnose/retro）不需要对方账号，改为自带输入；
  // 服务端 `reportPayload(kind, body)` 会按 kind 从 body 顶层读这些字段。
  if (targetUid) body.targetUid = targetUid;
  if (payload && typeof payload === 'object') Object.assign(body, payload);
  return request('POST', '/v1/report/generate', { body, idempotencyKey: key });
}

/**
 * 分享落地页用的公开摘要（无需登录）。
 *
 * 与 `fetchReport(id, {shareToken})` 的区别：这里**只有 token**，没有 reportId，
 * 且服务端不会返回对方资料快照与全文（见 `GET /v1/report/share/:token` 的注释）。
 */
export function fetchSharedReport(token) {
  return request('GET', `/v1/report/share/${encodeURIComponent(token)}`);
}

/**
 * 报告价目 + 我的额度（P1-T1.1）。
 * 返回 `{ skus, credits, introAvailable, billingOn }`，前端据此渲染价格表。
 */
export function fetchReportSkus() {
  return request('GET', '/v1/report/skus');
}
/** 生成一个幂等键（优先用 crypto.randomUUID） */
export function newIdempotencyKey() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    /* 回退 */
  }
  return `k_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 读取报告：本人可读；否则需带 shareToken */
export function fetchReport(reportId, { shareToken } = {}) {
  const qs = shareToken ? `?share=${encodeURIComponent(shareToken)}` : '';
  return request('GET', `/v1/report/${encodeURIComponent(reportId)}${qs}`);
}

/**
 * 等待异步报告生成完成（轮询 `GET /v1/report/:id`）。
 *
 * 背景（2026-10-26）：`POST /v1/report/generate` 已改为**异步**——
 * 先扣费并落 `pending` 文档、立刻返回 reportId，生成在后台跑。
 * 原因是模型调用最长 45 秒，同步返回等于让用户盯着转圈 45 秒且毫无反馈。
 *
 * 现在：POST 约 50–100ms 返回 `status: 'pending'` → 这里每秒半查一次 →
 * `ready` 就渲染，`failed` 抛错（服务端已退款）。
 *
 * @param {string} reportId
 * @param {{intervalMs?:number, timeoutMs?:number, shareToken?:string, onTick?:(elapsedMs:number)=>void}} opts
 */
export async function waitForReport(reportId, { intervalMs = 1500, timeoutMs = 120000, shareToken, onTick } = {}) {
  const started = Date.now();
  for (;;) {
    let report = null;
    try {
      report = await fetchReport(reportId, { shareToken });
    } catch (err) {
      // 网络抖动不要立刻失败：继续等，直到超时
      if (Date.now() - started > timeoutMs) throw err;
    }
    if (report && report.status && report.status !== 'pending') {
      if (report.status === 'failed') {
        const e = new Error(report.llmError || '报告生成失败（已退款），请稍后重试');
        e.reportFailed = true;
        throw e;
      }
      return report;
    }
    if (Date.now() - started > timeoutMs) {
      const e = new Error('报告生成时间较长，请稍后到「我的报告」里查看');
      e.reportTimeout = true;
      throw e;
    }
    if (typeof onTick === 'function') onTick(Date.now() - started);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
/** 我的报告列表 */
export function listMyReports(limit = 20) {
  return request('GET', `/v1/report/mine?limit=${encodeURIComponent(limit)}`);
}

/** 为报告生成分享链接（供长图二维码使用） */
export function shareReport(reportId) {
  return request('POST', `/v1/report/${encodeURIComponent(reportId)}/share`);
}

/** 生成邀请链接（对方未注册也能用） */
export function createInvite({ note = '' } = {}) {
  return request('POST', '/v1/report/invite', { body: { note } });
}

/** 公开读取邀请信息（接受前先看看是谁邀请的） */
export function fetchInvite(inviteToken) {
  return request('GET', `/v1/report/invite/${encodeURIComponent(inviteToken)}`);
}

/** 接受邀请并生成报告 */
export function acceptInvite(inviteToken, { tier = 'deep', question = '' } = {}) {
  return request('POST', `/v1/report/invite/${encodeURIComponent(inviteToken)}/accept`, {
    body: { tier, question },
  });
}

/** 分享/邀请链接的绝对地址 */
export function absoluteUrl(path) {
  const p = path.startsWith('/') ? path : `/${path}`;
  const loc = globalThis.location;
  const origin = loc && loc.origin ? loc.origin : 'https://qtvq.cn';
  return `${origin}${p}`;
}

/** 钱包：余额、会员状态、各档位「对我会收多少」 */
export function fetchWallet() {
  return request('GET', '/v1/wallet', { timeoutMs: 12000 });
}

/** 我的流水 */
export function fetchLedger(limit = 20) {
  return request('GET', `/v1/wallet/ledger?limit=${encodeURIComponent(limit)}`);
}

/** 内容安全预检：提交前就能提示，不用等被服务端拒 */
export function checkText(text, field = 'profile') {
  return request('POST', '/v1/safety/check', { body: { text, field }, timeoutMs: 12000 });
}

/** 举报原因（与服务端 services/moderation.js 的 REPORT_REASONS 保持一致） */
/* 唯一来源：packages/shared（跨端同一份，见该文件头说明） */
import { REPORT_REASONS } from '../packages/shared/src/index.js';
export { REPORT_REASONS };

/** 提交举报 */
export function submitReport({ targetType, targetId, reason, detail = '' }) {
  return request('POST', '/v1/moderation/report', { body: { targetType, targetId, reason, detail } });
}

/** 我的举报记录 */
export function listMyComplaints(limit = 20) {
  return request('GET', `/v1/moderation/mine?limit=${encodeURIComponent(limit)}`);
}

// ---------------------------------------------------------------- 转盘

/** 转盘候选（用于扇区预览与空态判断）；服务端只返回展示字段，不含向量 */
export function fetchWheelCandidates() {
  return request('GET', '/v1/wheel/candidates');
}

/** 转一次要花多少（按钮上显示价格用） */
export function fetchWheelQuote() {
  return request('GET', '/v1/wheel/quote');
}

/**
 * 转一次。
 *
 * **抽签结果由服务端决定**：返回 `{sectors, targetIndex, target, billing}`，
 * 前端只负责把动画停到 `targetIndex` 对应的扇区。
 * `idempotencyKey` 的作用是「双击/网络重试只扣一次钱」，**不能**用来指定对象。
 */
export function spinWheel({ idempotencyKey } = {}) {
  return request('POST', '/v1/wheel/spin', {
    body: {},
    idempotencyKey: idempotencyKey || newIdempotencyKey(),
  });
}

/** 我的转动记录 */
export function fetchSpinHistory(limit = 20) {
  return request('GET', `/v1/wheel/history?limit=${encodeURIComponent(limit)}`);
}

/** 档位展示用（与服务端 src/constants.js 保持一致） */
export const TIERS = [
  { key: 'basic', zh: '缘分一转', price: 1, desc: '总体判断 + 1 条最该做的事' },
  { key: 'advanced', zh: '心动三转', price: 5, desc: '兴趣与性格两点观察 + 2 条建议' },
  { key: 'deep', zh: '深度配对', price: 20, desc: '三方面分析 + 3 条沟通建议 + 风险提示' },
  { key: 'soul', zh: '灵魂契合', price: 50, desc: '心理契合、长期潜力、5 条深度建议' },
];

export function tierOf(key) {
  return TIERS.find((t) => t.key === key) || TIERS[2];
}

/**
 * 订阅报告进度流（服务端 REPORT_STREAM=1 时才有）。
 *
 * 只做「等它完成」这一件事：收到 done 后再用 fetchReport 拉一次正文（流里只推进度，
 * 不推正文 —— 正文要过内容安全，见 E.64）。任何异常/不支持都抛错，调用方回退轮询，
 * 所以这个函数**永远可以安全地试**。
 */
export async function waitForReportStream(reportId, { onTick, timeoutMs = 180000 } = {}) {
  if (typeof fetch !== 'function' || typeof TextDecoder === 'undefined') {
    throw new Error('环境不支持流式');
  }
  const t = readStore(TOKEN_KEY);
  const headers = { Accept: 'text/event-stream' };
  if (t) headers.Authorization = `Bearer ${t}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${REPORT_API_BASE}/v1/report/stream/${encodeURIComponent(reportId)}`, {
      headers,
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`流式不可用（HTTP ${res.status}）`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('流意外结束');
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop() || '';
      for (const frame of frames) {
        const ev = /event: (\w+)/.exec(frame)?.[1];
        const dataLine = /data: (.+)/.exec(frame)?.[1];
        if (!ev) continue;
        const data = dataLine ? JSON.parse(dataLine) : {};
        if (onTick) onTick(Date.now() - started, data);
        if (ev === 'done') { reader.cancel().catch(() => {}); return fetchReport(reportId); }
        if (ev === 'error' || ev === 'timeout') throw new Error(data.error || '流式等待超时');
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
