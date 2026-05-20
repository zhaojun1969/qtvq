# 发布到 GitHub

本地已完成 `git init` 与首次提交。**请勿**将 `.dev.vars`（含 `PAYMENT_ADMIN_KEY`）提交到仓库。

## 方式一：网页创建仓库后推送（推荐）

1. 登录 https://github.com/new  
2. **Repository name**：`qtvq`（或 `qtvq-cn`）  
3. 选 **Public**，**不要**勾选 “Add a README”（本地已有代码）  
4. 创建后，在本地执行（把 `你的用户名` 换成 GitHub 用户名）：

```powershell
cd d:\qtvq
git branch -M main
git remote add origin https://github.com/你的用户名/qtvq.git
git push -u origin main
```

首次 push 会提示登录 GitHub（浏览器或 Personal Access Token）。

## 方式二：GitHub CLI 一键创建并推送

安装 [GitHub CLI](https://cli.github.com/) 后：

```powershell
cd d:\qtvq
gh auth login
gh repo create qtvq --public --source=. --remote=origin --push
```

或运行项目脚本：

```powershell
npm run github:publish
```

## 方式三：Personal Access Token

1. GitHub → Settings → Developer settings → Personal access tokens → 生成 **repo** 权限  
2. 创建空仓库 `qtvq`  
3. 推送：

```powershell
git remote add origin https://github.com/你的用户名/qtvq.git
git push -u origin main
```

用户名填 GitHub 账号，密码处粘贴 **Token**（不是登录密码）。

## 与 Cloudflare Pages 联动（可选）

GitHub 仓库创建后，在 Cloudflare Dashboard：

**Workers & Pages** → **qtvq** → **Settings** → **Build** → **Connect to Git** → 选该仓库，构建目录 `/`，自动部署。

## 已忽略、不会上传的文件

见 `.gitignore`：`.dev.vars`、`.wrangler/`、`node_modules/` 等。
