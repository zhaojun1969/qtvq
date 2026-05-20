# 绑定自定义域名 qtvq.cn

生产站点已部署在 **Cloudflare Pages** 项目 `qtvq`，默认地址：https://qtvq.pages.dev

将备案域名 **qtvq.cn** 指向 Pages 后，用户即可通过 `https://qtvq.cn` 访问。

---

## 方式 A：域名已在 Cloudflare（推荐）

1. 打开 [Pages 项目 qtvq](https://dash.cloudflare.com/bb7eb342a5cfde7c0a84cd9bd519a859/pages/view/qtvq)
2. **Custom domains** → **Set up a custom domain**
3. 依次添加：
   - `qtvq.cn`
   - `www.qtvq.cn`（可选，项目已含 `www` → 根域 301，见根目录 `_redirects`）
4. 若 `qtvq.cn` 的 DNS 已在当前账号，Cloudflare 会自动写入记录，状态变为 **Active** 即可。

---

## 重要：不要用「URL 转发」到 https://qtvq.pages.dev/

若注册商把 `qtvq.cn` 做成 **跳转到** `https://qtvq.pages.dev/`，Pages 会返回 **403**，站点无法正式上线。

正确做法：在 **Cloudflare DNS** 为 `qtvq.cn` 添加 **CNAME → `qtvq.pages.dev`**（代理开启），并在 Pages 项目里添加自定义域名（已可通过 `npm run bind:domain` 完成 API 绑定）。

**当前 Pages 域名状态查询：** 见 Dashboard → [qtvq Custom domains](https://dash.cloudflare.com/bb7eb342a5cfde7c0a84cd9bd519a859/pages/view/qtvq)  
**DNS 记录页（同账号 zone）：** https://dash.cloudflare.com/e6e39f6e75301e5116ca38c93a4a10ad/qtvq.cn/dns/records

| 类型 | 名称 | 目标 | 代理 |
|------|------|------|------|
| CNAME | `@` | `qtvq.pages.dev` | 已代理（橙色云） |
| CNAME | `www` | `qtvq.pages.dev` | 已代理 |

---

## 方式 B：域名在其他注册商（仅改 DNS）

在域名服务商 DNS 控制台添加（以 Pages 提示为准，以下为常见配置）：

| 主机记录 | 类型 | 记录值 | 说明 |
|----------|------|--------|------|
| `@` | CNAME | `qtvq.pages.dev` | 根域指向 Pages（部分厂商称 ALIAS/ANAME） |
| `www` | CNAME | `qtvq.pages.dev` |  www 子域 |

**注意：**

- 根域 `@` 部分厂商不支持 CNAME，需将 **DNS 服务器改到 Cloudflare** 后按方式 A 操作，或使用注册商提供的「显性/隐性 CNAME」。
- 备案站点请保持 **京ICP备：19045082号** 页脚链接可访问。
- HTTPS 证书由 Cloudflare 自动签发，生效通常需数分钟至 24 小时。

---

## 方式 C：仅 www 先上线

若根域暂时无法 CNAME，可先将 `www.qtvq.cn` 指到 `qtvq.pages.dev`，根域 `qtvq.cn` 在注册商做 **URL 转发** 到 `https://www.qtvq.cn`（临时方案）。

---

## 绑定后自检

```powershell
# 应返回 200
Invoke-WebRequest -Uri "https://qtvq.cn/" -UseBasicParsing | Select-Object StatusCode

# API 应可用
Invoke-RestMethod "https://qtvq.cn/api/payment"
```

浏览器访问：

- https://qtvq.cn/index.html
- https://qtvq.cn/tools/verify-payment.html（工作人员，勿公开链接）

---

## 与备案相关的提示

- 备案主体需与页脚展示信息一致。
- 若管局要求「域名指向国内服务器」，Cloudflare 海外节点可能需改用国内 CDN 或备案接入方式；请以当前管局政策为准。
- 本仓库页脚已链至 https://beian.miit.gov.cn/

---

## 快捷链接

| 操作 | 链接 |
|------|------|
| Pages 项目 | https://dash.cloudflare.com/bb7eb342a5cfde7c0a84cd9bd519a859/pages/view/qtvq |
| 自定义域名 | 同上 → Custom domains |
| 环境变量 / Secret | Settings → Environment variables |
| Workers AI | Settings → Functions |
| KV 绑定 | Settings → Functions → KV `QTVQ_KV` |
