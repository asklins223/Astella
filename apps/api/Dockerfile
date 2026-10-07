# Build context must be the repo root (set by docker-compose).
# Real paths are prefixed with `apps/api/` and `packages/shared/`.
# F-027: 锁定 node patch 版本，避免 latest 标签漂移
FROM node:22.11.0-alpine3.20 AS base
WORKDIR /app

# 国内 apk 镜像（清华 USTC），加速 alpine 包安装
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.ustc.edu.cn|g' /etc/apk/repositories

# P3 前置（Owner 2026-08-11 批准）：Alpine ffmpeg/ffprobe 用于音频时长探测/转码。
# 供应链影响：apk 包来自 Alpine 官方仓库（经 USTC 镜像），ffmpeg 为 LGPL/GPL 组合许可；
# 体积影响见 phase-report（记录于 P2 收尾）。
RUN apk add --no-cache ffmpeg

# F-027: 使用 npm ci + lockfile 确保可复现构建
FROM base AS deps
COPY apps/api/package.json apps/api/package-lock.json ./
# The shared workspace is linked explicitly after dependency installation;
# omit the repository-external local link here so npm ci remains deterministic
# inside the container as well as on the host.
RUN node -e 'const fs=require("node:fs"); const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); for (const name of ["shared","agent-core","agent-host","card-generation"]) delete pkg.dependencies["@astella/"+name]; fs.writeFileSync("package.json", JSON.stringify(pkg)); const lock=JSON.parse(fs.readFileSync("package-lock.json","utf8")); for (const name of ["shared","agent-core","agent-host","card-generation"]) { delete lock.packages[""]?.dependencies?.["@astella/"+name]; delete lock.packages["node_modules/@astella/"+name]; delete lock.packages["../../packages/"+name]; } fs.writeFileSync("package-lock.json", JSON.stringify(lock));'
RUN npm config set registry https://registry.npmmirror.com \
 && npm ci --install-links --no-audit --no-fund

FROM base AS shared-deps
COPY packages/shared/package.json packages/shared/package-lock.json ./
RUN npm config set registry https://registry.npmmirror.com \
 && npm ci --no-audit --no-fund \
 && rm -rf node_modules/zod node_modules/drizzle-orm

FROM base AS dev
ENV NODE_ENV=development \
    NODE_OPTIONS=--preserve-symlinks \
    PATH=/app/node_modules/.bin:$PATH
COPY --from=deps /app/node_modules /app/node_modules
COPY packages/shared /app/packages/shared
COPY --from=shared-deps /app/node_modules /app/packages/shared/node_modules
COPY packages/agent-core /app/packages/agent-core
COPY packages/agent-host /app/packages/agent-host
COPY packages/card-generation /app/packages/card-generation
COPY apps/api/package.json ./package.json
COPY apps/api/tsconfig.json ./tsconfig.json
COPY apps/api/drizzle.config.ts ./drizzle.config.ts
COPY apps/api/src ./src
RUN mkdir -p node_modules/@astella \
 && rm -rf node_modules/@astella/shared \
 && ln -s /app/packages/shared node_modules/@astella/shared \
 && ln -sf /app/packages/agent-core node_modules/@astella/agent-core \
 && ln -sf /app/packages/agent-host node_modules/@astella/agent-host \
 && ln -sf /app/packages/card-generation node_modules/@astella/card-generation
EXPOSE 4000
CMD ["npm", "run", "dev"]

# F-027: 生产镜像 — 非 root 用户运行
FROM base AS prod
ENV NODE_ENV=production
COPY --from=deps /app/node_modules /app/node_modules
COPY packages/shared /app/packages/shared
COPY --from=shared-deps /app/node_modules /app/packages/shared/node_modules
COPY packages/agent-core /app/packages/agent-core
COPY packages/agent-host /app/packages/agent-host
COPY packages/card-generation /app/packages/card-generation
COPY apps/api/package.json ./package.json
COPY apps/api/tsconfig.json ./tsconfig.json
COPY apps/api/tsconfig.prod.json ./tsconfig.prod.json
COPY apps/api/scripts/copy-admin-assets.mjs ./scripts/copy-admin-assets.mjs
# 2026-09-29（P1-21）：下面 RUN 里的门禁改用 tsconfig.prod.json（只 include 生产源码）。
# 此前用 tsconfig.json，include 是 `src/**/*.ts` 含测试——一个测试文件的类型错误
# 会打挂生产镜像构建，而测试代码既不发布、也不进 dist/server.cjs（esbuild 只从
# src/server.ts 打包）。写成 `npm run typecheck -- -p …` 而不是新增一条 script：
# 复用同一条命令、只换判据，脚本参数将来若变这里自动跟随，不漂移。
COPY apps/api/drizzle.config.ts ./drizzle.config.ts
COPY apps/api/src ./src
RUN mkdir -p node_modules/@astella \
 && rm -rf node_modules/@astella/shared \
 && ln -s /app/packages/shared node_modules/@astella/shared \
 && ln -sf /app/packages/agent-core node_modules/@astella/agent-core \
 && ln -sf /app/packages/agent-host node_modules/@astella/agent-host \
 && ln -sf /app/packages/card-generation node_modules/@astella/card-generation \
 && npm run typecheck -- -p tsconfig.prod.json \
 && npm run build
# F-027: 以非 root 用户运行
RUN chown -R node:node /app
USER node
EXPOSE 4000
CMD ["node", "dist/server.cjs"]
