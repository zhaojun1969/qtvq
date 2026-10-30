/**
 * 桌面壳运行时冒烟测试（脚本会在真实 Electron 里跑，不是静态检查）
 *
 * 用法：cd desktop && npm run smoke
 *   退出码 0 = 通过；2 = 超时；3 = 主文档加载失败；4 = 探测脚本报错
 *
 * 为什么需要它：静态检查只能看"代码里写了 sandbox:true"，看不出
 *   ① 页面真能加载吗；② preload 真的注入了吗；③ 从页面里 fetch 自家 API 会不会被 CORS 拦。
 * 第 ③ 条正是 1.0.6 的病根（file:// 的 Origin=null → 403 E_CORS），
 * 只有真的开一个窗口跑起来才验证得到。
 *
 * 窗口 `show:false`，不弹界面，几秒内自退。
 */
const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('node:path');

/** 抓真实发出的 Origin 头：判断 CORS 问题时不能靠推断 */
const seenOrigin = [];
function watchOriginHeaders() {
  try {
    session.defaultSession.webRequest.onBeforeSendHeaders(
      { urls: ['https://qtvq.cn/*'] },
      (details, cb) => {
        const h = details.requestHeaders || {};
        const origin = h.Origin || h.origin || '(无 Origin 头)';
        if (seenOrigin.length < 8) {
          seenOrigin.push(`${details.method} ${details.url.replace('https://qtvq.cn', '').slice(0, 30)} → Origin: ${origin}`);
        }
        cb({ requestHeaders: details.requestHeaders });
      },
    );
  } catch (err) {
    seenOrigin.push(`(抓包失败: ${err.message})`);
  }
}

const TARGET = process.env.QTVQ_DESKTOP_URL || 'https://qtvq.cn';
const API = process.env.QTVQ_PROBE_API || 'https://qtvq.cn/v1/health';

/**
 * 必须复刻主进程的 IPC 处理器，否则 sandbox 里的 preload 调用
 * `ipcRenderer.sendSync('qtvq:get-info')` 会拿到 undefined 并打警告 ——
 * 那样冒烟测的就不是真实链路了。
 *
 * 版本号读 package.json 而不是 app.getVersion()：本脚本入口不是 `electron .`，
 * app.getVersion() 会返回 Electron 自身版本（33.x），与打包后行为不一致。
 */
const pkg = require('../package.json');
ipcMain.on('qtvq:get-info', (e) => {
  e.returnValue = { shellVersion: pkg.version, isPortable: false, platform: process.platform };
});
ipcMain.on('qtvq:open-external', () => {});

let finished = false;
function finish(code, message) {
  if (finished) return;
  finished = true;
  // eslint-disable-next-line no-console
  console.log(message);
  app.exit(code);
}

const timer = setTimeout(() => finish(2, '❌ 超时：30 秒内没完成加载'), 30000);
timer.unref?.();

app.whenReady().then(() => {
  watchOriginHeaders();
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = 用户/程序主动中止
    finish(3, `❌ 主文档加载失败：${code} ${desc} (${url})`);
  });

  // 定位用：卡住时能看出是"根本没拿到 DOM"还是"拿 DOM 了但 onload 不来"
  win.webContents.on('dom-ready', () => {
    if (process.env.QTVQ_SMOKE_VERBOSE) console.log('· dom-ready');
  });

  win.webContents.on('did-finish-load', async () => {
    try {
      const probe = await win.webContents.executeJavaScript(`(async () => {
        const d = window.qtvqDesktop || null;
        let apiStatus = 'n/a';
        let apiBody = '';
        try {
          const r = await fetch(${JSON.stringify(API)}, { headers: { Accept: 'application/json' } });
          apiStatus = r.status;
          apiBody = (await r.text()).slice(0, 120);
        } catch (e) {
          apiStatus = 'NETWORK_ERROR';
          apiBody = String(e && e.message);
        }

        /*
         * 简单 GET 不足以证明链路可用：不带 Origin 的请求会被服务端
         * \`if (!origin) return cb(null, true)\` 放过。真正会挂的是
         * 「POST + application/json」—— 它必然先发 CORS 预检（OPTIONS），
         * 预检一定带 Origin。登录、问答、钱包全是这种请求。
         */
        let postStatus = 'n/a';
        let postError = '';
        try {
          const r = await fetch(${JSON.stringify(API.replace('/v1/health', '/api/chat'))}, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'smoke' }),
            credentials: 'include',
          });
          postStatus = r.status;
        } catch (e) {
          postStatus = 'CORS_OR_NETWORK';
          postError = String(e && e.message);
        }

        return {
          origin: location.origin,
          title: document.title,
          hasBridge: !!d,
          bridgeKeys: d ? Object.keys(d) : [],
          shellVersion: d ? d.shellVersion : '',
          isPortable: d ? d.isPortable : null,
          // 页面里不该存在任何 Node 能力
          hasNodeRequire: typeof window.require === 'function',
          hasProcess: typeof window.process !== 'undefined',
          apiStatus,
          apiBody,
          postStatus,
          postError,
        };
      })()`);

      const problems = [];
      if (!probe.hasBridge) problems.push('preload 未注入（window.qtvqDesktop 不存在）');
      if (!probe.shellVersion) problems.push('shellVersion 为空（sendSync 通道没通）');
      if (probe.hasNodeRequire) problems.push('页面里能用 require —— nodeIntegration 没关掉');
      if (probe.origin === 'null') problems.push('页面跑在 null origin，接口必被 CORS 拦');
      if (Number(probe.apiStatus) !== 200) problems.push(`探测接口返回 ${probe.apiStatus}（期望 200）`);
      if (probe.postStatus === 'CORS_OR_NETWORK')
        problems.push(
          `POST+JSON 被跨域拦下（${probe.postError.slice(0, 80)}）—— 登录/问答/钱包都会失败`,
        );
      else if (probe.postStatus === 0 || probe.postStatus === '0')
        problems.push('POST+JSON 无响应（0）—— 预检被拒');

      clearTimeout(timer);
      const lines = [
        `目标      ${TARGET}`,
        `origin    ${probe.origin}`,
        `标题      ${probe.title}`,
        `bridge    ${probe.hasBridge ? '✓ 已注入' : '✗ 缺失'}  keys=${probe.bridgeKeys.join(',')}`,
        `壳版本    ${probe.shellVersion || '(空)'}  portable=${probe.isPortable}`,
        `页面 Node ${probe.hasNodeRequire ? '✗ 可访问 require' : '✓ 无'}`,
        `GET 探测  ${probe.apiStatus}`,
        `POST 探测 ${probe.postStatus}${probe.postError ? ' ' + probe.postError.slice(0, 60) : ''}`,
        ...(seenOrigin.length ? ['实际请求头：', ...seenOrigin.map((s) => '  ' + s)] : []),
      ];
      if (problems.length) {
        finish(5, `❌ 冒烟未通过\n${lines.join('\n')}\n问题：\n  - ${problems.join('\n  - ')}`);
      } else {
        finish(0, `✅ 冒烟通过\n${lines.join('\n')}`);
      }
    } catch (err) {
      clearTimeout(timer);
      finish(4, `❌ 探测脚本报错：${err?.message || err}`);
    }
  });

  win.loadURL(TARGET).catch((err) => finish(3, `❌ loadURL 抛错：${err?.message || err}`));
});
