# ---------- 前端构建 ----------
FROM node:20-bookworm-slim AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY client/ ./
RUN npm run build

# ---------- 后端依赖（完整镜像自带编译工具，better-sqlite3 无预编译包时可源码构建） ----------
FROM node:20-bookworm AS server-deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# ---------- 运行时 ----------
FROM node:20-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/dnszone.db
WORKDIR /app
COPY --from=server-deps /app/server/node_modules server/node_modules
COPY server/ server/
COPY --from=client-build /app/client/dist client/dist
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8080
VOLUME ["/data"]
CMD ["node", "server/index.js"]
