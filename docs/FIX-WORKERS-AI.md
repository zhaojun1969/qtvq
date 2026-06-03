# 修复 Workers AI（fallback: true）

当 `/api/chat` 返回 `"fallback": true` 时，说明 **未走真实大模型**，用的是预设模板。

---

## 1. 诊断

部署后访问：

```
https://qtvq-api.pages.dev/api/health
```

| 字段 | 含义 |
|------|------|
| `aiBound: false` | 未绑定 Workers AI |
| `aiBound: true` 且 `aiProbe.ok: false` | 已绑定但调用失败 |
| `aiProbe.ok: true` | AI 正常 |

---

## 2. 绑定 Workers AI（必做）

1. 登录 https://dash.cloudflare.com  
2. **Workers & Pages** → 项目 **`qtvq-api`**（不是 qtvq-site）  
3. **Settings** → **Functions**  
4. **Bindings** → **Add** → **Workers AI**  
5. **Variable name** 必须为：**`AI`**  
6. Save  

同时确认 **KV** 绑定：`QTVQ_KV`（与 `wrangler.toml` 中 id 一致）。

---

## 3. 重新部署

```powershell
cd d:\qtvq
npx wrangler login
npm run deploy
```

`wrangler.toml` 已含：

```toml
[ai]
binding = "AI"
```

部署后再次访问 `/api/health` 验证。

---

## 4. 验证提问

Response 应 **无** `fallback: true`，且回复与问题相关。

`fallbackReason` 说明（调试字段）：

| 值 | 含义 |
|----|------|
| `AI_NOT_BOUND` | 未绑定 AI |
| `AI_RUN_FAILED` | 绑定失败或模型不可用 |
| `MOCK` | 其它原因走模板 |

---

## 5. 账号侧

- Cloudflare 账号需开通 **Workers AI**  
- 免费额度用尽会导致 `AI_RUN_FAILED`  
- Dashboard → **Workers AI** 查看用量  
