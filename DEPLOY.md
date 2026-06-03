# Cloudflare 部署指南 · 我心永恒-Q问

## 当前生产架构（双域）

| 角色 | 域名 / 项目 | 说明 |
|------|-------------|------|
| **国内静态** | https://qtvq.cn | 阿里云 Ubuntu + Nginx，仅 HTML/CSS/JS |
| **API + AI** | https://qtvq-api.pages.dev | Cloudflare Pages 项目 **`qtvq-api`**（Functions、Workers AI、KV） |
| **工作人员核实** | https://qtvq-api.pages.dev/tools/verify-payment.html | 勿放在 qtvq.cn（国内机无 `/api`） |

前端 `js/config.js` 在 **qtvq.cn** 上会把请求指向 **qtvq-api.pages.dev**；Functions 已配置 CORS。

**更新静态（阿里云）：**

```bash
cd /opt/qtvq && git pull && bash tools/scripts/sync-static.sh
```

**更新 API（本机或 CI）：**

```bash
npm run deploy          # → qtvq-api
npm run post-deploy     # 上传密钥 + 冒烟测试
```

详细步骤见 **[docs/DUAL-DEPLOY.md](docs/DUAL-DEPLOY.md)**。

---

## 前置条件

- [Node.js](https://nodejs.org/) 18+
- Cloudflare 账号
- 域名 `qtvq.cn`（可选，Pages 会先分配 `*.pages.dev` 子域）

## 一、安装 Wrangler 并登录

```bash
npm install -g wrangler
wrangler login
```

在浏览器完成授权后，终端应显示已登录账号。

**无浏览器环境**（CI/服务器）可改用 API Token：

1. Cloudflare Dashboard → My Profile → API Tokens → Create Token（权限：Account / Cloudflare Pages Edit、Workers KV Storage Edit）
2. PowerShell：`$env:CLOUDFLARE_API_TOKEN="你的token"`
3. 再执行 `npm run deploy:full`

## 二、创建 Pages 项目

```bash
cd d:\qtvq
wrangler pages project create qtvq
```

## 三、部署静态站点 + Functions

项目根目录即为构建输出（`wrangler.toml` 中 `pages_build_output_dir = "."`）。

```bash
wrangler pages deploy . --project-name=qtvq-api
```

部署成功后终端会输出访问地址。

**当前生产环境：**

| 项目 | 值 |
|------|-----|
| API 主域 | https://qtvq-api.pages.dev |
| 国内静态 | https://qtvq.cn（阿里云 Nginx） |
| Pages 项目名 | `qtvq-api` |
| Account ID | `bb7eb342a5cfde7c0a84cd9bd519a859` |
| KV 生产 id | `4ec5d9cc8b3e4210bd29112073a6c502` |
| KV preview id | `2ccfcfce96164bb4b5805c51f0375f4e` |
| 工作人员核实页 | https://qtvq-api.pages.dev/tools/verify-payment.html |
| 绑定域名脚本 | `npm run bind:domain` |
| DNS 控制台直达 | https://dash.cloudflare.com/e6e39f6e75301e5116ca38c93a4a10ad/qtvq.cn/dns/records |

每次 deploy 可能另有预览 URL（如 `https://xxxx.qtvq.pages.dev`），以终端输出为准。

## 四、绑定 Workers AI（必做，否则仅用本地 mock）

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. **Workers & Pages** → 选择项目 **`qtvq-api`**
3. **Settings** → **Functions** → 开启 **Workers AI**
4. 添加绑定：变量名 **`AI`**，类型 **Workers AI**

或在 `wrangler.toml` 中已配置：

```toml
[ai]
binding = "AI"
```

重新部署后，`/api/chat` 将调用 `@cf/meta/llama-3-8b-instruct`。

## 五、国内域名 qtvq.cn（阿里云静态）

**qtvq.cn 不在 Cloudflare Pages 上**，由阿里云轻量机 Nginx 提供静态文件；DNS 在注册商/阿里云解析为 **A 记录 → 轻量机 IP**。

绑定与自检见 **[docs/DUAL-DEPLOY.md](docs/DUAL-DEPLOY.md)**。  
若曾将 qtvq.cn CNAME 到 Pages，请改回 A 记录指向国内服务器。

~~（以下为原 Cloudflare 全站托管方案，仅作参考）~~

<!--
## 五（旧）、绑定自定义域名 qtvq.cn 到 Pages

**详细图文步骤见：** [docs/DOMAIN-qtvq.cn.md](docs/DOMAIN-qtvq.cn.md)

简要流程：

1. 打开 [Pages 项目 qtvq](https://dash.cloudflare.com/bb7eb342a5cfde7c0a84cd9bd519a859/pages/view/qtvq) → **Custom domains** → **Set up a custom domain**
2. 添加 `qtvq.cn`（及可选 `www.qtvq.cn`）
3. 若域名 DNS 在 Cloudflare：自动生效；若在其他注册商：按面板提示添加 **CNAME `@` / `www` → `qtvq.pages.dev`**
4. 重新部署或等待证书签发（通常数分钟）

项目根目录 `_redirects` 已将 `www.qtvq.cn` 301 到 `qtvq.cn`（绑定 www 后生效）。

绑定完成后执行自检：

```powershell
Invoke-RestMethod "https://qtvq.cn/api/payment"
```

-->

绑定完成后自检（国内静态 + 境外 API）：

```powershell
curl.exe -I https://qtvq.cn/
curl.exe -s https://qtvq.cn/js/config.js
curl.exe -s https://qtvq-api.pages.dev/api/payment
```

## 六、安全建议（Dashboard）

- **Security** → **WAF**：开启基础规则
- **Security** → **Bots**：按需开启
- **Rules** → **Rate limiting**：限制 `/api/chat` 例如 20 次/分钟/IP

项目已包含根目录 `_headers` 基础安全头。

## 七、本地开发（含 API）

```bash
npx wrangler pages dev . --port 8788
```

浏览器打开 http://localhost:8788 ，可测试真实 Workers AI。

## 八、仅静态预览（无 AI 接口）

```bash
npm run serve
# 或 python -m http.server 8080
```

此时 Q问 使用 `js/app.js` 中的智能 mock 回复。

## 九、提问额度与会员汇款

- 每位用户 **每 24 小时最多 5 次新提问**（「再问一步」不计入）。
- 超出后需办理 **月卡 ¥288 / 季卡 ¥788 / 年卡 ¥2888**，对公汇款至页面所示账户。
- **工作人员在工商银行核对到账后**，调用核实接口方可解禁不限次数提问。

### 环境变量（生产必配）

在 Pages → **Settings** → **Environment variables** 添加：

| 变量名 | 说明 |
|--------|------|
| `PAYMENT_ADMIN_KEY` | 汇款核实接口密钥，仅工作人员掌握 |

本地开发可复制 `.dev.vars.example` 为 `.dev.vars` 并填写密钥。

**通过 CLI 上传生产密钥（已配置可跳过）：**

```powershell
# .dev.vars 中一行: PAYMENT_ADMIN_KEY=你的强密钥
Get-Content .dev.vars | Where-Object { $_ -match '^PAYMENT_ADMIN_KEY=' } | ForEach-Object { ($_ -split '=',2)[1] } | npx wrangler pages secret put PAYMENT_ADMIN_KEY --project-name=qtvq-api
npx wrangler pages deploy . --project-name=qtvq-api
```

或执行：`npm run post-deploy`（从 `.dev.vars` 上传密钥并 redeploy + 冒烟测试）。

### 用户提交汇款

`POST /api/payment`，JSON 示例：

```json
{
  "clientId": "q_xxx",
  "plan": "month",
  "payerName": "张三",
  "paidAt": "2026-05-20 14:30",
  "amount": 288,
  "remark": "q_xxx"
}
```

`plan` 取值：`month` | `quarter` | `year`。

### 工作人员核实解禁

核对工商银行到账记录与用户提交信息后：

```bash
curl -X POST https://qtvq.cn/api/payment \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"verify\",\"adminKey\":\"你的密钥\",\"clientId\":\"用户设备编号\",\"plan\":\"month\"}"
```

成功返回后，用户刷新页面或再次提问即同步为 **不限次数**（至套餐有效期）。

也可在浏览器打开内部页 `tools/verify-payment.html`（需与站点同域部署，且已配置 `PAYMENT_ADMIN_KEY`）。

### 查询额度

`GET /api/quota?clientId=q_xxx`

### 绑定 KV（生产推荐）

提问次数、会员有效期、待核实汇款需持久化，避免 Function 重启后丢失。

**一键（Windows PowerShell，推荐）：**

```powershell
cd d:\qtvq
npm run setup:kv
```

脚本会自动创建 KV、把 `id` / `preview_id` 写入 `wrangler.toml`。

**一键 KV + 部署：**

```powershell
npm run deploy:full
```

或手动：

```bash
cd d:\qtvq
wrangler kv namespace create QTVQ_KV
wrangler kv namespace create QTVQ_KV --preview
```

将输出的 `id` / `preview_id` 填入 `wrangler.toml` 中 `[[kv_namespaces]]`，并在 **Pages → Settings → Functions → KV namespace bindings** 添加绑定，变量名 **`QTVQ_KV`**。

未绑定 KV 时自动降级为内存存储（仅适合本地 `wrangler pages dev`）。

### 待核实列表（工作人员）

`GET /api/payment?list=pending&adminKey=你的密钥`

或在 `tools/verify-payment.html` 中刷新列表，核对工行到账后一键解禁。

## 十、Git 自动部署（推荐）

1. 将代码推送到 GitHub
2. Cloudflare Pages → **Create project** → **Connect to Git**
3. 构建命令留空，输出目录填 `/`（根目录）
4. 每次 push 自动部署

## 十一、上线检查清单

部署 `qtvq.cn` 前请逐项确认：

- [x] `wrangler pages deploy` 成功 → https://qtvq.pages.dev
- [x] **KV** 已创建并写入 `wrangler.toml`（线上 `/api/quota` 返回 `storage: kv`）
- [x] **`PAYMENT_ADMIN_KEY`** 已通过 `wrangler pages secret put` 配置（密钥在本地 `.dev.vars`，勿提交 Git）
- [ ] **Workers AI** 在 Dashboard 绑定变量名 `AI`（未绑定时问答走 mock 兜底）
- [ ] 自定义域名 **qtvq.cn** DNS 为 CNAME→`qtvq.pages.dev`（勿用 URL 跳转到 pages.dev）
- [x] Pages 已添加自定义域 `qtvq.cn` / `www.qtvq.cn`（`npm run bind:domain`）
- [ ] 用测试设备编号走一遍：提问 5 次 → 会员窗 → 提交汇款 → `tools/verify-payment.html` 核实 → 刷新后可继续提问
- [x] `tools/` 已 `robots.txt` Disallow
- [x] 页脚 ICP 链接正常

## 常见问题

| 问题 | 处理 |
|------|------|
| `/api/chat` 404 | 确认 `functions/api/chat.js` 存在且已重新 deploy |
| AI 无响应 | 检查 Workers AI 绑定名是否为 `AI` |
| 仅 mock 回复 | 本地静态服务正常；生产需 Pages Functions |
| 提问仍提示超限 | 确认已配置 `PAYMENT_ADMIN_KEY` 并完成核实；用户需刷新同步会员状态 |
| 备案显示 | 页脚 ICP 链接已指向 https://beian.miit.gov.cn/ |
