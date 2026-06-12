# 微信支付 / 支付宝商户 API 对接规划（第 2 期）

当前（第 1 期）采用 **静态收款码 + 人工核实**，见 `assets/payment/` 与 `js/pay-qr.js`。  
套餐价格：**月卡 ¥28 / 季卡 ¥78 / 年卡 ¥288**（前后端以 `PLANS` 为准）。

## 已实现骨架（微信）

| 路由 | 文件 | 状态 |
|------|------|------|
| `POST /api/payment/wechat/create` | `functions/api/payment/wechat/create.js` | ✅ 创建 KV 订单；未配商户号时返回 `stub: true` |
| `POST /api/payment/wechat/notify` | `functions/api/payment/wechat/notify.js` | ✅ 解密 resource + 可选平台验签 → 自动开通 |
| `GET /api/payment/wechat/query` | `functions/api/payment/wechat/query.js` | ✅ 前端轮询订单状态 |
| 订单存储 | `functions/lib/order-store.js` | ✅ |
| 微信 V3 封装 | `functions/lib/wechat-pay.js` | ✅ Native/JSAPI 下单、notify 解密 |
| 加密工具 | `functions/lib/wechat-crypto.js` | ✅ RSA 签名、AES-GCM 解密 |
| H5 在线支付 UI | `js/subscribe.js` + `js/payment-wechat.js` | ✅ 动态二维码 + 轮询 |
| 小程序在线支付 | `apps/qtvq-uni/.../subscribe.vue` | ✅ |

### create 请求示例

```bash
curl -X POST https://qtvq-api.pages.dev/api/payment/wechat/create \
  -H "Content-Type: application/json" \
  -d '{"clientId":"q_test123","plan":"month","channel":"native"}'
```

未配置商户 Secrets 时响应含 `"stub": true`，订单已写入 KV，无 `codeUrl`。

### 本项目商户号

| 项 | 值 |
|----|-----|
| **微信支付商户号** | `1746766627` |
| **支付回调 URL** | `https://qtvq-api.pages.dev/api/payment/wechat/notify` |

