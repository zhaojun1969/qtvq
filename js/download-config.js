/**
 * 各端下载配置 —— **本文件由 tools/scripts/write-download-config.mjs 生成，请勿手改**。
 *
 * 要改下载地址/小程序码：改仓库根的 release-links.json，然后运行
 *   node tools/scripts/write-download-config.mjs && node tools/scripts/write-release-manifest.mjs
 * 这两个脚本读同一份 release-links.json，下载页与 App 自动更新不会分叉。
 *
 * 生成时间: 2026-11-11T23:03:41.190Z
 * App 版本: 1.0.6
 * 留空的入口在页面上显示「即将上线」，但**不再是一个点了没反应的死链**：
 * js/download.js 会把它们渲染成不可点状态并写明原因。
 */

export const DOWNLOAD_LINKS = {
  "windows": {
    "kind": "app",
    "label": "Windows 桌面版",
    "href": "https://qtvq.cn/release/desktop/qtvq-desktop-Setup-1.0.7.exe",
    "note": "Windows 10/11 · 下载后双击安装",
    "icon": "🖥️"
  },
  "android": {
    "kind": "app",
    "label": "Android 下载",
    "href": "",
    "store": "",
    "note": "待上架：应用宝 / 华为 / 小米 / OPPO / vivo",
    "icon": "🤖"
  },
  "ios": {
    "kind": "app",
    "label": "App Store",
    "href": "",
    "note": "需 Apple 开发者账号 + 审核通过",
    "icon": "🍎"
  },
  "harmony": {
    "kind": "app",
    "label": "鸿蒙版",
    "href": "",
    "note": "需华为开发者账号；鸿蒙 NEXT 需 uni-app x 工程",
    "icon": "🔷"
  },
  "weixin": {
    "kind": "miniprogram",
    "label": "微信小程序",
    "icon": "微",
    "desc": "微信内搜索「我心永恒 Q问」，或扫右侧小程序码",
    "href": "",
    "qrcode": "",
    "appid": "wx489fbca28401e4e0",
    "note": "已创建小程序，上传二维码后此处显示"
  },
  "alipay": {
    "kind": "miniprogram",
    "label": "支付宝小程序",
    "icon": "支",
    "desc": "支付宝扫一扫或搜索「Q问」",
    "href": "",
    "qrcode": "",
    "appid": "",
    "note": "待申请小程序账号"
  },
  "douyin": {
    "kind": "miniprogram",
    "label": "抖音小程序",
    "icon": "抖",
    "desc": "抖音内搜索「Q问」",
    "href": "",
    "qrcode": "",
    "appid": "",
    "note": "待申请小程序账号"
  },
  "xhs": {
    "kind": "miniprogram",
    "label": "小红书小程序",
    "icon": "书",
    "desc": "小红书内搜索「Q问」",
    "href": "",
    "qrcode": "",
    "appid": "",
    "note": "待申请小程序账号"
  },
  "qq": {
    "kind": "miniprogram",
    "label": "QQ 小程序",
    "icon": "Q",
    "desc": "QQ 内搜索「Q问」",
    "href": "",
    "qrcode": "",
    "appid": "",
    "note": "待申请小程序账号"
  },
  "baidu": {
    "kind": "miniprogram",
    "label": "百度智能小程序",
    "icon": "百",
    "desc": "百度 App 内搜索「Q问」",
    "href": "",
    "qrcode": "",
    "appid": "",
    "note": "待申请小程序账号"
  },
  "kuaishou": {
    "kind": "miniprogram",
    "label": "快手小程序",
    "icon": "快",
    "desc": "快手内搜索「Q问」",
    "href": "",
    "qrcode": "",
    "appid": "ks651051624357102489",
    "note": "已创建小程序，上传二维码后此处显示"
  },
  "jd": {
    "kind": "miniprogram",
    "label": "京东小程序",
    "icon": "京",
    "desc": "京东 App 内搜索「Q问」",
    "href": "",
    "qrcode": "",
    "appid": "",
    "note": "待申请小程序账号"
  },
  "h5": {
    "kind": "web",
    "label": "手机网页版（App 同界面）",
    "href": "https://qtvq.cn/h5/",
    "note": "无需安装 · 已上线 · 可添加到主屏幕",
    "icon": "🌐",
    "active": true
  },
  "site": {
    "kind": "web",
    "label": "官方网站",
    "href": "https://qtvq.cn",
    "note": "介绍、避坑大全、帮助与下载页",
    "icon": "🏠"
  }
};

export const DOWNLOAD_SECTIONS = [
  {
    "title": "桌面端",
    "keys": [
      "windows"
    ]
  },
  {
    "title": "手机 App",
    "keys": [
      "android",
      "ios",
      "harmony"
    ]
  },
  {
    "title": "小程序 · 轻应用",
    "keys": [
      "weixin",
      "alipay",
      "douyin",
      "xhs",
      "qq",
      "baidu",
      "kuaishou",
      "jd"
    ]
  },
  {
    "title": "网页版",
    "keys": [
      "h5",
      "site"
    ]
  }
];
