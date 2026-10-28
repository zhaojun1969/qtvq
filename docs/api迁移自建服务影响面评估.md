# `/api/*` 迁移到自建 Node 服务 —— 影响面评估

> 背景：`/api/*` 经 nginx 反代到 Cloudflare Pages（跨国链路，实测稳定后仍有 **1–3.5s**，
> 且曾因 `pages.dev` 的 DNS 只返回两个从 ECS 不可达的 IP 而**间歇挂死 60s**）。
> `/v1/*` 走自建 Node（本机回环，**毫秒级**）。业务方决定：**把关键接口迁到自建服务**。
> 本文只评估影响面与顺序，不含实施代码。

## 一、现状盘点（哪些在 Pages，哪些在 Node）

| 侧 | 入口 | 承接内容 |
| --- | --- | --- |
| Pages Functions（`functions/`） | `/api/*` | 认证与会话、短信验证码、微信扫码登录、账号注销、额度、语音、**微信支付下单/回调/查单**、AI 对话、`/api/app/bootstrap`、`/api/ops/alert`、`/api/health` |
| 自建 Node（`server/`，端口 3000） | `/v1/*` | 配对报告、转盘、避坑、钱包与充值到账、内容安全、运营台、`/v1/pitfalls`、`/v1/health` |

**有利条件（这条决定了迁移可行）**：Node 钱包 `users._id` **复用的就是 Cloudflare 的 uid**（`u_xxx`），
两端本来就在同一套用户主键上，不需要用户映射表，也不会有"迁移后余额对不上"这类问题。

## 二、迁移难度分档（按"依赖 Cloudflare 专有能力的程度"）

| 档 | 接口 | 难度 | 原因 |
| --- | --- | --- | --- |
| **A（可直接迁）** | `/api/quota`、`/api/health`、`/api/ops/alert`、`/api/app/bootstrap` | 低 | 纯逻辑 + KV/静态数据，Node 已有等价存储（Mongo + 仓库内 `app-releases.json`） |
| **B（需替代 KV/AI 绑定）** | `/api/chat`、`/api/speech` | 中 | **`/api/speech` 已完成（2026-10-11，见第六节）**；`/api/chat` **仍不可动**：它引 `functions/lib/quota-store.js` 的 `canAsk/recordAsk/getQuota`（数据在 Cloudflare KV），迁它等于把「KV→Mongo」一起拖进来 |
| **C（高风险，必须动支付）** | `/api/payment/wechat/create`、`/query`、`/notify` | 高 | **回调地址 `https://qtvq.cn/api/payment/wechat/notify` 已配置在微信商户平台**，路径不能变；改由 nginx 把该路径转到 Node 即可，但**钱路径必须完整回归测试**（¥1 / ¥10 / ¥29 三档 + 自动到账 + 幂等） |
| **D（最高风险，动会话）** | `/api/auth/*`（登录、短信、微信扫码、`me`、注销） | 高 | **会话不兼容会让全部已登录用户被登出**。Pages 侧的会话/令牌与 Node 的 JWT 是两套，必须先做**双读**（Node 能验 Pages 签发的令牌，或两端共用一个 JWT 密钥）再切流 |

## 三、最大风险与必须守住的约束

1. **会话兼容（第一风险）**：切换认证接口前，必须让 Node 能验证 Pages 现存会话，否则全体用户被登出。
   可行做法：两端共用同一 `JWT_SECRET` 与同一套 claims，Node 先"只读校验"Pages 令牌，灰度期不签发新格式。
2. **支付回调路径不可改**：微信商户平台的回调地址是写死的 URL 路径，nginx 只能做**同路径转发**，
   不能让接口换路径。迁移时必须保持 `/api/payment/wechat/notify` 这个 URI 不变。
3. **KV → Mongo 的数据搬迁**：Pages 的 `QTVQ_KV`（`4ec5d9cc8b3e4210bd29112073a6c502`）里存着额度、
   `pending:<clientId>:<orderId>` 待支付索引等。搬迁要**双写一段时间**，确认无读漏后再停旧写。
