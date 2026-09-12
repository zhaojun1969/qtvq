#!/usr/bin/env bash
# QTVQ 路线B 服务 · Ubuntu 环境自检与引导
#
# 默认**只做检测**，不改动系统。加 --install 才会安装 Node 20 与 MongoDB 7。
#
# 用法（在服务器上、仓库克隆目录内）：
#   cd /opt/qtvq/server
#   bash scripts/bootstrap-ubuntu.sh              # 只看环境，不动系统
#   sudo bash scripts/bootstrap-ubuntu.sh --install   # 需要时再装
#   sudo bash scripts/bootstrap-ubuntu.sh --install --systemd  # 顺带装开机自启
#
# 注意：本脚本可用于生产机，但安装动作是显式的；不带 --install 时它不会写任何系统文件。

set -uo pipefail

DO_INSTALL=0
DO_SYSTEMD=0
for arg in "$@"; do
  case "$arg" in
    --install) DO_INSTALL=1 ;;
    --systemd) DO_SYSTEMD=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="qtvq-report"
NODE_MAJOR=20

c_ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
c_bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
c_warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
head1()  { printf '\n\033[36m== %s ==\033[0m\n' "$1"; }

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "需要 root：请用 sudo 重新运行" >&2
    exit 1
  fi
}

detect_os() {
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    echo "${ID:-unknown} ${VERSION_ID:-} ${VERSION_CODENAME:-}"
  else
    echo "unknown"
  fi
}

head1 "系统"
echo "  主机: $(hostname)"
echo "  OS  : $(detect_os)"
echo "  目录: $SERVER_DIR"

# ---------- 检测 ----------
MISSING=()

head1 "运行时检测"

if command -v node >/dev/null 2>&1; then
  NODE_V="$(node -v)"
  NODE_CUR="${NODE_V#v}"; NODE_CUR="${NODE_CUR%%.*}"
  if [ "$NODE_CUR" -ge "$NODE_MAJOR" ]; then
    c_ok "node $NODE_V"
  else
    c_bad "node $NODE_V（需要 >= ${NODE_MAJOR}）"; MISSING+=("node")
  fi
else
  c_bad "node 未安装"; MISSING+=("node")
fi

command -v npm >/dev/null 2>&1 && c_ok "npm $(npm -v)" || { c_bad "npm 未安装"; MISSING+=("npm"); }

if command -v mongod >/dev/null 2>&1; then
  c_ok "mongod $(mongod --version | head -1 | awk '{print $3}')"
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  c_ok "docker $(docker --version | awk '{print $3}' | tr -d ,)（可用容器跑 mongo）"
  MISSING+=("mongo-via-docker")
else
  c_bad "mongod 与 docker 都不可用"; MISSING+=("mongo")
fi

command -v nginx >/dev/null 2>&1 && c_ok "nginx $(nginx -v 2>&1 | awk -F/ '{print $2}')" || c_warn "nginx 未安装（反代时才需要）"
command -v git   >/dev/null 2>&1 && c_ok "git $(git --version | awk '{print $3}')"   || c_warn "git 未安装"

head1 "配置检测"
if [ -f "$SERVER_DIR/.env" ]; then
  c_ok ".env 已存在"
  if grep -qE '^DASHSCOPE_API_KEY=.+' "$SERVER_DIR/.env"; then
    c_ok "DASHSCOPE_API_KEY 已填写"
  else
    c_warn "DASHSCOPE_API_KEY 为空 —— 报告会降级为确定性文案（不报错，但 AI 正文不可用）"
  fi
  if grep -qE '^JWT_SECRET=.+' "$SERVER_DIR/.env"; then
    c_ok "JWT_SECRET 已填写"
  else
    c_warn "JWT_SECRET 为空 —— 只能靠回源校验（现有账号）登录，无法签发本地 token"
  fi
  MONGO_URI_LINE="$(grep -E '^MONGO_URI=' "$SERVER_DIR/.env" | head -1 || true)"
  [ -n "$MONGO_URI_LINE" ] && c_ok "MONGO_URI 已配置" || c_warn "MONGO_URI 未配置"
else
  c_warn ".env 不存在（稍后会从 .env.example 复制）"
fi

head1 "代码检测"
[ -f "$SERVER_DIR/src/app.js" ] && c_ok "src/app.js 存在" || c_bad "src/app.js 缺失 —— 当前目录不是 server/"
[ -f "$SERVER_DIR/../js/data.js" ] && c_ok "避坑语料 ../js/data.js 存在（import:pitfalls 依赖它）" \
  || c_bad "../js/data.js 缺失 —— server/ 必须放在仓库克隆内，而不是单独拷出来"

if [ "${#MISSING[@]}" -eq 0 ]; then
  echo
  echo "环境齐备。继续："
else
  echo
  echo "缺失：${MISSING[*]}"
fi

