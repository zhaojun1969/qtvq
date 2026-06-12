# 微信 / 支付宝小程序开发指南

工程路径：`apps/qtvq-uni/`（uni-app 一套代码，双端发行）

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
  `apps/qtvq-uni/dist/dev/mp-weixin`
- **支付宝**：用 [支付宝开发者工具](https://opendocs.alipay.com/mini/ide/download) 打开  
  `apps/qtvq-uni/dist/dev/mp-alipay`

## 2. 配置 AppID

编辑 `src/manifest.json`：

```json
"mp-weixin": { "appid": "wx你的AppID" },
"mp-alipay": { "appid": "你的支付宝AppID" }
```

## 3. 服务器域名（必配）

### request 合法域名

在微信 / 支付宝小程序后台 → 开发 → 服务器域名 → **request 合法域名**：

```
https://qtvq-api.pages.dev
```

### 业务域名 / web-view

业务域名（帮助、隐私页 web-view）：

```
https://qtvq.cn
```

**微信业务域名校验（必做）：**

1. 微信公众平台 → 开发 → 开发管理 → 开发设置 → **业务域名** → 添加 `qtvq.cn`
2. 下载校验文件（本项目为 **`pO8yu0YU22.txt`**，内容为 32 位 hex）
3. 已放入 `verify/pO8yu0YU22.txt`，同步到服务器根目录
4. 服务器执行：`cd /opt/qtvq && git pull && bash tools/scripts/sync-static.sh`
5. 浏览器确认：`https://qtvq.cn/pO8yu0YU22.txt` → `bbbb6c592fbd78c00beaa494f3943ba2`
6. 微信后台点击「验证」→ 通过后继续下方 **第 3.1 节**

### 3.1 验证通过后的下一步

| 步骤 | 位置 | 配置 |
|------|------|------|
| ① request 合法域名 | 小程序后台 → 服务器域名 | `https://qtvq-api.pages.dev` |
| ② 业务域名 | 同上（应已显示 qtvq.cn 已验证） | `qtvq.cn` |
| ③ 同步静态站 | 服务器 | `bash tools/scripts/sync-static.sh`（含 account.html） |
| ④ 小程序 Secret | `.dev.vars` → `npm run wechat:secrets` | `WECHAT_MINI_APP_SECRET` |
| ⑤ 开放平台回调域 | [open.weixin.qq.com](https://open.weixin.qq.com/) → 网站应用 Q问 | 授权回调域 `qtvq.cn` |
| ⑥ 绑定小程序 | 开放平台 → 绑定 `wx489fbca28401e4e0` | PC 与小程序同一账号 |
| ⑦ 自测 | PC | [qtvq.cn/account.html](https://qtvq.cn/account.html) 微信扫码登录 |
| ⑧ 自测 | 小程序 | 我的账户 → 微信一键登录；办理会员 → 在线支付 |

支付宝类似：下载校验文件 → 放入 `verify/` → 同步 → 在后台验证。

详细说明见项目根目录 [`verify/README.md`](../../verify/README.md)

## 4. 功能清单

| 功能 | 微信 | 支付宝 |
|------|------|--------|
| Q问对话 / 再问一步 | ✅ | ✅ |
| 24h 额度 / 扫码收款 + 对公汇款 | ✅ | ✅ |
| 避坑精选 + 跳转提问 | ✅ | ✅ |
| 热点 / 成功案例墙 | ✅ | ✅ |
| 语音输入（阿里云 ASR） | ✅ | ✅ |
| 联系客服留言 | ✅ | ✅ |
| 帮助 / 隐私 web-view | ✅ | ✅ |

## 5. 打包上传

```bash
npm run build:mp-weixin   # 输出 dist/build/mp-weixin
npm run build:mp-alipay   # 输出 dist/build/mp-alipay
```

微信开发者工具 → 上传 → 提交审核  
支付宝开发者工具 → 上传 → 提交审核

## 6. 审核注意

- 类目建议：**工具 - 信息查询** 或 **教育**
- 文案避免「心理诊断 / 医疗」，强调「信息参考、行动建议」
- 隐私政策 URL：`https://qtvq.cn/privacy.html`
- 小程序内已内置帮助、隐私、客服入口（缘值 Tab）

## 7. 会员支付说明

订阅页 `pages/subscribe/subscribe` 与 H5 一致，提供四种**静态收款码**（微信 / 支付宝 ×2 / 云闪付·工行）及对公汇款。用户扫码后需**手动输入套餐金额**、备注填写设备编号，再提交核实。

收款码图片：`src/static/payment/`（与站点 `assets/payment/` 同步）。

## 8. 后续（第 2 期）

- 微信 JSAPI / Native 支付、支付宝交易组件（需企业商户号）
- 微信 openid 与 clientId 绑定

详见 [docs/PAYMENT-WECHAT-API.md](../../docs/PAYMENT-WECHAT-API.md)  
完整多端方案见 [docs/MULTI-PLATFORM.md](../../docs/MULTI-PLATFORM.md)
