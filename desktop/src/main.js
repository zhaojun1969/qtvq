/**
 * Q问 Windows 桌面客户端（Electron 主进程）
 *
 * 定位：**薄壳**。界面就是主站 https://qtvq.cn 本身，壳只负责窗口、托盘、系统集成、
 * 整包自动更新。不内嵌一份 H5 产物 —— 这条是踩过坑之后改的，理由见下面第 2 段。
 *
 * ── 为什么不再内嵌一份 H5 产物（重要，别改回去）──────────────────────────
 * 旧版（1.0.6）优先 `loadFile(desktop/web/index.html)`，而 desktop/web 是打包时的
 * **H5 快照**（那份停在 2026-09）。后果不是"打不开"，而是更隐蔽的：
 *   · 界面、文案、配色、支付流程全部冻结在发版那天，主站改了它不变 ——
 *     这就是"桌面端看起来像另一个产品"的来源；
 *   · 每改一次 UI 都要重新打 80MB 安装包并让用户更新，而网页端刷新即生效。
 *
 * 实测澄清（2026-10-30，desktop/scripts/smoke.js）：
 *   Electron 33 下 file:// 页面发出的跨域请求**不带 Origin 头**
 *   （实测 `GET /api/quota`、`POST /api/chat` 均无 Origin），服务端
 *   `if (!origin) return cb(null, true)` 会放行，所以旧架构接口是通的。
 *   别被 `curl -H 'Origin: null'` 的结果误导：那是人为构造的字符串 "null"，
 *   不是浏览器/Electron 的真实行为（真实行为是"不发这个头"）。
 *
 * 因此改造理由是**一致性**而不是"修故障"：壳只装窗口，界面就是线上站，
 * 服务端一发布用户刷新即新版。代价是彻底离线不可用 —— 而 AI 问答本来就必须联网，
 * 给一个"能点但全是报错"的离线旧界面只会制造误解，所以离线时给明确的提示页。
 *
 * 如果将来真要做离线快照：把产物放到 desktop/web，在 did-fail-load 里 loadFile，
 * 并在界面显著位置标注"离线快照版，数据不可用"。
 *
 * ── 更新分两层，两层都要 ────────────────────────────────────────────────
 *   ① 壳更新（本文件）：electron-updater 走 https://qtvq.cn/release/desktop/，
 *      发现新版本 → 下载 → 问用户是否重启。
 *   ② 页面更新：界面就是线上站，服务端一发布用户刷新即新版，不必等发版。
 *
 * ── 安全边界（刻意这么设）──────────────────────────────────────────────
 *   · contextIsolation:true + nodeIntegration:false + sandbox:true —— 页面无任何 Node 能力；
 *   · 不开 webSecurity:false（等于关掉同源策略，一个 XSS 就能读本地文件）；
 *   · 导航用**主机名精确匹配**，不用 startsWith —— 后者会被
 *     `https://qtvq.cn.evil.com` 这类前缀域名绕过；
 *   · 外链一律交给系统浏览器，窗口内不开第二个窗口。
 */
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  shell,
  dialog,
  ipcMain,
  session,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

/**
 * 启动早期诊断（写入临时目录）。
 *
 * 为什么需要这么"土"的东西：打包后的 exe 是 GUI 子系统，没有 stdout/stderr；
 * 如果进程在 initLog 之前就退出（模块加载失败、单实例锁被占），用户看到的只有
 * "双击没反应"，开发者什么都拿不到。这三行 appendFileSync 不依赖任何初始化，
 * 是唯一能证明"主进程到底跑到哪一步"的证据。
 * 正常运行时每次启动写 3 行，可以忽略不计。
 */
const BOOT_LOG = path.join(os.tmpdir(), 'qtvq-desktop.bootstrap.log');
/** 诊断写入的候选位置：临时目录 → 用户数据目录（两者都可能被策略拒绝） */
const BOOT_LOG_ALT = (() => {
  try {
    return path.join(app.getPath('userData'), 'bootstrap.log');
  } catch {
    return null;
  }
})();
function bootMark(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  for (const file of [BOOT_LOG, BOOT_LOG_ALT]) {
    if (!file) continue;
    try {
      fs.appendFileSync(file, line);
      return; // 写成功一处即可
    } catch {
      /* 换下一个候选 */
    }
  }
}
bootMark(`module loaded dirname=${__dirname} version=${process.versions.electron}`);

/* ────────────────────────── 常量 ────────────────────────── */

