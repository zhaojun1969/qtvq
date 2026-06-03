# Gitee 私有仓库 · 首次配置

GitHub 已推送时，Gitee 需 **先建私有空仓库** 再 push（远程 `gitee` 已指向 `zhaojun1969/qtvq`，请按你的用户名修改）。

---

## 步骤 1：创建私有仓库

1. 登录 https://gitee.com  
2. 右上角 **+** → **新建仓库**  
3. 填写：
   - 仓库名称：`qtvq`
   - 路径：`qtvq`
   - **私有**（必选）
   - **不要**勾选「使用 Readme 文件初始化仓库」
4. 点击 **创建**

---

## 步骤 2：配置远程（用户名若不是 zhaojun1969）

```powershell
cd d:\qtvq
git remote set-url gitee https://gitee.com/你的Gitee用户名/qtvq.git
git remote -v
```

---

## 步骤 3：推送

```powershell
git push -u gitee main
```

用户名填 Gitee 账号，密码填 **私人令牌**（设置 → 安全设置 → 私人令牌，勾选 `projects`）。

或一键双推（GitHub + Gitee）：

```powershell
npm run git:push-all
```

---

## 步骤 4：确认私有

仓库页 → **管理** → **基本信息** → 仓库类型应为 **私有**。

---

## 常见问题

| 问题 | 处理 |
|------|------|
| `404` / repository not found | 尚未在 Gitee 创建 `qtvq` 私有仓 |
| 认证失败 | 使用私人令牌，不要用登录密码 |
| 推送卡住 | 在本机终端手动 `git push gitee main` 完成登录 |

---

## 与 GitHub 同步

以后每次发版：

```powershell
npm run git:push-all
```

GitHub 改私有：仓库 Settings → Danger Zone → Make private（见 [GIT-PRIVATE.md](GIT-PRIVATE.md)）。
