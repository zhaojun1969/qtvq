# 微信 / 支付宝 / 抖音 / 小红书 · 小程序开发指南

> **四端同 UI 总览** → [MULTI-MINI-PROGRAM.md](./MULTI-MINI-PROGRAM.md)

工程路径：`apps/qtvq-uni/`（uni-app 一套代码，四端发行）



**当前小程序版本：`1.0.6`**（缘值 → 关于；与 `manifest.json` / `constants.js` 同步）



## 1. 安装与开发



```bash

cd apps/qtvq-uni

npm install



# 微信小程序

npm run dev:mp-weixin



# 支付宝小程序

npm run dev:mp-alipay

```



- **微信**：用 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html) 打开目录  

  `apps/qtvq-uni/dist/dev/mp-weixin`（开发）或 `dist/build/mp-weixin`（发布）

- **支付宝**：用 [支付宝开发者工具](https://opendocs.alipay.com/mini/ide/download) 打开  

  `apps/qtvq-uni/dist/dev/mp-alipay`



根目录快捷命令：`npm run build:mp-weixin`



## 2. 配置 AppID



编辑 `src/manifest.json`：



```json

"mp-weixin": { "appid": "wx489fbca28401e4e0" },

"mp-alipay": { "appid": "你的支付宝AppID" }

```



## 3. 服务器域名（必配）



### request 合法域名



```

https://qtvq-api.pages.dev

```



### 业务域名 / web-view



```

https://qtvq.cn

```



**微信业务域名校验：** 校验文件 `verify/pO8yu0YU22.txt` → 同步到 `https://qtvq.cn/pO8yu0YU22.txt`



详细步骤见下文 **§3.1** 与 [`docs/WECHAT-MINI-LOGIN.md`](../../docs/WECHAT-MINI-LOGIN.md)。



### 3.1 验证通过后的下一步



| 步骤 | 位置 | 配置 |

|------|------|------|

| ① request 合法域名 | 小程序后台 → 服务器域名 | `https://qtvq-api.pages.dev` |

| ② 业务域名 | 同上 | `qtvq.cn` |

| ③ 同步静态站 | 服务器 | `sync-static.sh` |

| ④ 小程序 Secret | `.dev.vars` → `npm run wechat:secrets` | `WECHAT_MINI_APP_SECRET` |

| ⑤ 开放平台绑定小程序 | UnionID 打通 PC 与小程序 | 见 WECHAT-MINI-LOGIN.md |

| ⑥ 自测小程序 | 我的账户 / 办理会员 / 三 Tab | 见 §5 |



**顶栏与页面高度** → [`docs/NAV-DESIGN.md`](./NAV-DESIGN.md)



## 4. 功能清单（v1.0.6）



| 功能 | 微信 | 说明 |

|------|------|------|

| Q问对话 / 再问一步 | ✅ | 10 条示例、热点、语音 PCM 16k |

| 24h 额度 | ✅ | 5 次/24h；会员不限次 |

| 避坑精选 | ✅ | **10 条**，原生滚动，可跳转 Q问 |

| 缘值 / 会员信息 | ✅ | 套餐、到期、打款核实状态 |

| 办理会员 | ✅ | **JSAPI 直接扣款** + 扫码可选 + 静态码 + 对公汇款核实 |

| 我的账户 | ✅ | 微信一键登录、忘记密码、改密、打款查询 |

| 联系客服 | ✅ | 留言至 qtvq@qtvq.cn |

| 帮助 / 隐私 web-view | ✅ | qtvq.cn |



## 5. 打包上传



**改代码后必须重新编译并上传；手机旧包不会自动更新。**



```bash

npm run build:mp-weixin

# 输出：apps/qtvq-uni/dist/build/mp-weixin

# 路径：apps/qtvq-uni/LAST-BUILD.txt

```



微信开发者工具：



1. 导入 **`dist/build/mp-weixin`**（不是 dev 目录）

2. **工具 → 清缓存 → 全部清除**（建议）

3. **上传** → mp 后台设为体验版或提审



**确认新版本：**



| 检查项 | 期望 |

|--------|------|

| 缘值 → 关于 | **版本 1.0.6** · 会员 ¥29/79/299 |

| 办理会员 | 三档 ¥29 / ¥79 / ¥299；汇款表单文字完整 |

| 避坑 | 10 条案例，能滚到最后一条 |

| Q问 | 10 条示例问题；输入框上方无大块空白 |

| 我的账户 | 「不用记密码…」提示；输入框文字不裁切 |



## 6. 审核注意



- 类目建议：**工具 - 信息查询** 或 **教育**

- 文案避免「心理诊断 / 医疗」，强调「信息参考、行动建议」

- 隐私政策 URL：`https://qtvq.cn/privacy.html`



## 7. 会员支付



| 方式 | 页面 | 开通时机 |

|------|------|----------|

| 微信 JSAPI | 办理会员 → 直接扣款 | 支付回调自动 |

| 微信 Native 扫码 | 办理会员 → 扫码支付 | 回调 / 轮询 |

| 静态收款码 + 对公 | 办理会员 → 提交汇款核实 | 工作人员核实后 |

| 套餐时长 | 月 30 天 / 季 90 天 / 年 365 天 | 见 [MEMBERSHIP-RULES.md](../../docs/MEMBERSHIP-RULES.md) |



收款码：`src/static/payment/`（与站点 `assets/payment/` 同步）。



## 8. 相关文档



- [PAYMENT-WECHAT-API.md](../../docs/PAYMENT-WECHAT-API.md) — 微信支付 API

- [MEMBERSHIP-RULES.md](../../docs/MEMBERSHIP-RULES.md) — 开通/到期/续费

- [WECHAT-MINI-LOGIN.md](../../docs/WECHAT-MINI-LOGIN.md) — 小程序登录 Secret

- [NAV-DESIGN.md](./NAV-DESIGN.md) — 顶栏与 scroll 高度

- [MULTI-PLATFORM.md](../../docs/MULTI-PLATFORM.md) — 多端总方案