# ---------- 安装 ----------
if [ "$DO_INSTALL" -eq 1 ]; then
  need_root
  head1 "安装（--install）"

  if [[ " ${MISSING[*]:-} " == *" node "* ]]; then
    echo ">> 安装 Node ${NODE_MAJOR}（NodeSource）"
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq
    apt-get install -y -qq nodejs || { c_bad "Node 安装失败，请检查网络/源"; exit 1; }
    c_ok "node $(node -v)"
  else
    c_ok "node 已就绪，跳过"
  fi

  if [[ " ${MISSING[*]:-} " == *" mongo "* ]]; then
    # MongoDB 官方 apt 源按 Ubuntu 代号发布，且 7.0 **没有** noble(24.04) 的包。
    # 写死版本号会在 24.04 上直接安装失败，所以这里按代号选版本。
    CODENAME="$(. /etc/os-release && echo "${VERSION_CODENAME}")"
    case "$CODENAME" in
      focal|jammy)        MONGO_VER="7.0" ;;
      noble|oracular)     MONGO_VER="8.0" ;;
      bookworm|bullseye)  MONGO_VER="7.0" ;;
      *)                  MONGO_VER="8.0" ;;
    esac
    echo ">> 安装 MongoDB ${MONGO_VER}（检测到代号 ${CODENAME}）"
    curl -fsSL "https://pgp.mongodb.com/server-${MONGO_VER}.asc" \
      | gpg --dearmor -o "/usr/share/keyrings/mongodb-server-${MONGO_VER}.gpg" \
      || { c_bad "下载 MongoDB GPG key 失败（网络不通？）"; exit 1; }
    echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-${MONGO_VER}.gpg ] https://repo.mongodb.org/apt/ubuntu ${CODENAME}/mongodb-org/${MONGO_VER} multiverse" \
      > "/etc/apt/sources.list.d/mongodb-org-${MONGO_VER}.list"
    apt-get update -qq
    if ! apt-get install -y -qq mongodb-org; then
      c_bad "MongoDB ${MONGO_VER} 安装失败"
      echo "     若该发行版没有对应包，两条退路："
      echo "       a) 手动指定版本：MONGODB_VERSION=8.0 重跑，或改 apt 源代号"
      echo "       b) 用容器：docker run -d --name qtvq-mongo -p 127.0.0.1:27017:27017 mongo:7"
      exit 1
    fi
    systemctl enable --now mongod || { c_bad "mongod 启动失败"; exit 1; }
    c_ok "mongod 已启动：$(systemctl is-active mongod)（版本 ${MONGO_VER}）"
    echo "  （MongoDB 默认只监听 127.0.0.1:27017，无需额外加固；如需远程访问请自行配置鉴权与防火墙）"
  else
    c_ok "MongoDB 已就绪或以 docker 方式提供，跳过"
  fi
fi

# ---------- .env ----------
if [ ! -f "$SERVER_DIR/.env" ] && [ -f "$SERVER_DIR/.env.example" ]; then
  head1 "生成 .env"
  cp "$SERVER_DIR/.env.example" "$SERVER_DIR/.env"
  # 为本地签发 token 生成一个随机密钥
  if command -v openssl >/dev/null 2>&1; then
    SECRET="$(openssl rand -hex 32)"
    sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${SECRET}|" "$SERVER_DIR/.env"
    c_ok "已生成随机 JWT_SECRET"
  fi
  c_warn "请编辑 $SERVER_DIR/.env 填写 DASHSCOPE_API_KEY："
  echo "     vi $SERVER_DIR/.env"
fi

# ---------- 依赖 ----------
if command -v npm >/dev/null 2>&1; then
  head1 "安装 npm 依赖"
  ( cd "$SERVER_DIR" && npm install --omit=dev --no-audit --no-fund ) && c_ok "依赖安装完成"
  head1 "静态自检"
  ( cd "$SERVER_DIR" && node scripts/check-imports.mjs ) || c_warn "自检未通过，请检查上面的输出"
fi

# ---------- systemd ----------
if [ "$DO_SYSTEMD" -eq 1 ]; then
  need_root
  head1 "安装 systemd 服务（$SERVICE_NAME）"
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=QTVQ 路线B 配对报告服务
After=network.target mongod.service
Wants=mongod.service

[Service]
Type=simple
WorkingDirectory=${SERVER_DIR}
EnvironmentFile=${SERVER_DIR}/.env
ExecStart=$(command -v node) src/app.js
Restart=always
RestartSec=5
# 安全加固：服务只需要读代码与访问网络
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now "$SERVICE_NAME"
  sleep 2
  systemctl --no-pager --lines=8 status "$SERVICE_NAME" || true
  c_ok "已启动。查看日志：journalctl -u ${SERVICE_NAME} -f"
fi

# ---------- 下一步 ----------
cat <<NEXT

------------------------------------------------------------
下一步
------------------------------------------------------------
1) 填模型密钥（不填也能跑，只是报告走确定性兜底文案）：
     vi ${SERVER_DIR}/.env        # DASHSCOPE_API_KEY=...

2) 导入避坑语料 + 生成向量（必须在仓库目录内执行）：
     cd ${SERVER_DIR} && npm run import:pitfalls

3) 启动：
     npm run dev                       # 前台调试
     # 或（推荐）
     bash scripts/bootstrap-ubuntu.sh --install --systemd
     journalctl -u ${SERVICE_NAME} -f

4) 自检：
     curl -s localhost:3000/v1/health | head -c 400

5) 对外暴露（可选，接 Nginx 反代，不要直接把 3000 端口开到公网）：
     location /v1/ { proxy_pass http://127.0.0.1:3000; proxy_set_header Host \$host; }
NEXT
