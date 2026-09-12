# QTVQ 新服务 · 路线 B「AI 配对报告」

> 决策记录：产品路线选 **B（AI 配对报告，不做转盘抽异性）**；技术路线选 **照计划书迁移 MongoDB + 自建服务器**。
> 本目录是该决策的落地起点，并对计划书的三个致命问题做了明确处置。

## 为什么路线 B 恰好绕开了计划书最大的技术矛盾

计划书要求「一键 Docker 部署」又要求「Atlas Vector Search」，而它自己在续二里承认：
**「Atlas Vector Search 索引无法在本地 docker 建…向量检索降级为内存计算。」**
一键部署方案与匹配核心互斥 —— 这是全系列最硬的一处自相矛盾。

路线 B 不抽签、不做全库候选召回，只需要**两个人之间**的相似度：

| | 计划书（转盘） | 路线 B（配对报告） |
|---|---|---|
| 相似度计算 | 全库 ANN 召回 Top200 → 融合 → 精排 | **一对用户直接算余弦** |
| 是否要 Atlas Vector Search | 要（且无法本地部署） | **不要** |
| 是否需要数据出境 | 要（Atlas 无大陆 region） | **不要**（自建 MongoDB 在境内） |

所以：**自建 MongoDB + 境内服务器 + 内存余弦**，这三者是自洽的，且完全满足路线 B。

## 三个「不迁移」的刻意设计

1. **不迁移账号**。`src/middleware/auth.js` 带旧 token 回源调 `LEGACY_API_BASE/api/auth/me`，
   拿到 `user.id` 直接当作 MongoDB `_id`。老的注册 / 登录 / 微信扫码 / 支付 / 会员全部不动。
2. **不迁移订单与会员**。计费仍在现有 Cloudflare 侧完成（阶段 4 才接钱包）。
3. **不迁移避坑语料**。用 `npm run import:pitfalls` 从 `../js/data.js` 重新导入并**重新生成向量**
   （换 provider 后必须重跑，否则是跨模型比较，相似度不可信）。

这三点合起来 = **不停机、不搬数据、可随时回滚**的 strangler 迁移。

## 快速开始

```bash
cd server
cp .env.example .env          # 填 DASHSCOPE_API_KEY（阿里云百炼，境内可用）
docker compose up -d mongo
npm install
npm run import:pitfalls       # 导入 50+ 条避坑案例 + 1024 维向量
npm run dev                   # http://127.0.0.1:3000/v1/health
```

**不想先装 MongoDB？** 用内存库跑一次完整自检（39 项断言，含真实 HTTP 请求）：

```bash
npm install --no-save mongodb-memory-server
npm run test:e2e
```

## 自检

| 命令 | 作用 | 依赖 |
|---|---|---|
| `npm run check:imports` | 本地模块图一致性（`node --check` 查不出的具名导入错误）+ 档位枚举完整性 | 无 |
| `npm run probe:models` | 逐个试当前密钥下每个模型，报出可用/不可用**与真实原因** | 密钥 |
| `npm run test:e2e` | 端到端：真实 MongoDB + 真实 HTTP，覆盖资料校验、未成年拦截、报告生成、权限隔离、分享链接、边界错误 | 内存版 MongoDB 或现成数据库 |

在服务器上用现成数据库跑自检（会写入测试数据，必须显式确认）：

```bash
E2E_ACK=1 MONGO_URI='mongodb://127.0.0.1:27017/qtvq' npm run test:e2e
```

安全约定：用外部库时只删除自己创建的 `u_e2e_*` 文档，**绝不 drop 数据库**；`pitfalls` 集合已有数据时跳过写入，**不会覆盖你正式导入的向量**。

## 与前端的对接（Nginx 同源反代，不要开公网端口）

前端页面 `report.html` 通过 **同源** `/v1/...` 访问本服务，因此**不需要 CORS**，也不会有预检请求。
在 `qtvq.cn` 的 Nginx server 块里加一段即可：

```nginx
# /etc/nginx/sites-available/qtvq.conf  （在 server { ... } 内）
location /v1/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # 报告生成要等大模型，默认 60s 会 502
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
}
```

`proxy_read_timeout` 必须放大：生成一份 ¥20/¥50 档报告要跑 1000+ token，实测 20–40 秒，
Nginx 默认 60s 看着够，但叠加排队和模型慢响应就会 502 —— 前端会看到「请求超时」。

改完执行 `sudo nginx -t && sudo systemctl reload nginx`。

对接要点（前端已按此实现，见 `js/report-api.js`）：

| 项 | 说明 |
|---|---|
| 基址 | 生产用同源相对路径 `/v1/...`；本地 `python -m http.server 8080` 预览时自动指向 `127.0.0.1:3000` |
| 鉴权 | 复用现站 token：`localStorage['qtvq_auth_token']`，服务端回源 `LEGACY_API_BASE/api/auth/me` 校验，**不需要重新登录** |
| 超时 | 客户端对生成类接口用 90s 超时（普通接口 8s），与服务端/Nginx 的超时必须同时放大 |
| 页面 | `report.html` + `js/report.js` + `js/report-api.js` + `js/report-share.js` + `css/report.css` |
| 隐私 | `report.html` 带 `noindex, nofollow`；分享链接含 token 且展示个人资料，**不能被搜索引擎收录** |

静态同步脚本已经把这 5 个文件加进清单与校验（`package-static.ps1`、`sync-static-from-windows.ps1`、`sync-static.sh`），
漏传任何一个都会在打包阶段直接报错，而不是上线后白屏。



