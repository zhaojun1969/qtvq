/**
 * 渠道归因（实施书 P3-T3.2）
 *
 * 小程序分享出去的是**场景值 scene**，不是 URL query。微信会把
 *   pages/index/index?scene=xhs05
 * 里的 scene 转义后交给 onLaunch —— 所以要先 decodeURIComponent，再当 query 串解析。
 *
 * 支持两种 scene 写法（内容矩阵里两种都会用）：
 *   · `ch=xhs05`                          —— 纯渠道码
 *   · `inviter_uid=abc123&ch=report_share` —— 分享卡带来的邀请人 + 渠道
 *
 * 存储与官网一致用 `qtvq_channel` / `qtvq_inviter` 两个键（同名的目的：
 * 以后再出现「小程序 → H5」的跳转时，两边读的是同一份归因）。
 */

const CH_KEY = 'qtvq_channel';
const INV_KEY = 'qtvq_inviter';
const INVITER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function safeGet(key) {
  try {
    return uni.getStorageSync(key) || '';
  } catch {
    return '';
  }
}

function safeSet(key, value) {
  try {
    uni.setStorageSync(key, value);
  } catch {
    /* 存不了不影响使用 */
  }
}

/** scene 可能是 `ch%3Dxhs05`（已转义）也可能是 `ch=xhs05`，都按 query 串处理 */
export function parseScene(scene) {
  if (!scene) return {};
  let raw = String(scene);
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* % 不成对：按原样解析 */
  }
  const out = {};
  for (const pair of raw.split('&')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

function validChannel(v) {
  const s = String(v || '').trim().toLowerCase();
  return /^[a-z0-9_-]{2,24}$/.test(s) ? s : '';
}

function validUid(v) {
  const s = String(v || '').trim();
  return /^[A-Za-z0-9_-]{6,64}$/.test(s) ? s : '';
}

/**
 * 启动时抓归因。优先 scene，其次 query（H5 编译版直接带 query）。
 * 只写非空值 —— 不能让一次"没有 scene 的冷启动"把已经存下来的渠道码抹掉。
 */
export function captureAttribution(options = {}) {
  const fromScene = parseScene(options.scene);
  const fromQuery = options.query && typeof options.query === 'object' ? options.query : {};

  const ch = validChannel(fromScene.ch || fromScene.channel || fromQuery.ch || fromQuery.channel);
  if (ch) safeSet(CH_KEY, ch);

  const inviterUid = validUid(fromScene.inviter_uid || fromScene.inviterUid || fromQuery.inviter_uid || fromQuery.inviterUid);
  if (inviterUid) {
    // 邀请人链接有效期跟分享 token 对齐（30 天），过期就不再归因，避免把老链接算成新邀请
    safeSet(INV_KEY, JSON.stringify({ uid: inviterUid, at: Date.now() }));
  }
  return { ch, inviterUid };
}

export function channel() {
  return validChannel(safeGet(CH_KEY)) || 'direct';
}

export function inviterUid() {
  const raw = safeGet(INV_KEY);
  if (!raw) return '';
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj?.uid || Date.now() - Number(obj.at || 0) > INVITER_TTL_MS) return '';
    return validUid(obj.uid);
  } catch {
    return '';
  }
}

/** 注册请求要带的归因字段；没有归因就不带，服务端据此判"无归因" */
export function attributionPayload() {
  const out = {};
  const ch = channel();
  if (ch && ch !== 'direct') out.ch = ch;
  const inviter = inviterUid();
  if (inviter) out.inviterUid = inviter;
  return out;
}

/** 注册成功后清掉邀请人（同一个邀请人不能对同一台设备的多次注册重复发券） */
export function clearInviter() {
  try {
    uni.removeStorageSync(INV_KEY);
  } catch {
    /* 忽略 */
  }
}
