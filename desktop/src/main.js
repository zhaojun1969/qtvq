/**
 * Q问 Windows 桌面客户端（Electron 主进程）
 *
 * 定位（说清楚，避免误解）：这是一个**薄壳**客户端 —— 界面复用的是同一套 H5/网页实现，
 * 桌面端负责窗口、托盘、系统集成与**整包自动更新**。为什么不重新做一套原生界面：
 * 业务逻辑、支付、审核流程全在服务端与同一份前端里，壳内重写会立刻产生两套要同步的 UI，
 * 而本项目已多次因"两端各写一份"产生分叉（举报原因、支付渠道都是例子）。
 *
 * 更新分两层，两层都要：
 *   ① **壳的更新**（本文件）：electron-updater 走 `https://qtvq.cn/release/desktop/`，
 *      发现新版本 → 下载 → 提示重启。这解决"打包进壳里的东西变了"。
 *   ② **页面更新**：因为界面走 https://qtvq.cn，服务端一发布用户刷新就是新版
 *      （apps/qtvq-uni/src/utils/update.js 里还有版本轮询提示），不必等客户端发版。
 *
 * 安全边界（刻意这么设）：
 *   · `contextIsolation: true` + `nodeIntegration: false`：页面里没有任何 Node 能力；
 *   · 只允许 http(s) 与站内地址在窗口内打开，其它一律交给系统浏览器；
 *   · 不开 `webSecurity: false`（那等于关掉同源策略，一个 XSS 就能读本地文件）。
 */
const { app, BrowserWindow, Menu, shell, dialog, Tray, nativeImage, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

/** 主站地址：可用环境变量覆盖（便于本地联调与灰度） */
const APP_URL = process.env.QTVQ_DESKTOP_URL || 'https://qtvq.cn';
/** 更新源：与 release-links.json / version.json 同一套发布产物 */
const UPDATE_FEED = process.env.QTVQ_UPDATE_FEED || 'https://qtvq.cn/release/desktop/';

// 预加载脚本要用它把"壳版本"告诉页面（页面里读取不到 electron 的 app）
process.env.QTVQ_SHELL_VERSION = app.getVersion();

// 渲染进程请求用系统浏览器打开链接（只接受 http/https，防止 file:// 等协议被滥用）
ipcMain.on('qtvq:open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});

let mainWindow = null;
let tray = null;
let updater = null;

/** 本地打包的网页（存在则优先用；不存在就直连主站） */
function localWebEntry() {
  const p = path.join(__dirname, '..', 'web', 'index.html');
  return fs.existsSync(p) ? p : null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    title: 'Q问 · 我心永恒',
    backgroundColor: '#0f0e17',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 允许语音输入（getUserMedia）——麦克风权限由 Electron 在 session 层统一处理
      spellcheck: false,
    },
  });

  const local = localWebEntry();
  if (local) {
    mainWindow.loadFile(local).catch(() => mainWindow.loadURL(APP_URL));
  } else {
    mainWindow.loadURL(APP_URL);
  }

  // 离线兜底：加载失败时给一个可读的提示页，而不是白屏
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (String(url).startsWith('devtools://')) return;
    mainWindow.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          `<body style="background:#0f0e17;color:#f5f5f7;font-family:sans-serif;padding:40px">
             <h2>无法连接 qtvq.cn</h2>
             <p>错误：${desc}（${code}）</p>
             <p>请检查网络后重试；网页版仍可访问 https://qtvq.cn</p>
           </body>`,
        ),
    );
  });

  // 新窗口/外链一律交给系统浏览器，客户端内不开第二个窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const okInternal = url.startsWith(APP_URL);
    const okLocal = local && url.startsWith('file://');
    if (!okInternal && !okLocal) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** 麦克风/摄像头等权限：只放行本站与本地页面，其余一律拒绝 */
function lockDownPermissions(session) {
  const ALLOWED = ['media', 'clipboard-sanitized-write', 'notifications'];
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = details?.requestingUrl || webContents.getURL() || '';
    const fromSite = url.startsWith(APP_URL) || url.startsWith('file://');
    callback(fromUsable(ALLOWED, permission) && fromSite);
  });
}
function fromUsable(list, p) {
  return list.includes(p);
}

