/**
 * ⚠️ 本文件由 tools/scripts/write-app-releases.mjs 生成，请勿手改。
 * 唯一数据源：app-releases.json（仓库根）
 * 用途：Cloudflare Pages（`/api/app/bootstrap`）
 * 生成时间：2026-11-15T02:56:25.819Z
 *
 * 各端发布记录 —— 版本/更新的唯一数据源。JSON 不能带注释，说明写在这里。
 * 谁在用它：① Node 服务 GET /v1/app/bootstrap?channel=&version=（各端专用端口）；
 * ② tools/scripts/write-release-manifest.mjs 生成静态站 release/version.json（H5/桌面兜底轮询）。
 * 没有列出的端按出厂基线 1.0.0『已最新』处理 —— 但那会让 bootstrap 回 latest:1.0.0，
 *   比客户端实际的 1.0.6 还低，语义是错的（端侧若按 latest>current 判断，永远收不到更新）。
 *   所以 2026-10-28 把**所有已有分发形态的端**都补进来：8 个小程序 + web + windows。
 * 字段：version 最新版本（1~4 段纯数字）/ minVersion 低于它才强制 / mode silent|prompt|force /
 *       notes 更新说明 / downloadUrl 下载或安装地址（App、桌面端必填，小程序端由平台托管可留空）/ publishedAt。
 * 小程序端的 mode 一律 silent：版本包由平台托管，客户端只用 uni.getUpdateManager 走平台更新，
 *   服务端再弹一次就是双弹窗。这里记录的作用是『版本与能力清单可查』，不是催更。
 * 改完必须重启服务（nginx 反代到 /v1/，无热重载）：sudo systemctl restart qtvq-report
 */

export const GENERATED_AT = "2026-11-15T02:56:25.819Z";

export const APP_RELEASES_GENERATED = {
  "windows": {
    "version": "1.0.7",
    "minVersion": "1.0.0",
    "mode": "prompt",
    "notes": "界面改为直连主站（不再内嵌随包固化的旧界面）；修复托盘图标从未被打包、壳版本号显示成 Electron 版本、导航校验可被 qtvq.cn.evil.com 绕过；免安装版不再误报可更新",
    "downloadUrl": "https://qtvq.cn/release/desktop/qtvq-desktop-Setup-1.0.7.exe",
    "publishedAt": "2026-10-30T02:26:24.736Z"
  },
  "wechat": {
    "version": "1.0.6",
    "minVersion": "1.0.0",
    "mode": "prompt",
    "notes": "",
    "downloadUrl": null,
    "publishedAt": "2026-09-18T00:00:00.000Z"
  },
  "web": {
    "version": "1.0.6",
    "minVersion": "1.0.0",
    "mode": "silent",
    "notes": "",
    "downloadUrl": null,
    "publishedAt": "2026-09-20T00:00:00.000Z"
  },
  "alipay": {
    "version": "1.0.6",
    "minVersion": "1.0.0",
    "mode": "silent",
    "notes": "支付宝小程序，版本包由支付宝托管",
    "downloadUrl": null,
    "publishedAt": "2026-10-28T00:00:00.000Z"
  },
  "douyin": {
    "version": "1.0.6",
    "minVersion": "1.0.0",
    "mode": "silent",
    "notes": "抖音小程序，版本包由抖音开放平台托管",
    "downloadUrl": null,
    "publishedAt": "2026-10-28T00:00:00.000Z"
  },
  "xhs": {
    "version": "1.0.6",
    "minVersion": "1.0.0",
    "mode": "silent",
    "notes": "小红书小程序，版本包由小红书托管",
    "downloadUrl": null,
    "publishedAt": "2026-10-28T00:00:00.000Z"
  },
  "kuaishou": {
    "version": "1.0.6",
    "minVersion": "1.0.0",
    "mode": "silent",
    "notes": "快手小程序（appid ks651051624357102489），版本包由快手托管",
    "downloadUrl": null,
    "publishedAt": "2026-10-28T00:00:00.000Z"
  },
  "jd": {
    "version": "1.0.6",
    "minVersion": "1.0.0",
    "mode": "silent",
    "notes": "京东小程序，版本包由京东托管",
    "downloadUrl": null,
    "publishedAt": "2026-10-28T00:00:00.000Z"
  },
  "qq": {
    "version": "1.0.6",
    "minVersion": "1.0.0",
    "mode": "silent",
    "notes": "QQ 小程序，版本包由 QQ 开放平台托管",
    "downloadUrl": null,
    "publishedAt": "2026-10-28T00:00:00.000Z"
  },
  "baidu": {
    "version": "1.0.6",
    "minVersion": "1.0.0",
    "mode": "silent",
    "notes": "百度智能小程序，版本包由百度托管",
    "downloadUrl": null,
    "publishedAt": "2026-10-28T00:00:00.000Z"
  },
  "mp360": {
    "version": "1.0.6",
    "minVersion": "1.0.0",
    "mode": "silent",
    "notes": "360 小程序，版本包由 360 托管",
    "downloadUrl": null,
    "publishedAt": "2026-10-28T00:00:00.000Z"
  }
};
