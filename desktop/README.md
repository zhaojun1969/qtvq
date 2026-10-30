# Q问 桌面客户端（Electron 壳）

薄壳：窗口 + 托盘 + 系统集成 + 整包自动更新。**界面就是 https://qtvq.cn 本身**。

## 为什么不内嵌 H5 产物

1.0.6 及其之前会把打包时的 H5 快照放进 `web/` 并用 `loadFile` 加载。后果不是打不开，
而是更隐蔽：界面、文案、配色、支付流程**冻结在发版那天**，主站改了它不变。
每改一次 UI 还要重新发 80MB 安装包。

现在直接 `loadURL('https://qtvq.cn')`：服务端一发布，用户刷新即新版。

> 实测澄清（2026-10-30）：Electron 33 下 file:// 页面发出的跨域请求**不带 Origin 头**
> （`GET /api/quota`、`POST /api/chat` 都验证过），服务端 `if (!origin) return cb(null, true)`
> 会放行 —— 所以旧架构接口其实是通的，不是"CORS 403"。
> 别用 `curl -H 'Origin: null'` 的结果去推断，那是人为构造的字符串。

代价：彻底离线不可用。AI 问答本来就必须联网，给一个"能点但全是报错"的离线旧界面
只会制造误解，所以离线时给明确的提示页 + 重试。

## 目录

```
src/main.js          主进程（窗口/托盘/菜单/权限/更新/日志/窗口状态）
src/assets/tray.png  托盘图标 —— 必须在 src/ 下，因为 electron-builder 的 files 白名单
                     不含 build/，放 build/ 里打包后就找不到（1.0.6 托盘从来没生效过）
preload/index.js     contextBridge，暴露面只有 5 个只读字段 + 2 个动作
scripts/smoke.js     运行时冒烟：真实开窗口，验 preload 注入 + 接口可用 + 无 Node 能力
build/               编译期资源（安装包图标），不进包
```

## 命令

```bash
npm run check    # 语法检查
npm run smoke    # 运行时冒烟（需要真实桌面会话，约 10 秒）
npm run dist     # 打包 nsis + portable → 输出到 ../dist/desktop-release
npm run dist:nsis
```

打包产物直接落在 `dist/desktop-release/`（`build.directories.output`），因为那正是上传脚本
读取的目录，省一次拷贝。

> 不要用 `-c.directories.output=...` 从命令行覆盖输出目录：实测这样会连 `productName`
> 一起丢掉，打出来的 exe 变成 `qtvq-desktop.exe`、安装包变成 `qtvq-desktop Setup 1.0.7.exe`
> —— 体积和名字都不同，上传时极易传错版本。要改就改 `package.json` 的 `build` 字段。

冒烟若报 `Cannot read properties of undefined (reading 'whenReady')`，
说明当前 shell 里 `ELECTRON_RUN_AS_NODE=1`（被宿主进程传染），用
`env -u ELECTRON_RUN_AS_NODE npm run smoke` 跑。

## 怎么验收（重要）

**能从终端验证的**（`npm run smoke`）：
preload 注入、页面里无 Node 能力、GET/POST 接口可用、壳版本号正确。

**只能双击验收的**：窗口是否真的弹出来。
用 `Start-Process` / bash 从终端启动 GUI 进程时，实测会出现"进程存活但无窗口、
不写日志"的现象，而且**连原始 `electron.exe` 的副本也一样** —— 所以这不是包的缺陷，
是这种无界面启动方式本身不可靠。别在这上面耗时间，直接双击安装包看。

出问题时的取证顺序：
1. `%APPDATA%\qtvq-desktop\logs\main.log` —— 正常日志（帮助菜单里有"打开日志目录"）
2. `%TEMP%\qtvq-desktop.bootstrap.log` —— 极早期诊断，能证明主进程跑到哪一步
   （`module loaded` → `singleInstanceLock` → `app ready` → 各 step ok）。
   连这一行都没有，说明 Electron 根本没加载到 main.js，问题在 exe 或资源层。

## 发版流程

```bash
# 1. 升 desktop/package.json 的 version
npm run dist

# 2. 同步以下三处到同一版本（否则"下载页给一个包、自动更新给另一个包"）
#    release-links.json → windows.version / windows.url
#    app-releases.json  → windows.version / downloadUrl
#    node tools/scripts/write-download-config.mjs
#    node tools/scripts/write-app-releases.mjs && node tools/scripts/write-release-manifest.mjs

# 3. 校验 + 上传（会校验 latest.yml 引用的包真能下载、长度一致）
node tools/scripts/publish-desktop-release.mjs
powershell -File ../tools/scripts/upload-desktop-ssh.ps1
```

## 已知限制

- 免安装版（portable）**不支持**自动更新：electron-builder 的 portable 不是 NSIS 安装流程，
  electron-updater 对它无效。壳里检测 `PORTABLE_EXECUTABLE_DIR` 后直接跳过，并提示去下载页。
- 安装包**未做代码签名**：Windows SmartScreen 会提示"未知发布者"。要消除需购买
  EV/OV 代码签名证书并配置 `win.certificateFile`。
- **别在 `desktop/` 目录里执行 `asar extract-file ... package.json`**：它会把 asar 里的
  精简版 package.json 解到**当前目录**，直接覆盖桌面端的 `package.json`，
  把 `build` / `scripts` / `devDependencies` 全部冲掉。2026-10-30 踩过一次 ——
  之后两次打包都用了残缺配置，产物名与体积都变了。要检查 asar 用 `asar extract` 到临时目录。
