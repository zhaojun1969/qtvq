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
