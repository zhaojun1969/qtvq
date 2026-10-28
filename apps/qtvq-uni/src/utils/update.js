/**
 * 全端自动更新
 *
 * 本项目原来**完全没有更新逻辑**（`npm run check:platforms` 会报出来）。各端的更新机制
 * 其实完全不同，必须分开处理，混在一起写就是"看起来做了、实际哪端都没生效"：
 *
 *   小程序（8 端）  平台自己管版本包，代码能做的只有"检测到新版本 → 提示用户重启"。
 *                   微信/QQ/百度/快手/京东等都由 `uni.getUpdateManager()` 统一封装。
 *                   注意：小程序**没有**"我主动检查更新"的能力，只能在启动时拿到平台给的结论。
 *   App（Android/iOS/鸿蒙）
 *                   两种更新：① **wgt 热更新**（只换 js/css，用户几乎无感，但受平台规则限制：
 *                   不能改变原生能力、iOS 对热更新有额外限制）；② **整包更新**（引导去应用市场/下载新 APK）。
 *                   本模块只做"检查 + 提示 + 跳转"：真正替换包体由系统安装器完成，
 *                   我们**不做静默自替换**（那既违规也不安全）。
 *   H5/桌面        浏览器/Electron 无法自己替换静态文件，做法是**版本轮询**：
 *                   发现服务端版本变新 → 提示用户刷新（刷新即拿到新文件）。
 *
 * 版本来源统一为 `https://qtvq.cn/release/version.json`（静态文件，随静态站一起发布），
 * 结构见 tools/scripts/write-release-manifest.mjs。
 *
 * 设计原则：**更新永远不能阻塞使用**。网络失败、接口 404、字段缺失，一律静默跳过，
 * 绝不在启动路径上抛异常 —— 更新失败不该让用户连页面都打不开。
 */

import { API_BASE } from '../api/config.js';

/** 静态版本清单（兜底）：与主站同域 */
export const VERSION_URL = `${API_BASE}/release/version.json`;

/** 各端「专用端口」：一次拿到能力清单 + 版本记录 + 更新结论（首选） */
export const BOOTSTRAP_URL = `${API_BASE}/api/app/bootstrap`;

/** 检查间隔：App/H5 每次冷启动检查一次；同一次会话里不重复打扰 */
const SESSION_KEY = 'qtvq_update_checked_at';

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
    /* 存储不可用不影响更新检查 */
  }
}

