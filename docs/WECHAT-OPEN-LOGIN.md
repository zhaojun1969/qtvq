# 微信开放平台 · 网站应用扫码登录（PC）

PC 端 [account.html](https://qtvq.cn/account.html) 的「微信扫码登录 / 找回密码」依赖**开放平台网站应用**（与小程序 AppID、支付商户号不是同一个东西）。

**状态（2026-06-12）**：开放平台审核通过、授权回调域 `qtvq.cn`、回调页 `wechat-callback.html`，**PC 扫码登录已可用**。

---

## 1. 开放平台侧（已配置）

登录 [微信开放平台](https://open.weixin.qq.com/) → **管理中心 → 网站应用 → Q问**：

| 配置项 | 填什么 |
|--------|--------|
| **审核状态** | 已通过（未通过时扫码页会报 `redirect_uri 参数错误`） |
| **授权回调验证模式** | **仅域名模式**（推荐） |
| **授权回调域** | `qtvq.cn`（只填域名，不要带 `https://` 或路径） |
| **OAuth redirect_uri** | `https://qtvq.cn/wechat-callback.html`（代码与 Secret 中一致） |
| **业务域名**（若要求） | `qtvq.cn` + 根目录校验文件 |
| **网站应用 AppID** | `wxc4b560055c1978dc`（应用名：Q问） |
| **AppSecret** | 见 `.dev.vars` → `npm run wechat:secrets` |

### 与小程序打通（推荐）

在开放平台 **管理中心 → 公众账号 / 小程序 → 绑定**：

- 把小程序 `wx489fbca28401e4e0` 绑定到**同一开放平台主体**
- 绑定后扫码登录会返回 **unionid**，PC 与小程序账号自动合并（同一用户）

未绑定时，PC 与小程序会是两个独立 openid，需分别登录一次才会各建账号。

### 上线检查清单

1. **开放平台** → 网站应用 Q问 → 审核通过；授权回调域 `qtvq.cn`（仅域名模式）  
2. **绑定小程序** `wx489fbca28401e4e0`（同一开放平台主体，UnionID 打通）  
3. **服务器同步静态站**：

```bash
cd /opt/qtvq && git pull && bash tools/scripts/sync-static.sh
```

4. 确认可访问：  
   - https://qtvq.cn/account.html  
   - https://qtvq.cn/wechat-callback.html  
   - https://qtvq.cn/pO8yu0YU22.txt  
5. **account.html** → 微信扫码登录 → 手机确认 → 回到账户页已登录  
6. **health**：`wechatOpenLoginConfigured: true`

---

## 2. 本项目环境变量

写入 `.dev.vars`（本地）并上传到 Cloudflare Pages Secrets：

```env
# 网站应用（PC 扫码登录）— 与 WECHAT_APP_ID（小程序/支付）不同
WECHAT_OPEN_APP_ID=wxc4b560055c1978dc
WECHAT_OPEN_APP_SECRET=你的网站应用AppSecret
WECHAT_OPEN_REDIRECT_URI=https://qtvq.cn/wechat-callback.html

# 小程序登录（可选，小程序一键登录）
WECHAT_APP_ID=wx489fbca28401e4e0
WECHAT_MINI_APP_SECRET=小程序AppSecret
```

上传并部署：

```powershell
npm run wechat:secrets
npm run deploy:api-only
npm run sync:static
```

验证：

```powershell
curl https://qtvq-api.pages.dev/api/health
# 期望：wechatOpenLoginConfigured: true
```

---

## 3. 授权回调验证模式（重要）

开放平台网站应用支持三种模式（[官方说明](https://developers.weixin.qq.com/doc/oplatform/developers/product/webapp/)）：

| 模式 | 要求 |
|------|------|
| **仅域名模式** | 授权回调域填 `qtvq.cn`，其下任意 https 路径均可作 `redirect_uri`（**推荐**） |
| **仅地址模式** | 须在「回调地址列表」中**逐条登记**完整 URL；未登记的地址会报 `redirect_uri 参数错误` |
| **兼容模式** | 域名 + 地址列表同时生效 |

本项目 `redirect_uri` 为：

```text
https://qtvq.cn/wechat-callback.html
```

- 若选 **仅地址模式**，必须把上述 URL **加入回调地址列表**  
- 若选 **仅域名模式**，授权回调域填 `qtvq.cn` 即可（不要带 `https://`、路径或末尾 `/`）  
- 必须是 **https**，域名须与审核/登记时一致（`qtvq.cn` 与 `www.qtvq.cn` 不同）

---

## 4. 用户流程

| 场景 | 操作 |
|------|------|
| PC 登录 | account.html → **微信扫码登录** → 手机微信确认 |
| 忘记密码 | account.html → 忘记密码 → 填手机号+新密码 → **微信扫码验证并重置** |
| 小程序 | 我的账户 → 微信一键登录（走 `WECHAT_MINI_APP_SECRET`） |

---

## 5. API 路由

| 路由 | 说明 |
|------|------|
| `GET /api/auth/wechat/open` | 返回 `loginUrl`（含 appId、redirectUri） |
| `POST /api/auth/wechat/open` | `{ code, clientId }` 换登录会话 |
| `POST /api/auth/wechat/open` + `action: resetPassword` | 微信验证后重置密码 |

---

## 6. 常见错误

### `redirect_uri 参数错误`（扫码页白屏）

按顺序检查：

1. **网站应用是否审核通过**  
   [open.weixin.qq.com](https://open.weixin.qq.com/) → 网站应用 **Q问** → **审核状态须为「已通过」**。  
   官方文档：未审核通过时无法正确生效授权回调配置，扫码页会直接报 `redirect_uri 参数错误`。

2. **授权回调验证模式**  
   - **推荐**：改为 **仅域名模式**，授权回调域填 `qtvq.cn`  
   - 若使用 **仅地址模式**：必须在回调地址列表中加入  
     `https://qtvq.cn/wechat-callback.html`（完整 URL，与代码一致）  
   - 不要填 `https://qtvq.cn`、`qtvq.cn/`、`www.qtvq.cn`（除非登记的就是 www）

3. **redirect_uri 与代码一致**（须 https，与 Secret 中一致）  
   ```
   https://qtvq.cn/wechat-callback.html
   ```
   不要用 `account.html` 作回调（已改为专用 `wechat-callback.html`）。

4. **网站应用开发资料**  
   - 网站地址：`https://qtvq.cn`  
   - AppID：`wxc4b560055c1978dc`

5. **更新 Secret 后重新部署**  
   ```powershell
   npm run wechat:secrets
   npm run deploy:api-only
   ```

6. **自检 API 返回的 loginUrl**  
   ```bash
   curl -s "https://qtvq-api.pages.dev/api/auth/wechat/open" | jq .redirectUri
   ```
   应显示 `https://qtvq.cn/wechat-callback.html`

| 现象 | 原因 |
|------|------|
| `wechatOpenLoginConfigured: false` | Secrets 未上传或变量名拼错 |
| 扫码后两个账号 | 小程序未绑定同一开放平台，缺少 unionid |
| `10003` | 授权回调域未填 `qtvq.cn` |

---

## 7. 相关文件

- `functions/lib/wechat-open.js` — qrconnect / OAuth2
- `functions/api/auth/wechat/open.js` — 登录 / 找回密码
- `js/auth.js` — 前端跳转与回调
- `wechat-callback.html` — OAuth 回调页（微信跳回此页）
