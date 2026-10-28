# 四端小程序 · 与微信同款 UI

工程：`apps/qtvq-uni/`（uni-app 一套代码，条件编译区分平台能力）

| 平台 | uni 标识 | 编译输出 | 开发者工具 |
|------|----------|----------|------------|
| 微信 | `mp-weixin` | `dist/build/mp-weixin` | [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html) |
| 支付宝 | `mp-alipay` | `dist/build/mp-alipay` | [支付宝开发者工具](https://opendocs.alipay.com/mini/ide/download) |
| 抖音 | `mp-toutiao` | `dist/build/mp-toutiao` | [抖音开发者工具](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/developer-instrument/overview) |
| 小红书 | `mp-xhs` | `dist/build/mp-xhs` | [小红书开发者工具](https://developer.xiaohongshu.com/) |

**UI 与微信一致**：三 Tab（Q问 / 避坑 / 缘值）、同款顶栏 `BrandNavBar`、同款配色与页面结构。  
差异仅在**平台能力**（见下表）。

## 1. 编译命令

```bash
cd apps/qtvq-uni
npm install

# 单端
npm run dev:mp-weixin
npm run dev:mp-alipay
npm run dev:mp-toutiao
npm run dev:mp-xhs

# 发布包（根目录也可：npm run build:mp-all）
npm run build:mp-weixin
npm run build:mp-alipay
npm run build:mp-toutiao
npm run build:mp-xhs
npm run build:mp-all    # 一次编译四端
```

编译后查看 **`apps/qtvq-uni/LAST-BUILD.txt`** 获取输出路径。

## 2. 填写 AppID

编辑 `src/manifest.json`：

```json
"mp-weixin": { "appid": "wx489fbca28401e4e0" },
"mp-alipay": { "appid": "你的支付宝小程序AppID" },
"mp-toutiao": { "appid": "你的抖音小程序AppID" },
"mp-xhs": { "appid": "你的小红书小程序AppID" }
```

## 3. 服务器域名（四端相同）

| 类型 | 域名 |
|------|------|
| request 合法域名 | `https://qtvq-api.pages.dev` |
| web-view 业务域名 | `https://qtvq.cn` |

各平台后台分别配置；微信业务域名校验文件见 [WEIXIN-ALIPAY.md](./WEIXIN-ALIPAY.md)（支付宝/抖音/小红书按各自后台要求上传校验文件）。

## 4. 页面与 UI 对照

| 页面 | 四端 UI | 平台差异 |
|------|---------|----------|
| Q问 | ✅ 相同 | 语音需 API 配 NLS；各端录音权限文案在 manifest |
| 避坑 | ✅ 相同 | 10 条精选，原生滚动 |
| 缘值 | ✅ 相同 | 「关于」显示当前平台名 + 版本 1.0.6 |
| 办理会员 | ✅ 相同布局 | **仅微信**有 JSAPI 直接扣款；其余端用静态码 + 对公 + 核实 |
| 我的账户 | ✅ 相同 | **仅微信**有「微信一键登录 / 忘记密码」；其余端手机号登录 |
| 联系客服 | ✅ 相同 | — |

顶栏与高度规范 → [NAV-DESIGN.md](./NAV-DESIGN.md)

## 5. 条件编译约定

| 能力 | 编译宏 |
|------|--------|
| 仅微信 | `#ifdef MP-WEIXIN` |
| 非微信三端 | `#ifndef MP-WEIXIN` |
| 任意小程序 | `#ifdef MP` |
| 平台名 | `src/utils/platform.js` → `platformLabel()` |

源码示例：

- `pages/subscribe/subscribe.vue` — 微信在线支付 vs 静态码说明
- `pages/account/account.vue` — 微信登录 Tab
- `utils/navBar.js` — 四端顶栏高度（`pageHeightPx`，勿用 `100vh`）

## 6. 上传发布

1. `npm run build:mp-xxx`
2. 打开对应开发者工具 → **导入 `dist/build/mp-xxx`**
3. 清缓存 → 预览 / 上传 → 各平台后台设体验版或提审

**确认同款 UI：**

- 三 Tab 图标与配色一致
- Q问 顶栏：Logo +「Q问 · 我心永恒 · qtvq.cn」
- 缘值 → 关于：**版本 1.0.6**，平台名分别为微信/支付宝/抖音/小红书

## 7. 小红书注意事项

- 依赖 `@dcloudio/uni-mp-xhs`（已加入 `package.json`）
- 若遇 `exports is not defined`：清小红书开发者工具缓存后重导；仍失败见 [DCloud 问答](https://ask.dcloud.net.cn/question/217672)
- 部分真机交互（横滑、胶囊附近点击）可能有平台差异，以真机为准

## 8. 相关文档

- [WEIXIN-ALIPAY.md](./WEIXIN-ALIPAY.md) — 微信详细步骤（域名、Secret、自测）
- [NAV-DESIGN.md](./NAV-DESIGN.md) — 顶栏 / scroll / input 规范
- [MEMBERSHIP-RULES.md](../../docs/MEMBERSHIP-RULES.md) — 会员 30/90/365 天
- [MULTI-PLATFORM.md](../../docs/MULTI-PLATFORM.md) — 多端总方案