4. **回滚必须是秒级**：nginx 按 location 切流，任何一步出问题立刻把该 location 指回 Pages（保留旧链路）。
5. **不要一次全切**：按 A → B → C → D 的顺序，每档单独灰度、单独回归。

## 四、建议的实施顺序与验收

1. **第一步（不动钱、不动会话）**：A 档 4 个接口切 Node，nginx 加精确 location，观察 24h；
   验收：错误率不升、P50 从秒级降到毫秒级、`check:all` 与测试套件全绿。
2. **第二步**：B 档（对话/语音）切 Node，验收：AI 链路 `provider/model` 仍为通义、语音 `ready:true`。
3. **第三步**：C 档（支付）——先在 Node 实现并**与 Pages 并存**，用 `?channel=` 之类开关灰度给内部账号，
   跑通 ¥1/¥10/¥29 三档与自动到账、幂等（重复回调只入账一次）后再全量。
4. **第四步**：D 档（认证）——先做令牌双读，再切登录，最保守。

## 五、不建议做的事

- **不建议让 Node 反代回 Posts（Pages）**：那只是把延迟叠加，链路更长、故障点更多。
- **不建议为迁移去改微信商户平台配置**：回调地址一改就得重新验证，风险大于收益。
- **不建议在没有"秒级回滚"之前切钱路径**。

## 六、已完成：`/api/speech` 迁到自建 Node（2026-10-11）

**为什么先切它**：它**不查额度、不碰 KV、不写库**（`functions/api/speech.js` 只依赖 `aliyun-nls.js`），
是"一次只动一个变量"里最干净的那个；而 `/api/chat` 引 `functions/lib/quota-store.js` 的
`canAsk/recordAsk/getQuota`（数据在 KV），迁它会同时拖动「KV→Mongo」，故**暂不迁**。

**改动**：

| 文件 | 内容 |
| --- | --- |
| `server/src/lib/aliyun-nls.js` | 从 `functions/lib/aliyun-nls.js` 移植（0 个 import，可安全复制） |
| `server/src/routes/speech.js`（新） | 契约逐字对齐 Pages：GET→`{configured,ready,reason,nlsCode}`；POST→`{ok,text}`，另有 400（无效 JSON／缺 audio／非法 base64／超 512KB）、503（未配置）、422（识别失败）、502（上游异常）。**503 与 422 不能混**：前端用它们区分"功能没开"和"这次没听清" |
| `server/src/app.js` | `app.use('/api/speech', speechRoutes)`（**保留 `/api/` 前缀**：5 个端都按此路径调用，改路径就要同时改 5 个端）；并**把全局 `express.json` 上限 256kb → 1mb**（base64 放大约 1/3，512KB 录音 ≈683KB，256kb 会判 413，前端只看到"录音发不出去"，极难排查） |
| nginx | `location = /api/speech { proxy_pass http://127.0.0.1:3000; … }`，其余 `/api/` 仍走 Pages |

**验证（双端逐字比对）**：

```
GET  经 nginx→Node : {"configured":true,"ready":true,"reason":null,"nlsCode":null}
GET  直连 Pages    : {"configured":true,"ready":true,"reason":null,"nlsCode":null}
POST 缺 audio      : 两端同为 400 {"error":"缺少 audio（base64）"}
POST 真音频（0.2s 静音 WAV 6444 字节，经 nginx→Node）
                   : 422 {"ok":false,"code":"no_speech","message":"未识别到有效语音"}  ← 契约正确
部署指纹 40dc9f988adab1b7（本地 = 线上）
```

**顺手修掉一处真实漂移**：服务器上的 `server/src/lib/aliyun-nls.js` 是 **7683 字节的旧版本**
（导出面相同所以能跑），仓库里是 **7895 字节**；用本地版本覆盖后部署指纹才重新对上。
——**部署自检是对的，不要把它当误报**；靠逐文件 `sha256sum` 比对才定位到就是这一个文件。

**回滚**：删掉那段 `location = /api/speech` + `nginx -t && sudo systemctl reload nginx`（秒级）。

