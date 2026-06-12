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
2. 下载校验文件（如 `MP_verify_xxxxxxxx.txt`）
3. 放入仓库 **`verify/`** 目录（或项目根目录）
4. 同步到服务器根目录：

```bash
cd /opt/qtvq && git pull origin main && bash tools/scripts/sync-static.sh
```

5. 浏览器访问确认：`https://qtvq.cn/MP_verify_xxxxxxxx.txt` 能打开且内容与下载一致
6. 回到微信后台点击「验证」

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