/** 通用 GET（任何异常都返回 null —— 更新检查失败不能影响使用） */
function httpGetJson(url, timeout = 8000) {
  return new Promise((resolve) => {
    try {
      uni.request({
        url,
        method: 'GET',
        timeout,
        success: (res) => {
          if (res.statusCode !== 200 || !res.data) return resolve(null);
          try {
            // H5 下 uni.request 自动解析 JSON；小程序下可能拿到字符串
            resolve(typeof res.data === 'string' ? JSON.parse(res.data) : res.data);
          } catch {
            resolve(null);
          }
        },
        fail: () => resolve(null),
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * 问一次各端的「专用端口」：`GET /api/app/bootstrap?channel=&version=`
 *
 * 返回体同时含**该端的能力清单**（哪些功能真的可用）与**更新结论**，
 * 所以各端不必再逐个探测支付/语音/登录接口 —— 漏探测的后果是界面上出现
 * "点了没反应"的功能（订阅消息 configured:false 那条教训）。
 *
 * 服务端未收录该渠道时返回的是**渠道目录**（没有 update 字段），这里视为"拿不到结论"，
 * 由调用方退回静态版本清单。
 *
 * @returns {Promise<{update: object, capabilities: object, release: object}|null>}
 */
export async function fetchBootstrap(currentVersion) {
  const channel = runtimeTag();
  const url =
    `${BOOTSTRAP_URL}?channel=${encodeURIComponent(channel)}` +
    `&version=${encodeURIComponent(currentVersion || '')}`;
  const data = await httpGetJson(url);
  if (!data || data.ok === false || !data.update) return null;
  return { update: data.update, capabilities: data.capabilities || {}, release: data.release || null };
}

/** 拉静态版本清单（bootstrap 不可用时的兜底） */
export async function fetchReleaseManifest() {
  return httpGetJson(VERSION_URL);
}

/** 语义化版本比较：a > b 返回 1，相等 0，a < b 返回 -1。非数字段按字符串比 */
export function compareVersion(a, b) {
  const pa = String(a || '0').split('.');
  const pb = String(b || '0').split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const na = parseInt(pa[i] || '0', 10);
    const nb = parseInt(pb[i] || '0', 10);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      const sa = String(pa[i] || '');
      const sb = String(pb[i] || '');
      if (sa !== sb) return sa > sb ? 1 : -1;
      continue;
    }
    if (na !== nb) return na > nb ? 1 : -1;
  }
  return 0;
}

/* ─────────────────────────── 小程序：平台托管更新 ─────────────────────────── */

/**
 * 小程序更新检测。
 *
 * `uni.getUpdateManager()` 在小程序端返回平台封装对象；在不支持的平台（如部分小平台）
 * 上返回 undefined，此时安静跳过。
 *
 * 策略：**自动下载、提示重启**（而不是强制立即重启）——
 * 用户可能正在填资料/付款，强制重启会丢输入。提示用 showModal，确认后才 applyUpdate。
 */
export function checkMiniProgramUpdate() {
  let um = null;
  try {
    um = uni.getUpdateManager && uni.getUpdateManager();
  } catch {
    um = null;
  }
  if (!um || typeof um.onCheckForUpdate !== 'function') return false;

  um.onCheckForUpdate((res) => {
    if (!res?.hasUpdate) return;
    // 有新版本：后台静默下载
  });

  um.onUpdateReady(() => {
    uni.showModal({
      title: '发现新版本',
      content: '新版本已下载完成，重启后生效（不会丢失已填写的内容）。',
      confirmText: '立即重启',
      cancelText: '稍后',
      success: (r) => {
        if (r.confirm) um.applyUpdate();
      },
    });
  });

  um.onUpdateFailed(() => {
    // 下载失败不打扰用户：下次启动会再试
    console.warn('[update] 小程序新版本下载失败，将在下次启动重试');
  });

  return true;
}

/* ─────────────────────────── App：wgt 热更新 / 整包更新 ─────────────────────────── */

/** 当前 App 版本信息（App 端可用；其它端返回 null） */
export function getAppVersionInfo() {
  // #ifdef APP-PLUS
  try {
    return plus.runtime.version ? { version: plus.runtime.version, code: plus.runtime.versionCode } : null;
  } catch {
    return null;
  }
  // #endif
  // eslint-disable-next-line no-unreachable
  return null;
}

/**
 * App 更新检查（**以专用端口为准，静态清单兜底**）。
 *
 * 先说清更新策略的来源：判断"要不要更新、要不要强制"由服务端决定
 * （`update.force` / `update.mode`），端侧**不自己比版本号** —— 策略集中在服务端，
 * 才能一次调整覆盖所有端，也避免各端阈值不一致。
 *
 * 两种安装方式：
 *   · `update.downloadUrl` 以 `.wgt` 结尾 → 热更新（下载后 plus.runtime.install，重启生效）
 *   · 其它 → 整包：plus.runtime.openURL 打开下载地址/应用市场
 *
 * 热更新的边界必须说清：**只替换前端资源，不改原生能力与权限**。
 * 若新版本需要新增原生权限（例如新增录音），必须走整包 —— 否则装上去会崩。
 * 服务端把该端的 `mode` 设为 `force` 时，这里会**拦在启动**（用户取消则退出应用），
 * 这也解释了为什么"客户端版本号非法时服务端绝不返回 force"：那会把用户锁死。
 */
export async function checkAppUpdate({ silent = false } = {}) {
  // #ifdef APP-PLUS
  const local = getAppVersionInfo();
  if (!local) return { checked: false, reason: 'NO_VERSION' };

  // 首选：专用端口（拿到的是服务端算好的结论）
  let decision = null;
  let downloadUrl = null;
  let notes = '';
  let latest = null;
  const bs = await fetchBootstrap(local.version);
  if (bs) {
    decision = bs.update;
    downloadUrl = bs.update.downloadUrl;
    notes = bs.update.notes;
    latest = bs.update.latest;
  } else {
    // 兜底：静态版本清单（服务端未部署新端点时仍能工作）
    const manifest = await fetchReleaseManifest();
    if (!manifest) return { checked: false, reason: 'NO_MANIFEST' };
    let key = 'android';
    try {
      const sys = uni.getSystemInfoSync();
      if (sys.platform === 'ios') key = 'ios';
      else if (sys.osName === 'harmonyos' || sys.platform === 'harmonyos') key = 'harmony';
    } catch {
      /* 取不到就按 android 处理 */
    }
    const remote = manifest.app?.[key];
    if (!remote?.version) return { checked: true, hasUpdate: false };
    const cmp = compareVersion(remote.version, local.version);
    decision = {
      needsUpdate: cmp > 0,
      force: false,
      mode: remote.wgtCompatible === false ? 'prompt' : 'silent',
      latest: remote.version,
      downloadUrl: remote.url,
      notes: remote.note || '',
    };
    downloadUrl = remote.url;
    notes = remote.note || '';
    latest = remote.version;
  }

  if (!decision?.needsUpdate) return { checked: true, hasUpdate: false };
  if (!downloadUrl) {
    // 需要更新但没有下载地址：这是**服务端配置缺失**（App/桌面端必须填 downloadUrl）。
    // 不静默吞掉 —— 提示用户去官网，同时留下日志，便于发现"发了版本但没人能更新"。
    console.warn(`[update] 服务端要求更新到 ${latest}，但 downloadUrl 为空（app-releases.json 未填）`);
    if (!silent) {
      uni.showModal({
        title: '有新版本',
        content: `${notes || `新版本 ${latest} 已发布`}\n请到官网 qtvq.cn 下载最新版本。`,
        showCancel: false,
      });
    }
    return { checked: true, hasUpdate: true, applied: false, mode: 'no-url', version: latest };
  }

  const isWgt = typeof downloadUrl === 'string' && downloadUrl.endsWith('.wgt');
  if (isWgt) {
    if (!silent) uni.showLoading({ title: '正在更新…', mask: true });
    try {
      const file = await new Promise((resolve, reject) => {
        const task = plus.downloader.createDownload(downloadUrl, {}, (d, status) => {
          if (status === 200 && d.filename) resolve(d.filename);
          else reject(new Error(`下载失败 ${status}`));
        });
        task.start();
      });
      await new Promise((resolve, reject) => {
        plus.runtime.install(file, { force: false }, resolve, (e) =>
          reject(new Error(e?.message || '安装失败')),
        );
      });
      if (!silent) uni.hideLoading();
      uni.showModal({
        title: '更新完成',
        content: '新版本已就绪，重启应用后生效。',
        showCancel: false,
        success: () => plus.runtime.restart(),
      });
      return { checked: true, hasUpdate: true, applied: true, mode: 'wgt', version: latest };
    } catch (err) {
      if (!silent) uni.hideLoading();
      console.warn('[update] wgt 更新失败，回落到整包提示：', err?.message || err);
      // 落到下面的整包分支
    }
  }

  const force = decision.force === true;
  uni.showModal({
    title: force ? '需要更新后才能继续使用' : '发现新版本',
    content: notes || `新版本 ${latest} 已发布，是否前往更新？`,
    showCancel: !force,
    confirmText: '去更新',
    cancelText: '稍后',
    success: (r) => {
      if (r.confirm) plus.runtime.openURL(downloadUrl);
      else if (force) plus.runtime.quit();
    },
  });
  return { checked: true, hasUpdate: true, applied: false, mode: force ? 'package-force' : 'package', version: latest };
  // #endif
  // eslint-disable-next-line no-unreachable
  return { checked: false, reason: 'NOT_APP' };
}

/* ─────────────────────────── H5 / 桌面：版本轮询 ─────────────────────────── */

/**
 * H5 与桌面端更新提示。
 *
 * 浏览器与 Electron 都无法自行替换已加载的静态资源，能做的只有：
 * 定时拉清单 → 发现版本变了 → 提示刷新（用户点确认即 location.reload）。
 *
 * 桌面端（Electron）另有一套整包更新（electron-updater），见 desktop/ 工程；
 * 这里的轮询对桌面端仍然有用：它能覆盖"前端资源变了但壳没变"的情形。
 *
 * @param {{intervalMs?: number, currentBuild?: string}} opts
 */
export function startWebUpdateWatch({ intervalMs = 10 * 60 * 1000, currentBuild = '' } = {}) {
  let stopped = false;
  let timer = null;

  const check = async () => {
    if (stopped) return;
    const manifest = await fetchReleaseManifest();
    const remoteBuild = manifest?.web?.build;
    // 只提示一次：用会话标记避免用户点了"稍后"还被反复打扰
    if (remoteBuild && currentBuild && remoteBuild !== currentBuild && !safeGet(SESSION_KEY)) {
      safeSet(SESSION_KEY, String(Date.now()));
      uni.showModal({
        title: '页面已更新',
        content: '新版本已发布，刷新后生效。',
        confirmText: '立即刷新',
        cancelText: '稍后',
        success: (r) => {
          if (r.confirm) {
            // #ifdef H5
            window.location.reload();
            // #endif
            // #ifndef H5
            uni.reLaunch({ url: '/pages/index/index' });
            // #endif
          }
        },
      });
    }
    if (!stopped) timer = setTimeout(check, intervalMs);
  };

  check();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * 当前端类型标识 —— **必须返回服务端 `APP_CHANNELS` 里的名字**
 * （`server/src/lib/app-release-core.js` / `functions/lib/app-release-core.js`）
 *
 * ── 2026-10-28 修的一个真 BUG：名字对不上 ────────────────────────────────
 * 这里原来返回的是**构建平台名**：`mp-weixin` / `mp-alipay` / `h5` / `app` …
 * 而服务端只认 `wechat` / `alipay` / `web` / `android`|`ios`。实测线上：
 *   `GET /api/app/bootstrap?channel=mp-weixin` → **400 E_UNKNOWN_CHANNEL**
 *   `GET /api/app/bootstrap?channel=h5`       → **400**
 *   `GET /api/app/bootstrap?channel=app`      → **400**
 * 于是 `fetchBootstrap()` 判 `ok === false` 后返回 null —— **所有端的能力清单与更新结论
 * 从来没有生效过**，一直在安静地退回静态 `release/version.json`（只有 web 一项）。
 *
 * 为什么长期没被发现：接口是通的、HTTP 也能连（只是 400），而且客户端设计成
 * "拿不到结论就退回兜底"，所以**任何一端都不报错**，功能看起来也正常。
 * 这类"协议两端各说各的名字"只能靠断言对齐，靠人工点不出来。
 * 断言见 `tools/scripts/check-channel-contract.mjs`。
 *
 * App 端要再分一层：服务端的 android / ios 是两条独立发布记录（审核周期完全不同），
 * 而 uni-app 的 `APP-PLUS` 是一个宏 —— 只能运行时读 `plus.os.name`。
 */
export function runtimeTag() {
  // #ifdef MP-WEIXIN
  return 'wechat';
  // #endif
  // #ifdef MP-ALIPAY
  return 'alipay';
  // #endif
  // #ifdef MP-TOUTIAO
  return 'douyin';
  // #endif
  // #ifdef MP-XHS
  return 'xhs';
  // #endif
  // #ifdef MP-QQ
  return 'qq';
  // #endif
  // #ifdef MP-BAIDU
  return 'baidu';
  // #endif
  // #ifdef MP-KUAISHOU
  return 'kuaishou';
  // #endif
  // #ifdef MP-JD
  return 'jd';
  // #endif
  // #ifdef MP-360
  return 'mp360';
  // #endif
  // #ifdef H5
  return 'web';
  // #endif
  // #ifdef APP-PLUS
  try {
    const os = String((typeof plus !== 'undefined' && plus.os && plus.os.name) || '').toLowerCase();
    return os === 'ios' ? 'ios' : 'android';
  } catch {
    return 'android';
  }
  // #endif
  // 兜底：未知端按 web 处理（服务端有 web 记录，不会 400）
  return 'web';
}

/**
 * 应用启动时的统一更新入口（App.vue 调用一次即可）。
 * 分派规则见文件头注释。**永远不抛异常**。
 */
export async function initAutoUpdate() {
  try {
    // #ifdef MP
    checkMiniProgramUpdate();
    return;
    // #endif
    // #ifdef APP-PLUS
    await checkAppUpdate();
    return;
    // #endif
    // #ifdef H5
    startWebUpdateWatch({ currentBuild: typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : '' });
    return;
    // #endif
  } catch (err) {
    console.warn('[update] 自动更新初始化失败（已忽略）：', err?.message || err);
  }
}