/** 主站地址：可用环境变量覆盖（便于本地联调与灰度） */
const APP_URL = process.env.QTVQ_DESKTOP_URL || 'https://qtvq.cn';
/** 更新源：与 latest.yml / 安装包同一目录 */
const UPDATE_FEED = process.env.QTVQ_UPDATE_FEED || 'https://qtvq.cn/release/desktop/';

/** 允许在窗口内导航的主机名（精确集合，不做后缀匹配） */
const TRUSTED_HOSTS = new Set();
for (const raw of [APP_URL, 'https://qtvq.cn', 'https://www.qtvq.cn', 'https://static.qtvq.cn']) {
  try {
    TRUSTED_HOSTS.add(new URL(raw).hostname);
  } catch {
    /* 非法地址直接忽略，不让它进入白名单 */
  }
}

/**
 * 免安装版（portable）判定。
 * electron-builder 的 portable target 会注入 PORTABLE_EXECUTABLE_DIR。
 * 免安装版**不能**用 electron-updater：它是 NSIS 安装流程，在没有安装目录的
 * portable 进程里会反复"下载完成 → 提示重启 → 重启后还是旧版"。
 */
const IS_PORTABLE = Boolean(process.env.PORTABLE_EXECUTABLE_DIR);

/**
 * 是否在「关窗口 = 退出」模式（默认关到托盘；用户可在托盘菜单切换）
 */
let minimizeToTray = true;

/**
 * 壳（安装包）版本号。
 *
 * 为什么不用裸的 `app.getVersion()`：当入口不是 `electron .`（例如
 * `electron scripts/smoke.js`、或者某些把 main 指到别处的启动方式），
 * Electron 找不到应用级 package.json，会返回**它自己的版本** —— 界面上就出现
 * "Q问 33.4.11" 这种荒谬版本号（冒烟测试当场抓到过）。读 package.json 兜底。
 */
function readShellVersion() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
    const v = JSON.parse(raw).version;
    if (v) return String(v);
  } catch {
    /* 落回 app.getVersion */
  }
  return app.getVersion();
}
const SHELL_VERSION = readShellVersion();
/** 手动检查更新时，把结果反馈给用户（自动检查时保持安静） */
let manualCheckPending = false;

let mainWindow = null;
let tray = null;
let updater = null;

/* ────────────────────────── 日志 ────────────────────────── */

/**
 * 简易文件日志。桌面端的故障（证书、代理、更新失败）在用户机器上无法复现，
 * 没有落盘日志就只能靠猜。按 1MB 轮转，只留一份 .1 备份。
 */
let logStream = null;
function initLog() {
  // 主路径：userData/logs（用户机器上便于"帮助 → 打开日志目录"）
  // 兜底：系统临时目录。用户目录不可写、或打包后路径异常时，日志不能跟着一起丢 ——
  // 否则客户端"点了没反应"就成了完全无迹可查的黑盒。
  const candidates = [];
  try {
    candidates.push(path.join(app.getPath('userData'), 'logs', 'main.log'));
  } catch {
    /* userData 取不到就只走兜底 */
  }
  candidates.push(path.join(os.tmpdir(), 'qtvq-desktop.log'));

  for (const file of candidates) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) {
        try {
          fs.copyFileSync(file, file + '.1');
        } catch {
          /* 轮转失败不阻塞 */
        }
        fs.truncateSync(file, 0);
      }
      logStream = fs.createWriteStream(file, { flags: 'a' });
      break;
    } catch {
      logStream = null;
    }
  }
}
function safeUserData() {
  try {
    return app.getPath('userData');
  } catch {
    return '(不可用)';
  }
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args
    .map((a) => (a instanceof Error ? a.stack || a.message : String(a)))
    .join(' ')}\n`;
  if (logStream) {
    try {
      logStream.write(line);
    } catch {
      /* ignore */
    }
  }
  if (!app.isPackaged) process.stdout.write(line);
}

/** 全局兜底：任何未捕获异常都要落盘，否则用户只看到"闪退" */
process.on('uncaughtException', (err) => log('[fatal] uncaughtException', err));
process.on('unhandledRejection', (err) => log('[fatal] unhandledRejection', err));

/* ────────────────────────── 窗口状态 ────────────────────────── */

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  const fallback = { width: 1200, height: 820, x: undefined, y: undefined, maximized: false };
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    const s = { ...fallback, ...raw };
    // 拔掉外接显示器后，旧坐标会让窗口落在不可见区域（点了图标"没反应"）。
    // 用当前所有屏幕的并集判断，越界就丢弃坐标、保留尺寸居中。
    if (Number.isFinite(s.x) && Number.isFinite(s.y) && !isOnScreen(s)) {
      s.x = undefined;
      s.y = undefined;
    }
    return s;
  } catch {
    return fallback;
  }
}
function isOnScreen({ x, y, width, height }) {
  const { screen } = require('electron');
  return screen.getAllDisplays().some((d) => {
    const b = d.workArea;
    // 只要窗口标题栏区域与某块屏幕相交就算可见
    return x < b.x + b.width && x + width > b.x && y < b.y + b.height && y + 40 > b.y;
  });
}
function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const b = mainWindow.getNormalBounds(); // 最大化时拿到的是还原后的尺寸
    fs.writeFileSync(
      stateFile(),
      JSON.stringify({ ...b, maximized: mainWindow.isMaximized() }, null, 2),
    );
  } catch (err) {
    log('[state] 保存窗口状态失败（忽略）', err);
  }
}

/* ────────────────────────── 导航信任判定 ────────────────────────── */

/**
 * 用 URL 解析 + 主机名精确匹配。
 * 反面教材：`url.startsWith('https://qtvq.cn')` 对 `https://qtvq.cn.evil.com`
 * 返回 true —— 前缀匹配不是同源判定，这类写法在导航校验里等同于没有校验。
 */
function isTrustedUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return TRUSTED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/* ────────────────────────── IPC ────────────────────────── */

/**
 * 页面（preload）同步取壳的信息。
 * 用 sendSync 而不是 process.env：sandbox:true 的 preload 里 process 是受限 polyfill，
 * 靠 `process.env.QTVQ_SHELL_VERSION` 传版本号曾经拿不到值（托盘菜单显示空版本）。
 */
ipcMain.on('qtvq:get-info', (e) => {
  e.returnValue = {
    shellVersion: SHELL_VERSION,
    isPortable: IS_PORTABLE,
    platform: process.platform,
    // 页面可以据此显示"桌面版 · 1.0.6"，不必自己猜 UA
    feedUrl: UPDATE_FEED,
  };
});

/** 用系统浏览器打开链接：只接受 http(s)，防止 file:// / smb:// 之类被滥用 */
ipcMain.on('qtvq:open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url).catch((err) => log('[open-external] 失败', err));
  }
});

/** 页面请求检查更新（比如"关于"里点一下） */
ipcMain.on('qtvq:check-updates', () => checkForUpdates(true));

/* ────────────────────────── 窗口 ────────────────────────── */

function createWindow() {
  const st = loadWindowState();
  mainWindow = new BrowserWindow({
    width: st.width,
    height: st.height,
    x: st.x,
    y: st.y,
    minWidth: 900,
    minHeight: 640,
    title: 'Q问 · 我心永恒',
    // 与主站 --bg 一致，避免加载瞬间白闪（配色一致性从这里开始）
    backgroundColor: '#0f0e17',
    autoHideMenuBar: true,
    icon: resolveAsset('tray.png') || undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 语音输入需要麦克风；权限在 session 层统一判定（见 lockDownPermissions）
      backgroundThrottling: true,
    },
  });

  if (st.maximized) mainWindow.maximize();

  mainWindow.loadURL(APP_URL).catch((err) => log('[window] loadURL 失败', err));

  // 加载失败给可重试的提示页，而不是白屏
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    if (String(url).startsWith('devtools://')) return;
    // -3 是 ABORTED：用户主动刷新/跳转时会触发，不是故障
    if (code === -3) return;
    log('[window] did-fail-load', code, desc, url);
    showOfflinePage(code, desc);
  });

  // 新窗口/外链一律交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  // 窗口内导航只允许受信主机；其余外链交给系统浏览器
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (isTrustedUrl(url)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
  });

  // 禁止页面挂 <webview>：我们不用它，放开只会扩大攻击面
  mainWindow.webContents.on('will-attach-webview', (e) => {
    e.preventDefault();
    log('[security] 已拦截 webview 挂载');
  });

  // 渲染进程崩溃/无响应：自动重载一次，仍然失败则提示用户
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log('[crash] render-process-gone', details);
    if (details?.reason === 'clean-exit') return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.reload();
    }
  });
  mainWindow.on('unresponsive', () => {
    log('[crash] unresponsive');
    if (!mainWindow) return;
    dialog
      .showMessageBox(mainWindow, {
        type: 'warning',
        title: '界面无响应',
        message: 'Q问 界面暂时没有响应，通常是网络或代理导致的。',
        buttons: ['继续等待', '重新加载'],
        defaultId: 1,
        cancelId: 0,
      })
      .then((r) => {
        if (r.response === 1 && mainWindow) mainWindow.webContents.reload();
      });
  });

  // 关闭行为：默认收进托盘（桌面客户端习惯）；用户选"退出"才真退
  mainWindow.on('close', (e) => {
    saveWindowState();
    if (minimizeToTray && tray && !app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      if (process.platform === 'win32' && tray.displayBalloon) {
        // 只提示一次，避免每次关窗都弹气泡烦人
        if (!tray.__balloonShown) {
          tray.__balloonShown = true;
          tray.displayBalloon({ title: 'Q问 仍在运行', content: '从托盘图标可以重新打开。' });
        }
      }
    }
  });

  mainWindow.on('closed', () => {
    saveWindowState();
    mainWindow = null;
  });

  // 记住最大化/还原后的尺寸
  mainWindow.on('resize', debounce(saveWindowState, 400));
  mainWindow.on('move', debounce(saveWindowState, 400));
}

