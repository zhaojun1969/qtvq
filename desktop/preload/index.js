/**
 * 预加载脚本（contextBridge）
 *
 * 桌面壳与页面之间**唯一**的通道。页面（我们自己的 H5）通过 `window.qtvqDesktop` 拿到
 * 少量只读信息与安全动作；除此之外页面没有任何 Node 能力 ——
 * `contextIsolation: true` + `nodeIntegration: false` + `sandbox: true` 是刻意的选择：
 * 一旦把 Node 暴露给页面，任何一个 XSS 都能读写用户磁盘。
 *
 * 暴露的东西刻意保持很小：越多能力越难审计，而桌面端真正"必须"由壳提供的其实只有
 * 「我是桌面端/我的版本号」和「用系统浏览器打开外链」。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qtvqDesktop', {
  /** 供前端判断"运行在桌面客户端里"（utils/platform.js / update.js 可用） */
  isDesktop: true,
  platform: process.platform,
  /** 壳的版本号（H5 里拿不到 electron 的 app.getVersion） */
  shellVersion: process.env.QTVQ_SHELL_VERSION || '',
  /** 用系统默认浏览器打开外链（客户端内不开新窗口） */
  openExternal: (url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) {
      ipcRenderer.send('qtvq:open-external', url);
    }
  },
});
