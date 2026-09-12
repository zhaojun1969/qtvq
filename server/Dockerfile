FROM node:20-alpine

WORKDIR /app

# 先装依赖，利用镜像层缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY scripts ./scripts
COPY data ./data
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3000

# 说明：不使用 PM2/cluster。本服务是无状态 API，
# 横向扩容交给容器编排或上层 Nginx upstream，避免计划书里
# "PM2 cluster + 进程内在线表" 那类多进程状态不一致问题。
CMD ["node", "src/app.js"]
