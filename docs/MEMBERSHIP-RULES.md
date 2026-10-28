# 提问会员 · 开通与到期规则

与代码 `functions/lib/quota-store.js` 中 `PLANS`、`activatePayment`、`buildQuota` 一致。

## 套餐

| planId | 名称 | 价格 | 有效天数 |
|--------|------|------|----------|
| `month` | 月卡 | ¥29 | **30 天** |
| `quarter` | 季卡 | ¥79 | **90 天** |
| `year` | 年卡 | ¥299 | **365 天** |

天数按 **开通/核实时刻起算** 的固定毫秒时长（`days × 24h`），不是自然月/自然年。

## 何时开通

| 通道 | 触发 | 说明 |
|------|------|------|
| 微信 Native / JSAPI | 支付回调 `POST /api/payment/wechat/notify` 验签成功 | 自动 `activatePayment`，一般秒级 |
| 对公 / 静态码汇款 | 用户提交核实 → 工作人员 `POST /api/payment` `action=verify` | **以核实通过时刻**起算，非打款时刻 |
| 异常兜底 | 核实页人工 verify | 回调失败但已到账时使用 |

提交汇款后状态为 `paymentPending`，**核实前不算会员**。

## 何时关闭

每次 `GET /api/quota`、`POST /api/chat` 等都会执行：

```js
unlimited = subscription.activeUntil > Date.now()
```

- `activeUntil` 在未来 → 不限次提问
- 已过期 → 自动恢复 **24 小时 5 次**免费额度（滚动窗口）

无需定时任务；KV 中保留历史 `subscription` 字段，但 `unlimited` 为 false。

## 续费叠加

若当前会员未到期，新购时长 **叠在原有 `activeUntil` 之后**：

```js
base = Math.max(Date.now(), subscription.activeUntil)
activeUntil = base + plan.days × 86400000
```

## 前端展示

- PC：`profile.html`、`account.html` 显示「有效期至 …」
- 小程序：`pages/profile/profile.vue`、`pages/account/account.vue` 同逻辑
- 版本号：`apps/qtvq-uni/src/data/constants.js` → `APP_VERSION`（与 manifest `versionName` 同步）

## 相关 API

| 路由 | 说明 |
|------|------|
| `GET /api/quota?clientId=` | 额度 + `subscription` + `paymentPending` |
| `POST /api/payment` | 提交汇款 / 工作人员 verify |
| `POST /api/payment/wechat/create` | 在线下单 |
| `POST /api/payment/wechat/notify` | 支付回调开通 |
| `GET /api/payment/wechat/query?orderId=` | 轮询订单（已 paid 时返回 quota） |

详见 [PAYMENT-WECHAT-API.md](./PAYMENT-WECHAT-API.md)。
