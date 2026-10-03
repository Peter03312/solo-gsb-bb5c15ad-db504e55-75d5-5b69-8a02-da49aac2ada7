# ---- 构建阶段：编译 React 前端 ----
FROM node:20-bookworm-slim AS client-build
WORKDIR /app/client
COPY client/package.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# ---- 运行阶段：安装后端依赖（含 better-sqlite3 本地编译）----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# better-sqlite3 优先下载预编译包；无网络时用 python3/make/g++ 本地编译，装完即清理
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY server/ ./server/
COPY --from=client-build /app/client/dist ./client/dist

# 镜像体积与攻击面：保留 ca-certificates 以备时间同步/代理，移除编译链
RUN apt-get update \
  && apt-get purge -y --no-install-recommends python3 make g++ \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8080

# 容器启动即自动建表/初始化数据库与账号（server/db.js 幂等执行）
CMD ["node", "server/index.js"]
