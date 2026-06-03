# 多端开发方案 · Android / iOS / 鸿蒙 / 微信 / 支付宝 / 抖音

在现有 **qtvq.cn（静态）+ qtvq-api.pages.dev（API）** 架构上扩展，**不重写后端业务逻辑**，各端共用同一套 API。

---

## 一、总体架构

```
┌─────────────────────────────────────────────────────────────┐
│  客户端（6+1 端）                                              │
│  Android · iOS · 鸿蒙 · 微信小程序 · 支付宝 · 抖音 · H5(已有)   │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTPS
                           ▼
              https://qtvq-api.pages.dev
              /api/chat  /api/quota  /api/payment
                           │
              Cloudflare Workers AI + KV
```

| 层 | 策略 |
|----|------|
| **API** | 保持 `functions/api/*`，各端统一 `clientId` + JSON 协议 |
| **UI** | 一套跨端框架为主，原生壳/独立小程序为辅 |
| **数据** | 缘值、额度、会员状态以服务端 KV 为准；本地仅缓存 |
| **支付** | H5 继续对公汇款；小程序/App 后续接微信/支付宝商户（需新接口） |

---

## 二、技术选型（推荐）

### 方案 A：uni-app（推荐，覆盖最全）

| 端 | uni-app 支持 |
|----|----------------|
| Android / iOS | ✅ App 打包（DCloud / 云打包） |
| 鸿蒙 HarmonyOS NEXT | ✅ uni-app x / 官方鸿蒙适配（2024+） |
| 微信小程序 | ✅ 发行 → 微信 |
| 支付宝小程序 | ✅ 发行 → 支付宝 |
| 抖音小程序 | ✅ 发行 → 字节 |
| H5 | ✅ 可嵌入 WebView 或替代现有页 |

**优点：** 一套 Vue 语法、共享页面与 `api` 模块；与现有 JS 业务接近。  
**缺点：** 各小程序平台 UI 规范、登录、支付需分平台 `#ifdef` 条件编译。

### 方案 B：Taro 3/4 + React

适合团队熟悉 React；同样支持微信/支付宝/抖音/H5；鸿蒙需额外适配或 H5 壳。

### 方案 C：Flutter / RN 做 App + 独立三套小程序

App 体验最好，但 **6 端无法同步维护**，成本高，不推荐初创阶段。

**结论：优先 uni-app 单仓 `apps/qtvq-uni/`**，H5 与 Web 站可逐步迁入或并行。

---

## 三、仓库结构（建议）

```
qtvq/
├── functions/          # 现有 API（不动核心逻辑）
├── js/                 # 现有 Web H5
├── apps/
│   └── qtvq-uni/       # uni-app 主工程
│       ├── src/
│       │   ├── pages/          # 首页 Q问、避坑、缘值
│       │   ├── components/
│       │   ├── api/            # chat、quota、payment 封装
│       │   ├── store/          # user、clientId
│       │   └── static/
│       ├── manifest.json       # App 权限、小程序 appid
│       └── pages.json
├── packages/
│   └── api-client/     # 可选：TS 版 API 协议，Web + uni 共用
└── docs/MULTI-PLATFORM.md
```

---

## 四、API 适配清单（后端需补）

现有接口可直接用；多端上线前建议逐项完成：

| 项 | 现状 | 多端需补 |
|----|------|----------|
| `GET/POST /api/quota` | ✅ | 无 |
| `POST /api/chat` | ✅ | 无（注意小程序域名白名单） |
| `GET/POST /api/payment` | ✅ 对公汇款 | 小程序/App 需 **`/api/payment/wechat`**、**`/api/payment/alipay`**（商户号、回调验签） |
| CORS | ✅ qtvq.cn | App 无 CORS；需在 **微信/支付宝/抖音后台** 配置 request 合法域名 `qtvq-api.pages.dev` |
| `clientId` | localStorage | 各端：`uni.setStorageSync` / 小程序 openid 绑定（可选） |
| 语音输入 | Web Speech API | App：原生录音 + 可选 ASR；小程序：微信 `RecorderManager` + 云识别 |
| 速率限制 | IP 级 | 建议 KV 按 `clientId` 限流 |

### 小程序 request 合法域名

在各平台开发者后台添加：

```
https://qtvq-api.pages.dev
```

（微信还需下载校验文件到 Cloudflare Pages 根目录，或通过 DNS 验证。）

### 鸿蒙 App

- 使用 uni-app 鸿蒙工程或 DevEco 壳 + WebView 加载 H5（过渡方案）。
- 上架需华为开发者账号、软著、隐私政策 URL（可用 `https://qtvq.cn/privacy.html`，需新建页）。

---

## 五、功能映射（设计文档 → 各端）

