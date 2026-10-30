/**
 * 预加载脚本（contextBridge）
 *
 * 桌面壳与页面之间**唯一**的通道。页面通过 `window.qtvqDesktop` 拿到少量只读信息
 * 与两个安全动作；除此之外没有任何 Node 能力 ——
 * contextIsolation:true + nodeIntegration:false + sandbox:true 是刻意的：
 * 一旦把 Node 暴露给页面，任何一个 XSS 都能读写用户磁盘。
 *
 * 版本号为什么用 sendSync 取、不读 process.env：
 * sandbox:true 的 preload 里 process 是受限 polyfill，之前用
 * `process.env.QTVQ_SHELL_VERSION` 传值实际拿不到（菜单里版本号一直是空的）。
 * 同步 IPC 只走一次、几毫秒，换来的是确定能拿到。
 */
const { contextBridge, ipcRenderer } = require('electron');

let info = { shellVersion: '', isPortable: false, platform: process.platform };
try {
  info = ipcRenderer.sendSync('qtvq:get-info') || info;
} catch {
  // 主进程还没注册 handler（极早期）时保持默认值，不让页面因此报错
}

contextBridge.exposeInMainWorld('qtvqDesktop', {
  /** 供前端判断"运行在桌面客户端里"（utils/platform.js / update.js 可用） */
  isDesktop: true,
  /** 'win32' / 'darwin' / 'linux' */
  platform: info.platform || process.platform,
  /** 壳（安装包）版本号，与页面版本是两回事 */
  shellVersion: String(info.shellVersion || ''),
  /** 免安装版：不支持自动更新，页面可以据此隐藏"立即更新"之类入口 */
  isPortable: Boolean(info.isPortable),

  /** 用系统默认浏览器打开外链（客户端内不开新窗口） */
  openExternal: (url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      ipcRenderer.send('qtvq:open-external', url);
    }
  },

  /** 请求壳检查更新（页面做"检查更新"按钮时用） */
  checkForUpdates: () => ipcRenderer.send('qtvq:check-updates'),
});
