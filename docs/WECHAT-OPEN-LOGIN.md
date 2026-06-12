# 微信开放平台 · 网站应用扫码登录（PC）

PC 端 [account.html](https://qtvq.cn/account.html) 的「微信扫码登录 / 找回密码」依赖**开放平台网站应用**（与小程序 AppID、支付商户号不是同一个东西）。

---

## 1. 开放平台侧（你已开通网站应用）

登录 [微信开放平台](https://open.weixin.qq.com/) → **管理中心 → 网站应用 → 你的应用**：

| 配置项 | 填什么 |
|--------|--------|
| **授权回调域** | `qtvq.cn`（只填域名，不要带 `https://` 或路径） |
| **业务域名**（若要求） | `qtvq.cn` |
| **网站应用 AppID** | `wxc4b560055c1978dc`（应用名：Q问） |
| 记录 **AppSecret** | 在应用详情中查看 / 重置 |

### 与小程序打通（推荐）

在开放平台 **管理中心 → 公众账号 / 小程序 → 绑定**：

- 把小程序 `wx489fbca28401e4e0` 绑定到**同一开放平台主体**
- 绑定后扫码登录会返回 **unionid**，PC 与小程序账号自动合并（同一用户）

未绑定时，PC 与小程序会是两个独立 openid，需分别登录一次才会各建账号。

### 域名校验通过后（你当前阶段）

1. **开放平台** → 网站应用 Q问 → **授权回调域** 填 `qtvq.cn` → 保存  
2. **绑定小程序** `wx489fbca28401e4e0`（同一开放平台主体）  
3. **服务器同步静态站**（`account.html` 上线后才能 PC 扫码登录）：

```bash
cd /opt/qtvq && git pull && bash tools/scripts/sync-static.sh
```

4. 浏览器确认：https://qtvq.cn/account.html 能打开，且有绿色「微信扫码登录」  
5. 点击登录 → 手机微信扫码 → 应跳回账户页并显示已登录  

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

## 3. 回调地址必须完全一致

`WECHAT_OPEN_REDIRECT_URI` 必须与开放平台登记的回调 **逐字一致**，推荐：

```text
https://qtvq.cn/account.html
```

注意：

- 必须是 **https**
- 不要多 trailing slash（除非开放平台也登记了）
- 本地调试可临时改为 `http://127.0.0.1:8788/account.html`，但开放平台回调域通常只允许已备案域名

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
   [open.weixin.qq.com](https://open.weixin.qq.com/) → 网站应用 **Q问** → 状态须为 **已上线/审核通过**。未通过审核时常见此报错。

2. **授权回调域**（只填域名，不要 `https://` 和路径）  
   ```
   qtvq.cn
   ```
   不要填 `www.qtvq.cn`（除非网站用 www 访问）、不要填 `account.html`。

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
