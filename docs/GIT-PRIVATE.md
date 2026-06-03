# 私有仓库推送 · GitHub + Gitee

本仓库 **必须保持私有**，请勿公开源代码、`.dev.vars`、密钥与 `PAYMENT_ADMIN_KEY`。

---

## GitHub（origin）

### 新建私有仓库

1. https://github.com/new  
2. Repository name：`qtvq`  
3. 选择 **Private**  
4. 不要勾选初始化 README  

### 将已有公开仓改为私有

1. 仓库 → **Settings** → **General** → **Danger Zone**  
2. **Change repository visibility** → **Make private**

### 推送

```powershell
cd d:\qtvq
git remote set-url origin https://github.com/你的用户名/qtvq.git
git push -u origin main
```

使用 Personal Access Token 作为密码（需 **repo** 权限）。

---

## Gitee（gitee）

### 新建私有仓库

1. https://gitee.com/projects/new  
2. 路径：`qtvq`  
3. 选择 **私有**  
4. 不要勾选初始化  

### 添加远程并推送

```powershell
cd d:\qtvq
git remote add gitee https://gitee.com/你的用户名/qtvq.git
git push -u gitee main
```

若已存在 gitee 远程：

```powershell
git remote set-url gitee https://gitee.com/你的用户名/qtvq.git
git push gitee main
```

### 双远程同时推送

```powershell
git push origin main
git push gitee main
```

或一次推两个（需先 `git remote set-url --add --push origin` 配置，更简单是分两次 push）。

---

## 忽略文件（已配置 .gitignore）

- `.dev.vars` / `obs.env`  
- `node_modules/`、`apps/qtvq-uni/node_modules/`  
- `.wrangler/`  

---

## 团队协作

- 仅邀请可信成员为 Collaborator  
- CI 使用只读/部署专用 Token，勿写入仓库  
- Cloudflare `PAYMENT_ADMIN_KEY` 仅通过 `wrangler pages secret` 或 Dashboard 配置  