/**
 * 加载失败页：带「重试」与「打开网页版」。
 * 不做本地 H5 兜底（原因见文件头）—— 离线时 AI 问答本来就用不了，
 * 给一个旧界面只会让人以为"界面是新的、功能坏了"。
 */
function showOfflinePage(code, desc) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const html = `<!doctype html><meta charset="utf-8">
<body style="margin:0;background:#0f0e17;color:#f5f5f7;font-family:system-ui,'Microsoft YaHei',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
<div style="max-width:420px;text-align:center;padding:0 24px">
  <div style="font-size:20px;font-weight:600;margin-bottom:12px">连不上 qtvq.cn</div>
  <div style="color:#a0a0b0;font-size:14px;line-height:1.7;margin-bottom:24px">
    错误：${escapeHtml(String(desc || ''))}（${escapeHtml(String(code))}）<br>
    请检查网络、VPN 或代理设置后重试。
  </div>
  <button onclick="location.href='${APP_URL}'"
    style="background:#ff6b81;color:#fff;border:0;border-radius:8px;padding:10px 22px;font-size:14px;cursor:pointer">重试</button>
</div></body>`;
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* ────────────────────────── 权限 ────────────────────────── */

/** 只放行本站 + 这几类权限；其余（地理位置、串口、USB…）一律拒绝 */
function lockDownPermissions(ses) {
  const ALLOWED = new Set(['media', 'clipboard-sanitized-write', 'notifications', 'fullscreen']);
  const allowed = (permission, requestingUrl) =>
    ALLOWED.has(permission) && isTrustedUrl(requestingUrl || '');

  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(allowed(permission, details?.requestingUrl));
  });
  // 有些 API 只走 check 不走 request（如 enumerateDevices 前的查询），两个都要设，
  // 否则出现"授权弹窗没弹、但设备也拿不到"的哑状态。
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    allowed(permission, requestingOrigin),
  );
}

/* ────────────────────────── 托盘 ────────────────────────── */

/**
 * 托盘图标路径。**不能用 build/ 目录**：electron-builder 的 files 白名单里没有它，
 * 打包后 build/ 不存在 —— 这正是上一版托盘从来没生效过的原因（代码在、图标找不到、
 * setupTray 静默 return）。现在图标放在 src/assets/，随 src/**\/* 一起打包。
 */
function resolveAsset(name) {
  const p = path.join(__dirname, 'assets', name);
  return fs.existsSync(p) ? p : null;
}

