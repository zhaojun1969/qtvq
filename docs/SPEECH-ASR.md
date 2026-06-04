# 语音输入 · 阿里云一句话识别（NLS）

首页 🎤 **语音** 按钮：浏览器录音 → POST `/api/speech` → 阿里云 NLS 转文字 → 填入提问框。

未配置 NLS 时，前端回退 **Web Speech API**（国内 Chrome 常因网络失败）。

---

## 1. 阿里云控制台

1. 登录 [智能语音交互控制台](https://nls-portal.console.aliyun.com/)
2. **全部项目** → **创建项目**（类型选「一句话识别」或通用）
3. 记录项目的 **AppKey**
4. 确认账号已有 **AccessKey**（可与 OSS 备份共用 `OSS_ACCESS_KEY_ID` / `OSS_SECRET_ACCESS_KEY`）
5. 为 RAM 用户或主账号开通 NLS 相关权限（默认 CreateToken + 一句话识别即可）

---

## 2. 本地开发

在 `.dev.vars` 增加（AccessKey 若已配 OSS 可只加 AppKey）：

```env
NLS_APP_KEY=你的AppKey
OSS_ACCESS_KEY_ID=LTAI...
OSS_SECRET_ACCESS_KEY=...
```

启动：

```bash
npm run dev
```

浏览器打开首页，允许麦克风 → 点语音 → 说话 → 点停止。  
健康检查应含 `speechConfigured: true`：

```bash
curl https://127.0.0.1:8788/api/health
# 或生产：curl https://qtvq-api.pages.dev/api/health
```

---

## 3. 生产 Secret 上传

`.dev.vars` 填写 `NLS_APP_KEY` 后：

```bash
npm run speech:secrets
npm run deploy:api-only
```

或随邮件等一并上传：

```bash
npm run post-deploy
```

`post-deploy.ps1` 会从 `.dev.vars` 读取 `NLS_APP_KEY` 并写入 Cloudflare Pages 项目 **qtvq-api**。

---

## 4. 静态站同步

语音前端在 `js/voice-asr.js`，由 `js/home.js` 引用。改完后：

```bash
npm run package:static
# 服务器：bash tools/scripts/sync-static.sh
```

---

## 5. 接口说明

| 项 | 值 |
|----|-----|
| 路径 | `POST /api/speech` |
| Body | `{ "audio": "<base64>", "format": "wav", "sampleRate": 16000 }` |
| 上限 | 512KB（约 30 秒） |
| 未配置 | `503` + `code: SPEECH_NOT_CONFIGURED` |

---

## 6. 故障排查

| 现象 | 处理 |
|------|------|
| `/api/health` 中 `speechConfigured: false` | 检查 Cloudflare Secret `NLS_APP_KEY` 与 AccessKey |
| `CreateToken` 失败 | AccessKey 权限、账号欠费 |
| `422` / `no_speech` | 录音太短、环境太吵或未说话 |
| 仍走浏览器语音 | 健康检查失败或 API 未部署；看控制台 Network `/api/health` |
| 麦克风失败 | HTTPS、浏览器权限、系统隐私设置 |

Token 缓存在 KV 键 `nls:token:cache`，约 12 小时 TTL 自动刷新。
