# 我心永恒 Q问 · uni-app 多端

Android / iOS / 鸿蒙 / **微信** / **支付宝** / 抖音 共用工程。

## 快速开始

```bash
cd apps/qtvq-uni
npm install
npm run dev:mp-weixin    # 微信小程序
npm run dev:mp-alipay    # 支付宝小程序
npm run dev:h5           # 浏览器
```

**微信 / 支付宝详细配置** → [docs/WEIXIN-ALIPAY.md](./docs/WEIXIN-ALIPAY.md)

## 页面结构

| Tab / 页 | 说明 |
|----------|------|
| Q问 | 对话、热点、案例墙、语音、会员入口 |
| 避坑 | 精选案例，可跳转 Q问 |
| 缘值 | 额度、帮助、隐私、客服、会员 |
| 办理会员 | 对公汇款 + 提交核实 |
| 联系客服 | 留言至 qtvq@qtvq.cn |

## API

与 Web 一致：`https://qtvq-api.pages.dev`

## 构建

```bash
npm run build:mp-weixin
npm run build:mp-alipay
```

Logo 静态资源：`src/static/logo-*.png`（来自项目 `logo/` 目录）