function setupTray() {
  const iconPath = resolveAsset('tray.png');
  if (!iconPath) {
    log('[tray] 找不到 src/assets/tray.png，托盘不可用');
    return;
  }
  try {
    const img = nativeImage.createFromPath(iconPath);
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    tray.setToolTip('Q问 · 我心永恒');
    rebuildTrayMenu();
    tray.on('click', () => showWindow());
    tray.on('double-click', () => showWindow());
  } catch (err) {
    log('[tray] 初始化失败（忽略）', err);
  }
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 Q问', click: () => showWindow() },
      { type: 'separator' },
      {
        label: IS_PORTABLE ? '检查更新（免安装版请手动下载新版）' : '检查更新',
        enabled: Boolean(updater),
        click: () => checkForUpdates(true),
      },
      {
        label: '关闭窗口时最小化到托盘',
        type: 'checkbox',
        checked: minimizeToTray,
        click: (item) => {
          minimizeToTray = item.checked;
        },
      },
      { type: 'separator' },
      {
        label: `版本 ${SHELL_VERSION}`,
        enabled: false,
      },
      {
        label: '退出',
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/* ────────────────────────── 自动更新（壳） ────────────────────────── */

function setupUpdater() {
  if (IS_PORTABLE) {
    log('[update] 免安装版，跳过 electron-updater（portable 无法被 NSIS 更新流程覆盖）');
    return;
  }
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    log('[update] electron-updater 未安装，跳过壳更新', err);
    return;
  }
  updater = autoUpdater;

  // 只有显式指定 feed 时才覆盖 app-update.yml，避免本地调试意外改坏发布源
  if (process.env.QTVQ_UPDATE_FEED) {
    try {
      updater.setFeedURL({ provider: 'generic', url: UPDATE_FEED });
    } catch (err) {
      log('[update] setFeedURL 失败（沿用 app-update.yml）', err);
    }
  }

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.logger = { info: log, warn: log, error: log, debug: () => {} };

  updater.on('error', (err) => {
    log('[update] 检查失败', err);
    // 自动检查失败保持安静（断网/未发布都属正常）；手动检查必须告诉用户
    if (manualCheckPending) {
      manualCheckPending = false;
      clearProgress();
      dialog.showMessageBox({
        type: 'warning',
        title: '检查更新失败',
        message: '暂时无法获取更新信息，请稍后再试。',
        detail: String(err?.message || err).slice(0, 300),
        buttons: ['好'],
      });
    }
  });

  updater.on('update-not-available', () => {
    clearProgress();
    if (manualCheckPending) {
      manualCheckPending = false;
      dialog.showMessageBox({
        type: 'info',
        title: '已是最新版本',
        message: `当前版本 ${SHELL_VERSION} 已是最新。`,
        buttons: ['好'],
      });
    }
  });

  updater.on('update-available', (info) => {
    log('[update] 发现新版本', info?.version);
  });

  updater.on('download-progress', (p) => {
    // 下载进度画在任务栏图标上，比弹窗打扰小
    if (mainWindow && !mainWindow.isDestroyed() && Number.isFinite(p?.percent)) {
      mainWindow.setProgressBar(Math.max(0, Math.min(1, p.percent / 100)));
    }
  });

  updater.on('update-downloaded', (info) => {
    clearProgress();
    manualCheckPending = false;
    // 不静默安装：装到一半重启会打断用户
    dialog
      .showMessageBox(mainWindow || undefined, {
        type: 'info',
        title: '新版本已就绪',
        message: `Q问 ${info?.version} 已下载完成，重启后生效。`,
        buttons: ['立即重启', '稍后'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .then((r) => {
        if (r.response === 0) {
          app.isQuitting = true;
          updater.quitAndInstall(false, true);
        }
      });
  });

  // 启动 15 秒后检查一次（避开启动高峰），之后每 4 小时一次
  setTimeout(() => updater.checkForUpdates().catch((e) => log('[update]', e)), 15000);
  setInterval(() => updater.checkForUpdates().catch((e) => log('[update]', e)), 4 * 60 * 60 * 1000);
}

function clearProgress() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1);
}

async function checkForUpdates(manual) {
  if (!updater) {
    if (manual) {
      await dialog.showMessageBox({
        type: 'info',
        title: '检查更新',
        message: IS_PORTABLE ? '免安装版不支持自动更新' : '更新组件不可用',
        detail: IS_PORTABLE
          ? '请到 https://qtvq.cn/download.html 下载新版免安装包。'
          : '当前为开发模式或更新组件未加载。',
        buttons: ['好'],
      });
    }
    return;
  }
  manualCheckPending = Boolean(manual);
  try {
    await updater.checkForUpdates();
  } catch (err) {
    log('[update] checkForUpdates 抛错', err);
    if (manualCheckPending) {
      manualCheckPending = false;
      dialog.showMessageBox({ type: 'warning', message: '检查更新失败，请稍后再试', buttons: ['好'] });
    }
  }
}

/* ────────────────────────── 菜单 ────────────────────────── */

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '文件',
        submenu: [
          { label: '打开网页版', click: () => shell.openExternal(APP_URL) },
          { label: '打开下载页', click: () => shell.openExternal(`${APP_URL}/download.html`) },
          { type: 'separator' },
          {
            label: '开机自动启动',
            type: 'checkbox',
            checked: getAutoLaunch(),
            click: (item) => setAutoLaunch(item.checked),
          },
          { type: 'separator' },
          {
            label: '退出',
            click: () => {
              app.isQuitting = true;
              app.quit();
            },
          },
        ],
      },
      {
        label: '查看',
        submenu: [
          { role: 'reload', label: '刷新' },
          { role: 'forceReload', label: '强制刷新' },
          ...(app.isPackaged ? [] : [{ role: 'toggleDevTools', label: '开发者工具' }]),
          { type: 'separator' },
          { role: 'resetZoom', label: '实际大小' },
          { role: 'zoomIn', label: '放大' },
          { role: 'zoomOut', label: '缩小' },
        ],
      },
      {
        label: '窗口',
        submenu: [
          { role: 'minimize', label: '最小化' },
          {
            label: '收进托盘',
            click: () => mainWindow && mainWindow.hide(),
          },
        ],
      },
      {
        label: '帮助',
        submenu: [
          { label: '使用帮助', click: () => shell.openExternal(`${APP_URL}/help.html`) },
          { label: '隐私说明', click: () => shell.openExternal(`${APP_URL}/privacy.html`) },
          { label: '用户协议', click: () => shell.openExternal(`${APP_URL}/terms.html`) },
          { type: 'separator' },
          { label: '检查更新', click: () => checkForUpdates(true) },
          {
            label: '打开日志目录',
            click: () => shell.openPath(path.join(app.getPath('userData'), 'logs')),
          },
          {
            label: '关于',
            click: () =>
              dialog.showMessageBox({
                type: 'info',
                title: '关于 Q问',
                message: `Q问 ${SHELL_VERSION}`,
                detail: [
                  `Electron ${process.versions.electron}`,
                  `Chromium ${process.versions.chrome}`,
                  IS_PORTABLE ? '免安装版' : '安装版',
                  'https://qtvq.cn',
                ].join('\n'),
                buttons: ['好'],
              }),
          },
        ],
      },
    ]),
  );
}

