/**
 * 前端埋点 SDK（静态站，2026-10-27 · 再改造实施书 P0-T0.3）
 *
 * 用法：
 *   import { track } from './track.js';
 *   track('report_landing_view', { sku: 'diagnose' });
 *
 * ── 三条刻意的设计 ────────────────────────────────────────────────────────
 * 1. **永不抛异常、永不影响业务**：埋点失败必须静默。一个统计系统不该让用户点不了按钮。
 * 2. **批量 + 本地缓冲**：事件先进 localStorage 队列，够 10 条或 5 秒后批量上报；
 *    页面隐藏时用 `sendBeacon` 兜底（`visibilitychange` / `pagehide`）。
 * 3. **`eventId` 客户端生成**：弱网重发时服务端靠唯一索引去重，不会把一次点击记成三次。
 *
 * 渠道码 `ch` 从 URL 的 `?ch=` 取，首次进入时持久化到 localStorage ——
 * 内容矩阵（P3）投放的渠道码要能一路跟到注册，靠的就是这一步。
 */

const ENDPOINT = '/v1/track';
const LS_QUEUE = 'qtvq_track_queue';
const LS_CH = 'qtvq_channel';
const LS_ANON = 'qtvq_anon_id';
/**
 * 会话 token 的存储键。
 *
 * **为什么不 `import { getAuthToken } from './auth.js'`**：`auth.js` 已经
 * `import { channel } from './track.js'`（注册要带渠道码），反向再 import 会形成循环依赖。
 * 这里直接读同一个键；键名与 `auth.js` 的 `TOKEN_KEY` 必须一致，
 * 由 `tools/scripts/check-activation-wiring.mjs` 机器校验（只改一边会判红）。
 */
const LS_TOKEN = 'qtvq_auth_token';
const FLUSH_SIZE = 10;
const FLUSH_DELAY_MS = 5000;

/** 读登录态（读不到就当未登录，埋点永不因它抛错） */
function readToken() {
  try {
    return localStorage.getItem(LS_TOKEN) || '';
  } catch {
    return '';
  }
}

function genId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    /* 回退 */
  }
  return `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式/配额满：静默 */
  }
}

/** 渠道码：URL 优先，其次持久化值，最后 direct */
export function channel() {
  try {
    const fromUrl = new URLSearchParams(location.search).get('ch');
    if (fromUrl) {
      writeJson(LS_CH, fromUrl);
      return fromUrl;
    }
    return readJson(LS_CH, 'direct') || 'direct';
  } catch {
    return 'direct';
  }
}

/** 匿名 ID：未登录用户也要能算留存 */
export function anonId() {
  let id = readJson(LS_ANON, null);
  if (!id) {
    id = genId();
    writeJson(LS_ANON, id);
  }
  return id;
}

function queue() {
  return readJson(LS_QUEUE, []) || [];
}

let timer = null;

async function flush(useBeacon = false) {
  const items = queue();
  if (!items.length) return;
  writeJson(LS_QUEUE, []);

  const payload = JSON.stringify({ events: items, ch: channel(), anonId: anonId() });

  /*
   * 登录态必须带上，否则事件落库 `uid=null`。
   *
   * 这不是"锦上添花"：`server/src/services/metrics.js` 的激活口径是
   * `ACTIVATION_EVENTS + e.uid`，没有 uid 的事件会被直接跳过 ——
   * 于是"激活用户"恒为 0，而整条链路不报任何错（E.40 记的就是这个坑）。
   *
   * `navigator.sendBeacon` 不能自定义请求头，所以**登录态下不能用 beacon**，
   * 改用 `fetch(..., {keepalive:true})`：同样是页面卸载后仍会发完，只少了 beacon 的优先级。
   */
  const token = readToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  if (useBeacon && !token && navigator.sendBeacon) {
    try {
      // sendBeacon 的 Content-Type 由 Blob 决定，服务端 express.json 只吃 application/json
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon(ENDPOINT, blob);
      return;
    } catch {
      /* 落到 fetch */
    }
  }

  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers,
      body: payload,
      keepalive: true,
    });
  } catch {
    // 失败就把事件放回队列（最多保留 100 条，避免无限膨胀）
    const back = [...items, ...queue()].slice(0, 100);
    writeJson(LS_QUEUE, back);
  }
}

/**
 * 上报一个事件。
 * @param {string} event 必须来自服务端白名单
 * @param {object} [props] 附加字段（≤2KB）
 */
export function track(event, props = null) {
  try {
    const items = queue();
    items.push({ eventId: genId(), event, props, ts: Date.now() });
    writeJson(LS_QUEUE, items.slice(-100));

    if (items.length >= FLUSH_SIZE) {
      flush();
      return;
    }
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        flush();
      }, FLUSH_DELAY_MS);
    }
  } catch {
    /* 埋点永不抛 */
  }
}

/** 页面离开时兜底上报（移动端 pagehide 比 unload 可靠） */
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
  });
  window.addEventListener('pagehide', () => flush(true));
}

export { flush };
