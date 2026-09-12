# Gitee 私有仓库 · 首次配置

**当前状态：已配置完成，且走 SSH（无需账号密码）。**

| 项 | 值 |
|---|---|
| Gitee 账号 | `zhaobing2020_admin` |
| 仓库 | https://gitee.com/zhaobing2020_admin/qtvq （私有） |
| remote | `git@gitee.com:zhaobing2020_admin/qtvq.git` |
| 认证方式 | **SSH 公钥**（`~/.ssh/id_ed25519`，已在本机验证可用） |
| 默认分支 | 仓库当前默认是 `master`，代码推在 `main`；建议在 Gitee 仓库设置里把默认分支改成 `main` |

> 不要用账号密码推 Gitee。实测：HTTPS 带密码会返回 `403 Access denied`（Gitee 已限制密码认证 Git 操作），而 SSH 直接可用。用密码还会把明文口令落到磁盘上。

---

## 日常推送

```bash
cd d:\qtvq
npm run git:push-all          # 同时推 GitHub(SSH:443) 与 Gitee(SSH)
```

或单独推：

```bash
git push origin main          # GitHub
git push gitee main           # Gitee
```

---

## 换机器时的完整配置

### 步骤 1：确认仓库存在

在 https://gitee.com 登录 `zhaobing2020_admin`，确认私有仓 `qtvq` 已创建（**私有**、不要用 Readme 初始化）。

### 步骤 2：配置 remote 与 SSH

```powershell
cd d:\qtvq
git remote set-url gitee git@gitee.com:zhaobing2020_admin/qtvq.git
git remote -v

# 验证 SSH 公钥已在 Gitee 登记
ssh -T git@gitee.com
# 期望输出：Hi zhaobing(@zhaobing2020_admin)! You've successfully authenticated...
```

若 `ssh -T` 失败，把公钥内容复制到 Gitee → 设置 → SSH 公钥：

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub
```

### 步骤 3：推送

```powershell
git push -u gitee main
```

### 步骤 4：确认私有

仓库页 → **管理** → **基本信息** → 仓库类型应为 **私有**。

---

## 常见问题

| 问题 | 处理 |
|------|------|
| `404 not found` | 仓库路径不对（用户名拼错）。用 `git remote -v` 核对，或在仓库页面直接复制地址栏 URL |
| `403 Access denied` | 在用账号密码走 HTTPS。改 SSH：`git remote set-url gitee git@gitee.com:zhaobing2020_admin/qtvq.git` |
| `Incorrect username or password` | 同上，Gitee 已不支持密码认证 Git；改用 SSH 或私人令牌 |
| `ssh -T git@gitee.com` 报 Permission denied | 公钥未登记，见步骤 2 |
| 推送卡住 | 见下方「代理」 |

---

## 代理

本机 git 全局配了 `http.proxy=127.0.0.1:31180` / `https.proxy=127.0.0.1:31181`（给 VPN 用）。**代理没开时 HTTPS 操作会直接失败。**

两条现用 remote 都走 SSH，**不经过这个代理**，所以代理开不开都能推：

| remote | 地址 | 是否受代理影响 |
|---|---|---|
| `origin`（GitHub） | `ssh://git@ssh.github.com:443/...` | 否 |
| `gitee` | `git@gitee.com:zhaobing2020_admin/qtvq.git` | 否 |

---

## 与 GitHub 同步

以后每次发版：

```powershell
npm run git:push-all
```

GitHub 改私有：仓库 Settings → Danger Zone → Make private（见 [GIT-PRIVATE.md](GIT-PRIVATE.md)）。

