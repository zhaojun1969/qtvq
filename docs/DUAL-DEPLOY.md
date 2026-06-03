# 双域部署 · qtvq.cn + qtvq-api.pages.dev

## 架构

```
浏览器
  ├─ https://qtvq.cn          → 阿里云 Ubuntu / Nginx（静态）
  └─ JS 跨域请求
       https://qtvq-api.pages.dev/api/*  → Cloudflare（AI、额度、汇款）
```

| 文件 | 部署位置 |
|------|----------|
| index.html、css、js、assets | **qtvq.cn** |
| functions/api/*、Workers AI、KV | **qtvq-api** |

---

## 一、Cloudflare（API）

```bash
npm run deploy          # wrangler pages deploy . --project-name=qtvq-api
npm run post-deploy     # PAYMENT_ADMIN_KEY + 冒烟测试
```

Dashboard → **qtvq-api** → 确认：

- Workers AI 绑定 **`AI`**
- KV 绑定 **`QTVQ_KV`**
- Secret **`PAYMENT_ADMIN_KEY`**

自检：

```bash
curl -s https://qtvq-api.pages.dev/api/payment
curl -s "https://qtvq-api.pages.dev/api/quota?clientId=test"
```

---

## 二、阿里云 Ubuntu（静态）

### 首次

```bash
sudo apt update
sudo apt install -y git nginx certbot python3-certbot-nginx

sudo mkdir -p /opt/qtvq /var/www/qtvq
sudo chown -R $USER:$USER /opt/qtvq

cd /opt/qtvq
git clone https://github.com/zhaojun1969/qtvq.git .

bash tools/scripts/sync-static.sh
```

Nginx `/etc/nginx/sites-available/qtvq`：

```nginx
server {
    listen 80;
    server_name qtvq.cn www.qtvq.cn;
    root /var/www/qtvq;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }

    location /api/ {
        return 404;
    }
}
```

```bash
sudo ln -sf /etc/nginx/sites-available/qtvq /etc/nginx/sites-enabled/
sudo certbot --nginx -d qtvq.cn -d www.qtvq.cn
sudo nginx -t && sudo systemctl reload nginx
```

DNS（阿里云）：`@` 与 `www` → **A 记录** → 轻量机公网 IP。

### 日常更新

```bash
cd /opt/qtvq
git pull origin main
bash tools/scripts/sync-static.sh
```

---

## 三、上线自检清单

| 检查 | 期望 |
|------|------|
| `curl -I https://qtvq.cn/` | 200 |
| `curl -s https://qtvq.cn/js/config.js` | 含 `qtvq-api.pages.dev` |
| `curl -s https://qtvq.cn/js/app.js` | 含 `apiUrl` |
| 浏览器 F12 提问 | 请求 `qtvq-api.pages.dev/api/chat`，无 CORS 错误 |
| `https://qtvq-api.pages.dev/tools/verify-payment.html` | 工作人员核实页可用 |

---

## 四、常见问题

**首页能开，Q 问无响应**  
→ 静态未更新：缺少 `js/config.js` 或 `app.js` 仍用 `/api/`。执行 `git pull` + `sync-static.sh`。

**403 / 404 根目录**  
→ Nginx `root` 必须是 `/var/www/qtvq`，且 `index.html` 在该目录下（不要在 `/var/www/qtvq/qtvq/` 子目录）。

**CORS 报错**  
→ 重新 `npm run deploy` 部署带 CORS 的 Functions。

**qtvq.cn/api 404**  
→ 正常；API 只在 qtvq-api.pages.dev。

---

## 五、与设计文档对照

| 设计（我心永恒-Q问.txt） | 状态 |
|--------------------------|------|
| 首页 Q问 + 右侧热点榜 | ✅ |
| 避坑大全 / 我的缘值 | ✅ 静态页 |
| AI 问答 + 再问一步 | ✅ 经 qtvq-api |
| 24h 5 次额度 + 会员汇款 | ✅ KV + payment API |
| Logo 悬停动效 | ✅ |
| 语音输入 | ✅ 浏览器 API |
| 缘匹配 / Q缘 | ✅ profile 页 |