请在 [微信支付商户平台](https://pay.weixin.qq.com/) 完成：

1. **产品中心** → 开通 **Native 支付**（PC 扫码）、**JSAPI 支付**（小程序/公众号）
2. **账户中心 → 商户信息** → 绑定 **AppID**（小程序 `manifest.json` 里 `mp-weixin.appid` 须一致）
3. **账户中心 → API 安全** → 设置 **APIv3 密钥**，下载/申请 **商户 API 证书**（得 `序列号` + `私钥`）
4. **产品中心 → 开发配置** → 填写 **Native 支付回调链接** 为上方 notify URL

### 待配置 Secrets（Wrangler / Pages）

本地已写入 `.dev.vars` / `.dev.vars.example` 的 `WECHAT_MCH_ID`；其余填入 `.dev.vars` 后执行：

```powershell
powershell -ExecutionPolicy Bypass -File tools/scripts/upload-wechat-secrets.ps1
npm run deploy:api-only
```

```
WECHAT_MCH_ID=1746766627
WECHAT_PAY_NOTIFY_URL=https://qtvq-api.pages.dev/api/payment/wechat/notify
WECHAT_APP_ID=                         # 待填：小程序/公众号 AppID
WECHAT_API_V3_KEY=                       # 待填：32 位 APIv3 密钥
WECHAT_MCH_SERIAL=                       # 待填：商户证书序列号
WECHAT_MCH_PRIVATE_KEY=                  # 待填：商户私钥 PEM
WECHAT_PLATFORM_PUBLIC_KEY=              # 建议：平台公钥（验签回调）
```

### 如何获取 `WECHAT_MCH_PRIVATE_KEY`（商户私钥）

登录 [微信支付商户平台](https://pay.weixin.qq.com/)（商户号 `1746766627`）：

1. 进入 **账户中心 → API 安全**
2. 找到 **商户 API 证书**（不是「APIv3 密钥」那一项）
3. 若尚未申请：点 **申请证书**，按提示用微信扫码，下载 **证书工具** 生成并导出
4. 解压下载的压缩包，找到 **`apiclient_key.pem`** —— 这就是 `WECHAT_MCH_PRIVATE_KEY`

文件内容类似：

```
-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqh...
（多行 base64）
-----END PRIVATE KEY-----
```

同一压缩包里还有：

| 文件 | 对应配置项 |
|------|------------|
| `apiclient_key.pem` | `WECHAT_MCH_PRIVATE_KEY` |
| `apiclient_cert.pem` | 仅本地备用；**序列号**填到 `WECHAT_MCH_SERIAL` |

**证书序列号 `WECHAT_MCH_SERIAL` 在哪看：**

- 商户平台 **API 安全 → 商户 API 证书 → 管理证书**，列表里有一列「序列号」  
- 或打开 `apiclient_cert.pem`，用 openssl：`openssl x509 -in apiclient_cert.pem -noout -serial`

**不要混淆：**

| 名称 | 用途 | 配置变量 |
|------|------|----------|
| APIv3 密钥 | 32 位字符串，用于**解密支付回调** | `WECHAT_API_V3_KEY` |
| 商户 API 私钥 | `apiclient_key.pem`，用于**请求签名** | `WECHAT_MCH_PRIVATE_KEY` |
| 平台公钥 | 验签微信发来的 notify | `WECHAT_PLATFORM_PUBLIC_KEY`（可选但建议） |

**写入 `.dev.vars` 的两种方式：**

```bash
# 方式 A：整段 PEM（推荐本地 .dev.vars，换行保留）
WECHAT_MCH_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----
MIIE...
-----END PRIVATE KEY-----

# 方式 B：单行，换行写成 \n（适合 Cloudflare Secret）
WECHAT_MCH_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----
```

私钥只保存在本机 `.dev.vars` 和 Cloudflare Secrets，**切勿提交 Git、勿发到聊天群**。

### 常见错误：签名错误

若 `POST /api/payment/wechat/create` 返回 **「签名错误，请检查后再试」**：

1. 打开商户平台 **账户中心 → API 安全 → 管理证书**
2. 找到与当前 `apiclient_key.pem` **同一套**证书的 **序列号**
3. 将 `WECHAT_MCH_SERIAL` 改为该序列号（大写、无冒号），重新 `npm run wechat:secrets`
4. 确认私钥来自同一 zip 包内的 `apiclient_key.pem`（不是 APIv3 密钥）

本地可用 openssl 核对（在证书 zip 解压目录）：

```bash
openssl x509 -in apiclient_cert.pem -noout -serial
# 输出 serial=XXXXXXXX → 去掉 serial= 前缀填入 WECHAT_MCH_SERIAL
openssl rsa -in apiclient_key.pem -check -noout
```

## 现状 vs 目标

| 能力 | 第 1 期（现状） | 第 2 期（目标） |
|------|----------------|----------------|
| H5 / PC | 展示静态收款码，用户手填金额与备注 | Native 支付：服务端下单，PC 展示**动态**二维码 |
| 微信小程序 | 静态收款码 + 提交核实（`subscribe.vue`） | JSAPI 支付：调起微信支付，回调自动开通 |
| 支付宝小程序 | 同上 | 支付宝交易组件 / 小程序支付 |
| 到账确认 | 人工核对 + `POST /api/payment` | 支付平台异步通知 + 可选人工兜底 |
| 所需资质 | 个人/经营收款码即可 | **企业微信/支付宝商户号** |

**不需要「付款码」**（顾客出示、商户扫描）。线上场景用的是 **收款码** 或 **Native/JSAPI 动态订单**。

---

## 前置条件

1. **企业主体**：我心永恒（北京）网络科技有限公司  
2. **微信商户号**（pay.weixin.qq.com）并与小程序 AppID 绑定  
3. **支付宝当面付 / 小程序支付** 产品开通  
4. 商户平台配置 **API 密钥 / 证书**（微信 V3 API 推荐）  
5. 回调 URL（HTTPS）：`https://qtvq-api.pages.dev/api/payment/wechat/notify` 等  

虚拟会员类目需在商户经营范围与小程序类目内覆盖。

---

## 架构概览

```
用户选套餐
    → POST /api/payment/wechat/create  { clientId, plan }
    → Worker 创建订单 KV + 调微信统一下单
    → 返回 code_url（Native）或 prepay 参数（JSAPI）
    → 前端展示二维码 / wx.requestPayment
    → 微信 POST notify → Worker 验签 → activatePayment(clientId, plan)
```

支付宝流程类似：`/api/payment/alipay/create` + notify。

---

## 建议新增后端路由

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/payment/wechat/create` | POST | 创建订单，返回 Native `code_url` 或 JSAPI 参数 |
| `/api/payment/wechat/notify` | POST | 微信支付结果通知（验签、幂等） |
| `/api/payment/wechat/query` | GET | 轮询订单状态（PC 扫码后前端可选） |
| `/api/payment/alipay/create` | POST | 支付宝预下单 |
| `/api/payment/alipay/notify` | POST | 支付宝异步通知 |

实现位置建议：`functions/api/payment-wechat.js`、`functions/api/payment-alipay.js`，订单状态扩展 `functions/lib/quota-store.js`。

### 环境变量（Wrangler Secrets）

```
WECHAT_MCH_ID=
WECHAT_API_V3_KEY=
WECHAT_MCH_SERIAL=
WECHAT_MCH_PRIVATE_KEY=   # PEM
WECHAT_APP_ID=              # 小程序 / 公众号 AppID
ALIPAY_APP_ID=
ALIPAY_PRIVATE_KEY=
ALIPAY_PUBLIC_KEY=
```

---

## 各端接入方式

### PC / H5 — 微信 Native 支付

1. 后端调用 [Native 下单 API](https://pay.weixin.qq.com/wiki/doc/apiv3/apis/chapter3_4_1.shtml)  
2. 返回 `code_url`，前端用 QR 库渲染（**非**静态收款图）  
3. 用户扫码支付后，微信 notify 或前端轮询 `query`  
4. 成功后自动 `activatePayment`，可保留「提交核实」作异常兜底  

### 微信小程序 — JSAPI

1. `uni.login` 取 code → 后端换 **openid**（需绑定 `clientId`）  
2. 后端 JSAPI 下单，返回 `timeStamp/nonceStr/package/signType/paySign`  
3. `uni.requestPayment` 调起支付  
4. notify 开通会员  

注意：小程序内**不能**用静态个人收款码替代 JSAPI（平台规则与体验均不符）。

### 支付宝

- H5：电脑网站支付或当面付  
- 小程序：`my.tradePay` + 服务端 `alipay.trade.create`  

---

## 数据模型（建议）

```json
{
  "orderId": "ord_xxx",
  "clientId": "q_xxx",
  "plan": "month",
  "amount": 2800,
  "channel": "wechat_native",
  "status": "pending|paid|failed|refunded",
  "platformTradeNo": "",
  "createdAt": "",
  "paidAt": ""
}
```

存储：Cloudflare KV（与现有 `quota-store` 同库或独立 `ORDERS` namespace）。

---

## 迁移策略

1. **并行期**：保留静态收款码 + 人工核实；商户 API 开通后增加「在线支付」按钮  
2. **openid 绑定**：首次 JSAPI 支付时将 openid 写入 `clientId` 映射，便于续费  
3. **对公汇款**：继续作为企业客户通道（合规文档已说明）  
4. **回滚**：notify 失败时仍可通过现有 `POST /api/payment` 人工核实  

---

## 开发顺序建议

1. 申请并配置微信商户号 + 绑定小程序  
2. 实现 `create` + `notify` + 订单 KV（仅 Native，先在 H5 验证）  
3. 小程序 JSAPI + openid  
4. 支付宝 create/notify  
5. 管理端：订单列表、与 pending 汇款合并审核 UI  

---

## 相关文件

- 静态收款码 Web：`js/pay-qr.js`、`assets/payment/`  
- 小程序订阅页：`apps/qtvq-uni/src/pages/subscribe/subscribe.vue`  
- 人工核实 API：`functions/api/payment.js`  
- 多端策略：`docs/MULTI-PLATFORM.md`  
