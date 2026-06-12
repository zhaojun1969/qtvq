# 小程序域名校验文件

微信 / 支付宝配置 **业务域名** 或 **服务器域名** 时，会提供校验文件，需能通过以下 URL 访问（放在站点根目录，不要放在子文件夹）：

```
https://qtvq.cn/MP_verify_xxxxxxxx.txt     （微信小程序常见）
https://qtvq.cn/pO8yu0YU22.txt             （小程序业务域名 / 开放平台业务域名）
https://qtvq.cn/EgTqXy3q41.txt
https://qtvq.cn/xxxxxxxx.html              （支付宝常见）
```

**说明**：小程序「业务域名」与开放平台「网站应用授权回调域」是两套配置。PC 扫码登录见 `docs/WECHAT-OPEN-LOGIN.md`（回调页 `wechat-callback.html`，授权回调域 `qtvq.cn`）。

## 操作步骤

1. 在微信 / 支付宝小程序后台下载校验文件  
2. 将文件 **复制到本目录** `verify/`（或项目根目录，文件名保持原样）  
3. 同步静态站：

```bash
# 本地打包
npm run package:static

# 服务器
cd /opt/qtvq && git pull origin main && bash tools/scripts/sync-static.sh
```

4. 浏览器验证：`https://qtvq.cn/你的校验文件名`

## 注意

- 文件名、内容必须与后台下载的 **完全一致**（不要改扩展名）  
- Nginx `root` 必须为 `/var/www/qtvq`，校验文件与 `index.html` 同级  
- 本目录文件会在 `sync-static.sh` / `package-static.ps1` 时 **复制到网站根目录**  
- 校验文件可提交 Git（不含密钥）；若含随机 token 也可仅放服务器不提交

## API 域（可选）

若需校验 `qtvq-api.pages.dev`，将同名文件放在项目根目录后执行：

```bash
npm run deploy:api-only
```

Cloudflare Pages 会从仓库根目录发布该文件。
