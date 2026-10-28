/**
 * 小程序埋点 SDK（2026-10-28 · 计划书 E.40）
 *
 * 与官网 `js/track.js` 同一套口径（事件名/白名单/队列/去重/ch 归因），
 * 差异只在宿主 API：`localStorage` → `uni.getStorageSync`，`fetch` → `uni.request`。
 *
 * 用法：
 *   import { track, flush } from '../../utils/track.js';
 *   track('question_asked', { mode: 'ai' });
 *
 * ── 四条刻意的设计 ───────────────────────────────────────────────────────
 * 1. **永不抛异常、永不影响业务**：埋点失败必须静默，一个统计系统不该让用户点不了按钮。
 * 2. **批量 + 本地缓冲**：事件先进队列，够 10 条或 5 秒后批量上报（服务端单次上限 20）。
 * 3. **`eventId` 客户端生成**：弱网重发时服务端靠唯一索引（`eventId`）去重。
 * 4. **必须带登录态**：服务端 `resolveIdentity(req)` 只认 `Authorization: Bearer`，
 *    而 `metrics.js` 的激活口径是「`ACTIVATION_EVENTS` + 事件带 uid」——
 *    不带 token 的上报会落成 `uid=null`，看板"激活用户"恒为 0 且不报任何错。
 *
 * 渠道码复用 `utils/attribution.js::channel()`（它读的是和官网同名的 `qtvq_channel` 键），
 * 不在这里另存一份 —— 两处各写一份，迟早出现"小程序算 A 渠道、官网算 B 渠道"。
 */

import { apiUrl } from '../api/config.js';
import { getAuthToken } from './auth.js';
import { channel } from './attribution.js';

const ENDPOINT = apiUrl('/v1/track');
const K_QUEUE = 'qtvq_track_queue';
const K_ANON = 'qtvq_anon_id';
const FLUSH_SIZE = 10;
const FLUSH_DELAY_MS = 5000;
const MAX_QUEUE = 100;

function genId() {
  try {
    // 小程序基础库有 crypto.randomUUID 的机型很少，主要靠下面这条兜底
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    /* 回退 */
  }
  return `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function readJson(key, fallback) {
  try {
    const raw = uni.getStorageSync(key);
    return raw ? raw : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    uni.setStorageSync(key, value);
  } catch {
    /* 存储满/隐私模式：静默 */
  }
}

/** 匿名 ID：未登录用户也要能算留存（与官网同名键不冲突：两端不共享存储） */
export function anonId() {
  let id = readJson(K_ANON, '');
  if (!id || typeof id !== 'string') {
    id = genId();
    writeJson(K_ANON, id);
  }
  return id;
}

function queue() {
  const q = readJson(K_QUEUE, []);
  return Array.isArray(q) ? q : [];
}

let timer = null;
let flushing = false;

/**
 * 批量上报。`touch` 用于页面隐藏/隐藏后台时立刻发一次。
 * 失败不提示用户，把事件放回队列（最多 100 条，避免无限膨胀）。
 */
export function flush() {
  if (flushing) return;
  const items = queue();
  if (!items.length) return;

  flushing = true;
  writeJson(K_QUEUE, []);

  const token = getAuthToken();
  const header = { 'Content-Type': 'application/json' };
  if (token) header.Authorization = `Bearer ${token}`;

  uni.request({
    url: ENDPOINT,
    method: 'POST',
    header,
    data: { events: items, ch: channel(), anonId: anonId() },
    success: (res) => {
      // 4xx/5xx 也把事件放回去：宁可下次重复（服务端 eventId 去重），不要静默丢失
      if (!(res.statusCode >= 200 && res.statusCode < 300)) restore(items);
    },
    fail: () => restore(items),
    complete: () => {
      flushing = false;
    },
  });
}

function restore(items) {
  const back = [...items, ...queue()].slice(-MAX_QUEUE);
  writeJson(K_QUEUE, back);
}

/**
 * 上报一个事件。
 * @param {string} event 必须来自服务端白名单（`server/src/routes/track.js::EVENT_WHITELIST`）
 * @param {object} [props] 附加字段（序列化后 ≤2KB）
 */
export function track(event, props = null) {
  try {
    const items = queue();
    items.push({ eventId: genId(), event, props, ts: Date.now() });
    writeJson(K_QUEUE, items.slice(-MAX_QUEUE));

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
