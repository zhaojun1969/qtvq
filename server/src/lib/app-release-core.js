/**
 * 全端「专用端口」契约的**纯函数核心**（无任何 import，端侧可直接复用）
 *
 * 为什么把核心单独拆出来：
 *   1. **可单测**：契约的正确性（尤其"版本号非法时绝不强制"这类边界）必须能被测试，
 *      而带环境依赖的实现文件会拖进 Pages 专属的 JSON 导入，在 Node 里根本加载不了；
 *   2. **可复用**：小程序 / App / 桌面 / 鸿蒙端都可能想在本地也做一次同样的判断
 *      （例如离线时按本地缓存的 release 记录决定是否提示），它们只需要这几个纯函数；
 *   3. 契约与 FTVF 项目（`D:\ftvf夫道\packages\shared\src\app-release.ts`）一致，
 *      两个项目共用同一套语义与字段名。
 *
 * ⚠️ 本文件不允许出现任何 import —— 保持它可以被任何运行时直接加载。
 */

/** 全端渠道标识。取值与订阅消息渠道一致，避免同一个端在两套接口里两个名字。 */
export const APP_CHANNELS = [
  'wechat',
  'alipay',
  'douyin',
  'xhs',
  'kuaishou',
  'jd',
  'qq',
  'baidu',
  'mp360',
  'web',
  'android',
  'ios',
  'windows',
  'harmony',
];

export const APP_CHANNEL_LABELS = {
  wechat: '微信小程序',
  alipay: '支付宝小程序',
  douyin: '抖音小程序',
  xhs: '小红书小程序',
  kuaishou: '快手小程序',
  jd: '京东小程序',
  qq: 'QQ 小程序',
  baidu: '百度小程序',
  mp360: '360 小程序',
  web: '官网 / H5',
  android: 'Android App',
  ios: 'iOS App',
  windows: 'Windows 桌面',
  harmony: '鸿蒙 App',
};

export const APP_CHANNEL_KIND = {
  wechat: 'miniapp',
  alipay: 'miniapp',
  douyin: 'miniapp',
  xhs: 'miniapp',
  kuaishou: 'miniapp',
  jd: 'miniapp',
  qq: 'miniapp',
  baidu: 'miniapp',
  mp360: 'miniapp',
  web: 'web',
  android: 'app',
  ios: 'app',
  windows: 'desktop',
  harmony: 'app',
};

/** 更新方式（服务端下发，端侧不得自行决定策略） */
export const UPDATE_MODES = ['silent', 'prompt', 'force'];

/**
 * 出厂基线：**任何端，只要没人发布过版本，也必须能拿到"不需更新"的确定结论**。
 * 没有它，客户端就得处理"服务端 404"这种既不是错误也不是成功的状态，
 * 结果通常是各端各写一套兜底，又一处漂移。
 */
export const DEFAULT_RELEASE = {
  version: '1.0.0',
  minVersion: '1.0.0',
  mode: 'prompt',
  notes: '',
  downloadUrl: null,
  publishedAt: '2026-09-20T00:00:00.000Z',
};

/** 版本号合法性：1~4 段纯数字（`1`/`1.2`/`1.2.3`/`1.2.3.4` 都认；带 `v` 前缀不认） */
export function isValidVersion(value) {
  return typeof value === 'string' && /^\d{1,5}(\.\d{1,5}){0,3}$/.test(value.trim());
}

/** 比较版本号：a>b→1，相等→0，a<b→-1；段数不同按缺省补 0（`1.2` == `1.2.0`） */
export function compareVersions(a, b) {
  const seg = (v) =>
    String(v)
      .trim()
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const left = seg(a);
  const right = seg(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/**
 * 更新决策（纯函数：同一输入永远同一输出）。
 *
 * 三条刻意的取舍：
 *  - **客户端版本号非法时绝不强制** —— 把"版本号写错"升级成"所有人都打不开"是最坏的结果；
 *  - `mode: 'silent'` 时 `needsUpdate` 仍为 true（端侧照旧静默更新，只是不打扰用户）；
 *  - 没有服务端记录时结论是"已最新"，端侧无需特殊分支。
 *
 * @param {string} current 客户端上报的版本
 * @param {object|null} release 服务端的发布记录
 * @param {{hadRelease?: boolean}} [opts]
 */
export function decideUpdate(current, release, opts = {}) {
  const rel = release ?? null;
  const base = {
    needsUpdate: false,
    force: false,
    mode: rel?.mode ?? 'prompt',
    current,
    latest: rel?.version ?? null,
    minVersion: rel?.minVersion ?? null,
    downloadUrl: rel?.downloadUrl ?? null,
    notes: rel?.notes ?? '',
    reason: opts.hadRelease === false ? 'no_release' : 'up_to_date',
  };
  if (!rel) return base;
  if (!isValidVersion(current)) return { ...base, reason: 'invalid_current_version' };

  if (compareVersions(current, rel.minVersion) < 0) {
    return { ...base, needsUpdate: true, force: rel.mode === 'force', reason: 'below_min_version' };
  }
  if (compareVersions(current, rel.version) < 0) {
    return { ...base, needsUpdate: true, force: false, reason: 'newer_available' };
  }
  return base;
}

/** 渠道是否合法 */
export function isValidChannel(channel) {
  return APP_CHANNELS.includes(channel);
}

/** 把一条（可能不完整/不合法的）发布记录规范化；不合法返回 null */
export function normalizeRelease(channel, item) {
  if (!item || !isValidVersion(item.version)) return null;
  return {
    channel,
    version: item.version,
    minVersion: isValidVersion(item.minVersion) ? item.minVersion : item.version,
    mode: UPDATE_MODES.includes(item.mode) ? item.mode : 'prompt',
    notes: typeof item.notes === 'string' ? item.notes : '',
    downloadUrl: typeof item.downloadUrl === 'string' && item.downloadUrl ? item.downloadUrl : null,
    publishedAt: item.publishedAt || DEFAULT_RELEASE.publishedAt,
  };
}