function getAutoLaunch() {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}
function setAutoLaunch(enable) {
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(enable) });
    // 同步托盘里那项开关的状态显示
    rebuildTrayMenu();
  } catch (err) {
    log('[autolaunch] 设置失败', err);
  }
}

/* ────────────────────────── 杂项 ────────────────────────── */

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/* ────────────────────────── 启动 ────────────────────────── */

// 单实例：重复启动时聚焦已有窗口（否则会出现多个托盘图标与多份更新检查）
const gotSingleLock = app.requestSingleInstanceLock();
bootMark(`singleInstanceLock=${gotSingleLock}`);
if (!gotSingleLock) {
  // 注意：ready 之前 app.quit() 有可能不干净地退出，但这属于正常路径（用户重复双击）
  bootMark('another instance is running, quit this one');
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    bootMark('app ready');
    // Windows 必须设，否则通知不显示、任务栏会出现两个图标
    if (process.platform === 'win32') {
      try {
        app.setAppUserModelId('cn.qtvq.desktop');
      } catch (err) {
        log('[boot] setAppUserModelId 失败（继续）', err);
      }
    }

    initLog();
    log(
      `[boot] Q问 ${SHELL_VERSION} portable=${IS_PORTABLE} electron=${process.versions.electron} ` +
        `userData=${safeUserData()}`,
    );

    /*
     * 逐步启动并逐步记日志。
     * 为什么：打包后的 exe 一旦某步抛错，用户看到的是"双击没反应"，
     * 而没有分步日志就只能靠猜。这里任何一步失败都不再拖垮后续步骤。
     */
    const step = (name, fn) => {
      try {
        fn();
        log(`[boot] ${name} ok`);
        bootMark(`${name} ok`);
      } catch (err) {
        log(`[boot] ${name} 失败`, err);
        bootMark(`${name} 失败: ${err && err.message}`);
      }
    };

    step('permissions', () => lockDownPermissions(session.defaultSession));
    step('menu', buildMenu);
    step('window', createWindow);
    step('tray', setupTray);
    step('updater', setupUpdater);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // 有托盘时关窗口只是隐藏；真正退出走托盘/菜单里的"退出"（会置 app.isQuitting）
  app.on('window-all-closed', () => {
    if (process.platform === 'darwin') return;
    if (minimizeToTray && tray) return; // 托盘还在，保持后台
    app.quit();
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    saveWindowState();
    if (logStream) {
      try {
        logStream.end();
      } catch {
        /* ignore */
      }
    }
  });
}