**识别成功分支已补验（2026-10-11）**：用本机 Windows 语音合成（SAPI）造了一段 **16k/单声道/16bit、137006 字节**的真实语音，经 `https://qtvq.cn/api/speech`（nginx→自建 Node→阿里云 NLS）返回
`HTTP 200 {"ok":true,"text":"Hello I would like to know how this matching report works"}` —— 成功分支、错误分支、就绪探测三条路都已在真实链路上验证。
（本机只有 en-US 语音 Zira，没有中文语音，所以样本是英文；这不影响"成功分支"结论，只说明该 NLS 工程也能识别英文。）

## 七、已完成：`/api/app/bootstrap` 迁到自建 Node（2026-10-11）

**为什么先切它**：它是**唯一**"无会话、无钱、无 KV 数据"的接口；真实收益不是延迟（App 启动只调一次），而是**可用性** —— Cloudflare 链路出问题时，各端仍能拿到版本记录、更新结论与能力清单。

**闸门先行的做法（本次的关键纪律）**：**切换 nginx 之前**必须先让 `tools/scripts/check-app-bootstrap-gate.mjs` 双端逐字段全绿。为了让闸门能在**不动 nginx** 的前提下读到 Node 的真实输出，把同一个 handler **同时挂两个前缀**：
`/api/app/bootstrap`（切流后对外）与 `/v1/app/bootstrap`（nginx 早已把 `/v1/` 反代到 Node，切流前即可比对）。

**闸门实际拦下的 4 个会静默出事的错误**：

| # | 问题 | 若没闸门的后果 |
| --- | --- | --- |
| 1 | 读源码时窗口被截断，**漏了 8 个能力字段**（`wheel/wallet/moderation/profile/deactivateAccount/dataExport/crisisReferral/adultGate`） | 切上去后所有端的转盘/钱包/举报/资料/注销入口**一次性消失，日志全绿** |
| 2 | `releaseFor` 多写了 `?? DEFAULT_RELEASE` → `hadRelease` 恒真 | 无发布记录的渠道 `reason` 由 `no_release` 变 `up_to_date`，端侧误判"有正式发布" |
| 3 | 服务器 `.env` **末尾无换行**，追加时粘到上一行 → `SMTP_TO=qtvq@qtvq.cnWECHAT_MCH_PRIVATE_KEY="-----BEGIN P…` | PEM 解析不出**且 `SMTP_TO` 被污染** |
| 4 | 已存在一行**空值** `WECHAT_MINI_APP_SECRET=` 遮蔽后加的赋值 | `login.wechat`/`notify.wechat` 恒 false → 微信一键登录与订阅消息对所有端隐藏 |

**结果**：闸门 **通过 33 · 失败 0** → 才切 nginx（`location = /api/app/bootstrap`）；切流后与 Pages **除时间字段外逐字段一致**（`login.wechat/pay.wechat/notify.wechat/llm/rag` 两侧同为 true）。闸门已纳入 `npm run check:all`。

**回滚**：删掉该 `location` + `nginx -t && sudo systemctl reload nginx`（秒级）。

**过程中另外修掉的两处**：
1. **指纹自检的行尾假警报**：打包脚本会对文本文件做 CRLF→LF（有意为之），而指纹原先对原始字节哈希 ⇒ 工作区带 CRLF 的文件（`core.autocrlf=true` 下很常见）永远与线上不一致。已在**三处**实现统一做行尾归一化：`server/src/lib/build-info.js`、`tools/scripts/server-build-sha.mjs`、`tools/scripts/upload-server-bundle.py` 的 `source_fingerprint()`。
2. **仓库与生产的配置漂移**：`deploy/hardening/nginx/qtvq-security.conf` 与 `qtvq-server-snippet.conf` 里仍是**旧的严格限速**（10/3/1 r/s、burst 3/6），而生产已放宽为 20/10/5 r/s、burst 10/20 —— 直接跑 `install.sh` 会把这些改动**回退**。已同步仓库侧。
