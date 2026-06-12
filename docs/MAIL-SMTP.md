# 联系客服 · 邮件（SMTP / Resend）

用户通过页脚 **qtvq@qtvq.cn** 提交留言后，API 会：

1. 写入 Cloudflare KV（90 天）
2. 备份至阿里云 OSS（若已配置）
3. **发送邮件至客服邮箱**（若已配置 SMTP / Resend）

---

## 方式 A：SMTP（推荐）

Cloudflare Workers 通过 TCP **465 + SSL** 连接 SMTP 服务器（不支持 587 STARTTLS）。

### 阿里云企业邮箱

1. 登录 [阿里云企业邮箱](https://qiye.aliyun.com/) 管理后台
2. 确认已开通 `qtvq@qtvq.cn` 邮箱
3. 在邮箱设置中开启 **SMTP 发信**，获取授权码（或使用独立密码）
4. 填写环境变量：

```env
MAIL_PROVIDER=smtp
SMTP_HOST=smtp.qiye.aliyun.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=qtvq@qtvq.cn
SMTP_PASS=你的SMTP授权码
SMTP_FROM=qtvq@qtvq.cn
SMTP_TO=qtvq@qtvq.cn
```

### 腾讯企业邮

```env
SMTP_HOST=smtp.exmail.qq.com
SMTP_PORT=465
SMTP_USER=qtvq@qtvq.cn
SMTP_PASS=授权码
```

### QQ 邮箱（个人）

需在 QQ 邮箱设置 → 账户 → 开启 SMTP，使用 **授权码**（非 QQ 密码）：

```env
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_USER=你的QQ邮箱
SMTP_PASS=16位授权码
SMTP_FROM=你的QQ邮箱
SMTP_TO=qtvq@qtvq.cn
```

---

## 方式 B：Resend（HTTP API）

适合已把 DNS 托管在 Cloudflare、并在 Resend 验证 `qtvq.cn` 发信域名的场景。

1. 注册 [Resend](https://resend.com/)，添加并验证域名 `qtvq.cn`
2. 创建 API Key
3. 配置：

```env
MAIL_PROVIDER=resend
RESEND_API_KEY=re_xxxxxxxx
MAIL_FROM=Q问 <noreply@qtvq.cn>
MAIL_TO=qtvq@qtvq.cn
```

---

## 本地开发

1. 复制 `.dev.vars.example` → `.dev.vars`
2. 填写 SMTP 或 Resend 变量
3. 启动：

```powershell
npm run dev
```

4. 打开首页 → 页脚邮箱 → 提交测试留言

---

## 生产部署（Cloudflare Pages Secrets）

**不要把 SMTP 密码提交 Git。** 写入 `.dev.vars` 后执行：

```powershell
# 上传全部邮件相关 Secret（读取 .dev.vars）
powershell -ExecutionPolicy Bypass -File tools/scripts/upload-mail-secrets.ps1

# 或部署 API 时一并上传
npm run deploy:api-only
```

也可在 Dashboard 手动添加（Settings → Environment variables → **Production** → Encrypt）：

| 变量 | 说明 |
|------|------|
| `MAIL_PROVIDER` | `smtp` 或 `resend` |
| `SMTP_HOST` | SMTP 服务器 |
| `SMTP_PORT` | 465 |
| `SMTP_USER` | 发信账号 |
| `SMTP_PASS` | **Secret** 授权码/密码 |
| `SMTP_FROM` | 发件人地址 |
| `SMTP_TO` | 收件人（客服邮箱） |

---

## 自检

```powershell
# health 接口应含 mailConfigured: true
curl.exe https://qtvq-api.pages.dev/api/health

# 测试留言（勿在生产频繁调用）
curl.exe -X POST https://qtvq-api.pages.dev/api/contact ^
  -H "Content-Type: application/json" ^
  -d "{\"message\":\"邮件测试\",\"clientId\":\"mail_test\"}"
```

返回 `"emailSent": true` 表示邮件已发出；`mailConfigured: false` 表示 Secret 未配置。

---

## 故障排查

| 现象 | 处理 |
|------|------|
| `mailConfigured: false` | 检查 Pages Secret 是否上传、变量名是否拼写正确 |
| `emailSent: false` 留言仍保存 | 查看 Cloudflare Workers 日志；多为 SMTP 账号/授权码错误 |
| 阿里云拒信 | 确认 `SMTP_FROM` 与 `SMTP_USER` 为已授权发信地址 |
| 本地 dev 发信失败 | `wrangler pages dev` 需较新版本；生产环境 TCP 更稳定 |

邮件发送失败时，留言仍会保存在 KV/OSS，不会丢失。