## 模型配置：两个实测踩到的坑

### 坑 1：百炼「仅使用免费额度」模式会让对话模型全部 403

`text-embedding-v3` 正常（1024 维，约 280ms），但 `qwen-plus` / `qwen-turbo` / `qwen-flash` 全部返回：

```
403 AllocationQuota.FreeTierOnly
Free quota exhausted. ... please add funds or disable the "use free tier only" mode
```

这是**账号设置**，不是代码问题。两种处理：

```bash
npm run probe:models     # 先确认到底哪些可用
```

- **a)** 阿里云百炼控制台 → 关闭「仅使用免费额度」模式（转为按量付费）或充值；
- **b)** 先用已有的 Cloudflare Workers AI 顶上（已实测可用）：

```env
LLM_PROVIDER=workers-ai      # .env 里改这一行即可，CF_ACCOUNT_ID / CF_API_TOKEN 已配好
```

> 注意 (b) 会把用户资料送到 Cloudflare（境外）。内测可以，正式上线若在意个人信息出境，请走 (a)。

### 坑 2：推理模型会把 token 预算吃光，`content` 返回 null

`@cf/zai-org/glm-4.7-flash`、`@cf/qwen/qwen3-30b-a3b-fp8` 是**推理模型**：它们先在 `message.reasoning` 里输出一大段思考，**这段同样计入 `max_tokens`**。预算给小了就会得到：

```json
{"message":{"content":null,"reasoning":"1. **分析用户请求**……"},"finish_reason":"length"}
```

看起来像「模型返回为空」，实际是被思考过程占满了。`src/services/llm.js` 的 `budgetFor()` 对推理模型自动放大预算（`maxTokens*2+512`，上限 4096），并把降级链末尾放一个**非推理模型**（`@cf/meta/llama-3.1-8b-instruct`）兜底。修复前后对比：

| | 修复前 | 修复后 |
|---|---|---|
| `max_tokens` | 32（按字面配置） | 2048 |
| `content` | `null` | 「连通」 |

> 顺带说明：现网 `functions/api/chat.js` 用同样的推理模型 + `max_tokens: 512`，但**生产实测正常**（真实 AI 回答 + RAG 引用，无 fallback）——因为问答回复短，512 够用。本服务的报告需要 1000+ 字正文，所以必须放大预算。

内测登录（仅当 `.env` 里 `ALLOW_DEV_LOGIN=1`）：

```bash
curl -X POST http://127.0.0.1:3000/v1/auth/dev-login -H 'content-type: application/json' -d '{"uid":"u_dev_1"}'
```

## 接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/v1/health` | 否 | 服务 / MongoDB / 模型配置 / 向量策略 |
| GET | `/v1/profile/me` | 是 | 我的资料（含向量维度与完整度） |
| PATCH | `/v1/profile/me` | 是 | 改资料，**自动重算向量** |
| GET | `/v1/profile/:uid` | 是 | 他人公开资料（脱敏） |
| POST | `/v1/report/generate` | 是 | 生成配对报告 `{targetUid, tier, question}` |
| GET | `/v1/report/mine` | 是 | 我的报告列表 |
| GET | `/v1/report/:id` | 是/分享 | 报告详情（非本人须带 `?share=`） |
| POST | `/v1/report/:id/share` | 是 | 生成分享链接（供长图二维码使用） |
| POST | `/v1/report/invite` | 是 | 对方未注册时生成邀请链接 |

档位（`src/constants.js` 为唯一口径）：`basic 缘分一转 ¥1` / `advanced 心动三转 ¥5` / `deep 深度配对 ¥20` / `soul 灵魂契合 ¥50`。
**本阶段不扣费**，响应里返回 `billing: "deferred"`，避免「看起来收费、实际免费」的静默缺口。

## 已刻意加入的防坑措施

| 措施 | 对应计划书的缺陷 |
|---|---|
| 分数由 `dimensions.js` 确定性算出，模型只写正文 | 计划书让模型兼任打分，同一对用户重复生成会得到不同契合度 |
| 报告生成失败降级为「分数 + 真实案例」的确定性文案 | 计划书里模型一挂就 500 |
| 不返回 `profileVector`、不返回 `phone`/`idHash` | 计划书 `GET /user/me` 的 projection 处理不完整 |
| 年龄 18–80 校验 + 昵称/简介联系方式拦截 | 计划书的未成年保护仅有一句清单 |
| 候选/报告只接受 `status=active`，`banned/invisible` 一律 404 | 计划书两套封禁字段并存（`status` vs `risk_level`） |
| CORS 回显具体 Origin | 计划书的 `origin:'*' + credentials:true` 是浏览器直接拒绝的非法组合 |
| 分享页只展示脱敏快照 + 30 天 token | 计划书分享图与 `/report/{id}` 页面在 Nginx 配置里根本没有对应 location |
| 不含 Atlas / OpenAI 依赖 | 前者无大陆 region、后者不可直连，两者都构成个人信息出境 |

## 尚未做（明确的下一步）

- **阶段 4 计费**：钱包落 D1（Cloudflare 侧）或 Mongo 事务，转盘/报告扣费 + 幂等
- **阶段 5 前端**：`report.html` + `js/report.js` + 分享长图（复用 `js/action-card.js`）
- **阶段 6 合规**：举报入口、敏感词库、内容安全接入、年龄门文案
- **不建议做**：转盘抽异性、虚拟头像池、数字人、保险、课程、区块链、出海多区域（理由见 `../docs/计划书对齐与整改实施方案.md` 附录 C）
