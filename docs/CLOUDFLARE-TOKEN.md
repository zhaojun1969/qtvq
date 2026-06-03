# Cloudflare API Token 配置（Wrangler 部署 qtvq-api）

部署报错 `Authentication error [code: 10000]` 时，按本文重新创建 Token。

---

## 1. 创建 Custom Token

打开：https://dash.cloudflare.com/profile/api-tokens → **Create Token** → **Create Custom Token**

### 权限（Permissions）

| 资源 | 权限 | 说明 |
|------|------|------|
| Account | **Account Settings** → Read | 读取账号 ID（whoami 需要） |
| Account | **Cloudflare Pages** → Edit | 部署 Pages |
| Account | **Workers KV Storage** → Edit | KV 绑定 |
| Account | **Workers Scripts** → Edit | Functions 部署 |
| Account | **Workers AI** → Edit | 可选，AI 绑定 |

### 资源范围（Account Resources）

- Include → **Specific account** → 选 `wwwqtvqcn@163.com` 对应账号

### 其他

- Client IP：可留空（或填服务器 IP）
- TTL：按需

点击 **Continue to summary** → **Create Token**，复制 Token（只显示一次）。

**快捷方式：** 也可选模板 **Edit Cloudflare Workers**，再额外加上 **Cloudflare Pages - Edit**。

---

## 2. 在 Ubuntu 设置环境变量（同一终端会话内）

```bash
export CLOUDFLARE_API_TOKEN="粘贴新Token"
export CLOUDFLARE_ACCOUNT_ID="bb7eb342a5cfde7c0a84cd9bd519a859"
```

持久化（可选，注意文件权限）：

```bash
echo 'export CLOUDFLARE_ACCOUNT_ID="bb7eb342a5cfde7c0a84cd9bd519a859"' >> ~/.bashrc
# Token 建议不要写进 bashrc，每次手动 export 或放 chmod 600 的文件
```

---

## 3. 验证 Token

```bash
# Token 是否有效
curl -s "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"

# 是否能访问该 Account
curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

期望：`"success":true`。第二条应返回账号名称，不是 `Authentication error`。

---

## 4. 部署

```bash
cd /opt/qtvq
npm install
npm run deploy
```

---

## 5. 仍失败时

| 现象 | 处理 |
|------|------|
| verify 失败 | Token 复制错误、已删除或过期 → 新建 |
| verify 成功、account 失败 | Token 未包含该 Account 或缺 Account Settings Read |
| deploy 仍 10000 | 缺 **Pages Edit** 权限 |
| 服务器网络问题 | 改在 **Windows 本机** 用同一 Token 执行 `npm run deploy` |

**切勿**在聊天、截图、Git 中提交 Token。若曾泄露，立即在 Dashboard **Roll/Delete** 后重建。

---

## 6. Account ID 确认

Dashboard 右侧栏或：**Workers & Pages** → 任意项目 → 账户 ID 为：

`bb7eb342a5cfde7c0a84cd9bd519a859`
