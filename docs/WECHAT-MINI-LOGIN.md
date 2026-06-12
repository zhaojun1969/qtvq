# 小程序微信一键登录 + UnionID 打通

让小程序「我的账户 → 微信一键登录」可用，并与 PC 扫码登录合并为**同一账号**。

| 能力 | 依赖 |
|------|------|
| 小程序微信登录 | `WECHAT_MINI_APP_SECRET` |
| PC 与小程序同一用户 | 开放平台绑定小程序 + **unionid** |

---

## 一、开放平台绑定小程序（UnionID）

> 先做这一步，之后小程序与 PC 登录都会带上 unionid，后端才能合并账号。

1. 登录 [微信开放平台](https://open.weixin.qq.com/)（与网站应用 **Q问** 同一主体账号）
2. **管理中心** → **公众账号 / 小程序** → **绑定小程序**
3. 填写小程序 AppID：`wx489fbca28401e4e0`
4. 按提示用小程序管理员微信扫码确认绑定

**验证**：绑定成功后，同一用户在 PC 扫码、小程序 `uni.login` 换到的会话应指向同一账户（会员、打款记录一致）。

**未绑定时**：PC 与小程序各有一个 openid，系统可能建两个账号；绑定后新登录会按 unionid 合并。

---

## 二、获取小程序 AppSecret

1. 登录 [微信公众平台](https://mp.weixin.qq.com/)（小程序，不是开放平台）
2. **开发** → **开发管理** → **开发设置**
3. 找到 **AppID** `wx489fbca28401e4e0` 与 **AppSecret**
4. 若 Secret 未生成或遗忘：点 **重置**，管理员微信扫码，**立即复制**（只显示一次）

⚠️ AppSecret 与开放平台网站应用的 Secret **不是同一个**。

---

## 三、写入本项目并上传 Cloudflare

编辑项目根目录 `.dev.vars`（勿提交 Git）：

```env
# 小程序（须与 manifest.json 中 mp-weixin.appid 一致）
WECHAT_APP_ID=wx489fbca28401e4e0
WECHAT_MINI_APP_SECRET=这里粘贴小程序AppSecret

# 以下若已配过可不动（PC 扫码登录）
WECHAT_OPEN_APP_ID=wxc4b560055c1978dc
WECHAT_OPEN_APP_SECRET=...
WECHAT_OPEN_REDIRECT_URI=https://qtvq.cn/wechat-callback.html
```

本机 PowerShell 上传（Windows）：

```powershell
cd d:\qtvq
npm run wechat:secrets
npm run deploy:api-only
```

**阿里云 Linux 服务器**（无 PowerShell，用 bash）：

```bash
cd /opt/qtvq
cp cf.env.example cf.env    # 首次：填入 CLOUDFLARE_API_TOKEN
nano .dev.vars              # 注意文件名是 .dev.vars（不是 .dev.vsrs）
# 至少添加：
# WECHAT_APP_ID=wx489fbca28401e4e0
# WECHAT_MINI_APP_SECRET=小程序AppSecret

npm run wechat:secrets:linux
# 仅上传 Secret 即可生效，一般不必 redeploy；改代码后再：
# npm run deploy:api-only:linux
```

验证 health：

```powershell
curl https://qtvq-api.pages.dev/api/health
```

期望：`wechatMpLoginConfigured: true`

---

## 四、小程序侧前提

| 项 | 要求 |
|----|------|
| request 合法域名 | `https://qtvq-api.pages.dev` |
| 小程序 AppID | `apps/qtvq-uni/src/manifest.json` → `wx489fbca28401e4e0` |
| 真机/开发者工具 | 须登录与小程序关联的微信 |

详见 [apps/qtvq-uni/docs/WEIXIN-ALIPAY.md](../apps/qtvq-uni/docs/WEIXIN-ALIPAY.md) 第 3 节。

---

## 五、自测步骤

### 5.1 小程序一键登录

```bash
cd apps/qtvq-uni
npm run dev:mp-weixin
```

微信开发者工具打开 `dist/dev/mp-weixin`：

1. 进入 **我的账户** Tab  
2. 点 **微信一键登录（推荐）**  
3. 应显示已登录（手机号或「微信用户」）

若失败，看开发者工具 Network 里 `POST /api/auth/wechat` 的错误文案。

### 5.2 UnionID 是否打通

**推荐顺序**（同一微信号、同一手机）：

1. PC 打开 https://qtvq.cn/account.html → **微信扫码登录**  
2. 小程序 **我的账户** → **微信一键登录**  
3. 两边应看到**同一会员状态 / 打款记录**（同一 `clientId` 或同一手机号）

若 PC 先登、小程序后登变成两个账号 → 检查开放平台是否已绑定小程序；绑定后需**两边各重新登录一次**以便写入 unionid。

### 5.3 找回密码（可选）

小程序 **忘记密码** → 填手机号 + 新密码 → **微信验证并重置**（须该账号曾绑定过微信）。

---

## 六、常见错误

| 现象 | 处理 |
|------|------|
| `wechatMpLoginConfigured: false` | `.dev.vars` 未填 Secret 或未 `npm run wechat:secrets` |
| `小程序登录未配置 WECHAT_MINI_APP_SECRET` | 同上 |
| `invalid appsecret` | Secret 错误或 AppID 与 Secret 不匹配，重新重置复制 |
| `40029 invalid code` | code 过期或重复使用，再点一次登录 |
| PC 与小程序两个账号 | 开放平台未绑定小程序，或绑定前已各建账号，绑定后两边重新登录 |
| request 失败 | 小程序后台未配 `qtvq-api.pages.dev` 合法域名 |

---

## 七、相关代码

| 路径 | 说明 |
|------|------|
| `functions/lib/wechat-mp.js` | `jscode2session` → openid / unionid |
| `functions/api/auth/wechat.js` | 小程序登录 / 找回密码 |
| `functions/lib/auth-store.js` | `loginWechatUser` 按 unionid 合并 |
| `apps/qtvq-uni/src/pages/account/account.vue` | 一键登录 UI |
| `apps/qtvq-uni/src/api/auth.js` | `loginWechat` / `wechatLoginCode` |

PC 扫码登录见 [WECHAT-OPEN-LOGIN.md](WECHAT-OPEN-LOGIN.md)。
