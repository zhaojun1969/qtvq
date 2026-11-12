# E.95 nginx 修复记录（已服务器端执行）

`location = /api/auth`（精确匹配，E.76 跨栈桥时期引入）排在 `location ^~ /api/auth` 之前，
nginx 精确匹配优先 → **主登录/注册端点一直未进限流区**（撞库可全速跑且不产生 429 供 fail2ban 计数）。

修复：`location = /api/auth {` 头部补 `limit_req zone=qtvq_auth burst=10 nodelay;`。
验证：40 并发同 IP → 出现 429（此前 0）。