/**
 * 自动更新（壳）。
 *
 * 用 `electron-updater` + generic provider（静态文件托管），发布端只需把
 * `latest.yml` + 安装包放到 `https://qtvq.cn/release/desktop/`。
 * 之所以不用 GitHub Releases：本项目发布通道是自家域名（与静态站同一套），
 * 少一个需要维护的境外依赖。
 */
function setupUpdater() {
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.warn('[update] electron-updater 未安装，跳过壳更新：', err?.message || err);
    return;
  }
  updater = autoUpdater;
  updater.autoDownload = true;
  // 不静默安装：装到一半重启会打断用户，必须先问
  updater.autoInstallOnAppQuit = true;
  updater.logger = console;

  updater.on('error', (err) => {
    // 更新失败绝不打扰用户（网络/未发布都属正常），只记日志
    console.warn('[update] 检查更新失败（忽略）：', err?.message || err);
  });
  updater.on('update-available', (info) => {
    console.log('[update] 发现新版本', info?.version);
  });
  updater.on('update-downloaded', (info) => {
    dialog
      .showMessageBox(mainWindow, {
        type: 'info',
        title: '新版本已就绪',
        message: `Q问 ${info?.version} 已下载完成，重启后生效。`,
        buttons: ['立即重启', '稍后'],
        defaultId: 0,
        cancelId: 1,
      })
      .then((r) => {
        if (r.response === 0) updater.quitAndInstall();
      });
  });

  // 启动后 10 秒检查一次（避开启动高峰），之后每 3 小时一次
  setTimeout(() => {
    updater.checkForUpdates().catch(() => {});
  }, 10000);
  setInterval(
    () => {
      updater.checkForUpdates().catch(() => {});
    },
    3 * 60 * 60 * 1000,
  );
}

/** 托盘：关窗口不退出（桌面客户端的常规行为），托盘菜单可显式退出 */
function setupTray() {
  const iconPath = path.join(__dirname, '..', 'build', 'tray.png');
  if (!fs.existsSync(iconPath)) return;
  try {
    tray = new Tray(nativeImage.createFromPath(iconPath));
    tray.setToolTip('Q问');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: '打开 Q问',
          click: () => {
            if (mainWindow) mainWindow.show();
            else createWindow();
          },
        },
        {
          label: '检查更新',
          click: () => updater?.checkForUpdates().catch(() => {}),
        },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() },
      ]),
    );
    tray.on('click', () => (mainWindow ? mainWindow.show() : createWindow()));
  } catch (err) {
    console.warn('[tray] 托盘图标初始化失败（忽略）：', err?.message || err);
  }
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '文件',
        submenu: [
          { label: '打开网页版', click: () => shell.openExternal(APP_URL) },
          { type: 'separator' },
          { role: 'quit', label: '退出' },
        ],
      },
      {
        label: '查看',
        submenu: [
          { role: 'reload', label: '刷新' },
          { role: 'forceReload', label: '强制刷新' },
          { role: 'toggleDevTools', label: '开发者工具' },
          { type: 'separator' },
          { role: 'resetZoom', label: '实际大小' },
          { role: 'zoomIn', label: '放大' },
          { role: 'zoomOut', label: '缩小' },
        ],
      },
      {
        label: '帮助',
        submenu: [
          { label: '客户端下载页', click: () => shell.openExternal(`${APP_URL}/download.html`) },
          { label: '使用帮助', click: () => shell.openExternal(`${APP_URL}/help.html`) },
          { label: '隐私说明', click: () => shell.openExternal(`${APP_URL}/privacy.html`) },
          {
            label: '检查更新',
            click: () => {
              if (!updater) return dialog.showMessageBox({ message: '更新组件不可用', buttons: ['好'] });
              updater.checkForUpdates().then(
                (r) =>
                  !r?.updateInfo &&
                  dialog.showMessageBox({ message: '当前已是最新版本', buttons: ['好'] }),
                () => dialog.showMessageBox({ message: '检查更新失败，请稍后再试', buttons: ['好'] }),
              );
            },
          },
        ],
      },
    ]),
  );
}

// 单实例：重复启动时聚焦已有窗口（否则会出现多个托盘图标与多份更新检查）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    lockDownPermissions(require('electron').session.defaultSession);
    buildMenu();
    createWindow();
    setupTray();
    setupUpdater();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // 关掉所有窗口就退出（配合托盘的版本可改成 hide，这里保持简单可控）
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