| 功能 | Web | App | 小程序 |
|------|-----|-----|--------|
| Q问对话 | ✅ | 同 API | 同 API，UI 按平台规范 |
| 再问一步 | ✅ | ✅ | ✅ |
| 24h 5 次额度 | ✅ | ✅ | ✅ |
| 会员对公汇款 | ✅ | ✅ 展示 + 复制账号 | 小程序可仅展示，支付走原生 |
| 避坑大全 50 条 | ✅ | 列表+详情 | 分包加载减体积 |
| 测验 / 行动卡 | ✅ | canvas 导出图片 | 小程序 `canvas` / 保存相册 |
| 我的缘值 | ✅ | ✅ | ✅，登录可选微信授权 |
| Logo 动效 | CSS | Lottie 或静态 SVG | 静态为主 |

---

## 六、分期实施（同步开发节奏）

### 第 1 期（2–3 周）— 基础 + 微信小程序

1. 初始化 `apps/qtvq-uni`，封装 `api/chat|quota|payment`
2. 三 Tab：**Q问 / 避坑 / 缘值**（对齐现有 H5）
3. 微信开发者工具调试，配置合法域名
4. 提审素材：类目「工具-信息查询」或「教育」，备隐私协议

### 第 2 期（2 周）— Android + iOS App

1. uni-app 云打包或本地 Android Studio / Xcode
2. 应用名：**我心永恒 Q问**，包名建议 `cn.qtvq.app`
3. 权限：麦克风（语音）、网络、存储（行动卡）
4. 应用商店：软著、ICP 备案号展示（京ICP备19045082号）

### 第 3 期（1–2 周）— 支付宝 + 抖音小程序

1. 同一 uni 工程条件编译差异（登录、分享、支付按钮）
2. 抖音注意内容审核（情感类文案）

### 第 4 期（2 周）— 鸿蒙 + 支付闭环

1. 鸿蒙 NEXT 打包或官方适配通道
2. 微信/支付宝 **Native 支付** 对接（需企业商户号）
3. `payment.js` 扩展回调与订单 KV

---

## 七、支付策略差异

| 渠道 | 当前 | 目标 |
|------|------|------|
| H5 / Web | 对公汇款 + 人工核实 | 保持 |
| 微信小程序 | — | 微信支付 JSAPI → 自动开通会员 |
| 支付宝小程序 | — | 支付宝交易组件 |
| App | — | 微信/支付宝 SDK 或仍引导 H5 汇款 |

**合规：** 虚拟服务/会员需在小程序类目与商户经营范围中覆盖；对公汇款流程可保留为「企业客户通道」。

---

## 八、品牌与包名统一

| 项目 | 建议值 |
|------|--------|
| 应用名 | 我心永恒 Q问 |
| 英文标识 | QTVQ |
| API Base | `https://qtvq-api.pages.dev` |
| 官网 / 隐私政策 | `https://qtvq.cn` |
| Android applicationId | `cn.qtvq.app` |
| iOS Bundle ID | `cn.qtvq.app` |
| 微信 mini program | 独立 AppID（微信公众平台申请） |

---

## 九、开发环境快速开始（uni-app）

```bash
# 安装 HBuilderX 或 CLI
npm install -g @dcloudio/uvm
# 在 apps/qtvq-uni 创建工程后
cd apps/qtvq-uni
npm install
npm run dev:mp-weixin    # 微信小程序
npm run dev:app          # App
npm run dev:mp-alipay    # 支付宝
npm run dev:mp-toutiao   # 抖音
```

API 封装示例（与 Web `js/config.js` 一致）：

```javascript
const API_BASE = 'https://qtvq-api.pages.dev';

export function apiUrl(path) {
  return API_BASE + (path.startsWith('/') ? path : '/' + path);
}

export async function askChat(message, clientId, followUp = false) {
  const res = await uni.request({
    url: apiUrl('/api/chat'),
    method: 'POST',
    header: { 'Content-Type': 'application/json' },
    data: { message, clientId, followUp },
  });
  return res.data;
}
```

---

## 十、风险与备案

| 风险 | 说明 |
|------|------|
| 小程序审核 | 情感咨询类需避免「医疗/心理诊断」表述，强调「信息参考」 |
| 域名 | 小程序不能随意换 API 域，需提前定 `qtvq-api.pages.dev` 或国内备案 API 域 |
| 鸿蒙 | 生态仍在演进，建议 uni-app 官方通道跟进 |
| 数据跨境 | API 在 Cloudflare，小程序用户数据请求境外；长期可考虑 API 国内镜像 + 仅 AI 走境外 |

---

## 十一、下一步（可立即执行）

1. **你确认框架**：uni-app（推荐）或 Taro  
2. **申请账号**：微信/支付宝/抖音/华为/Apple 开发者  
3. **我方可做**：~~初始化 `apps/qtvq-uni`~~ ✅ 已完成 MVP，见 `apps/qtvq-uni/README.md`  
4. **后端并行**：扩展 `functions/lib/cors.js` 注释、准备微信支付 stub 路由  

确认后回复「用 uni-app 建 MVP」，即可在仓库内创建第一期微信小程序 + App 共用工程。
