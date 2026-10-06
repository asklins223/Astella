# Build context must be the repo root (set by docker-compose).
# F-027: 锁定 node patch 版本，避免 latest 标签漂移
FROM node:22.11.0-alpine3.20 AS base
WORKDIR /app

# 国内 apk 镜像（清华 USTC）
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.ustc.edu.cn|g' /etc/apk/repositories

# F-027: 使用 npm ci + lockfile 确保可复现构建。
FROM base AS deps
COPY workers/ai-worker/package.json workers/ai-worker/package-lock.json workers/ai-worker/.npmrc ./
# Keep the local shared source out of npm's dependency tree; the dev/prod
# stages mount/copy it and expose it through the package link explicitly.
RUN node -e 'const fs=require("node:fs"); const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); for (const name of ["shared","agent-core","agent-host","card-generation","ai-quality"]) delete pkg.dependencies["@astella/"+name]; fs.writeFileSync("package.json", JSON.stringify(pkg)); const lock=JSON.parse(fs.readFileSync("package-lock.json","utf8")); for (const name of ["shared","agent-core","agent-host","card-generation","ai-quality"]) { delete lock.packages[""]?.dependencies?.["@astella/"+name]; delete lock.packages["node_modules/@astella/"+name]; delete lock.packages["../../packages/"+name]; } fs.writeFileSync("package-lock.json", JSON.stringify(lock));'
RUN npm config set registry https://registry.npmmirror.com \
 && npm ci --install-links --no-audit --no-fund

FROM base AS dev
ENV NODE_ENV=development \
    NODE_OPTIONS=--preserve-symlinks \
    PATH=/app/node_modules/.bin:$PATH
COPY --from=deps /app/node_modules /app/node_modules
COPY packages/shared /app/packages/shared
COPY packages/agent-core /app/packages/agent-core
COPY packages/agent-host /app/packages/agent-host
COPY packages/card-generation /app/packages/card-generation
COPY packages/ai-quality /app/packages/ai-quality
COPY workers/ai-worker/package.json ./package.json
COPY workers/ai-worker/tsconfig.json ./tsconfig.json
COPY workers/ai-worker/src ./src
# dev 保留源码热挂载路径；shared 包不携带 node_modules，并通过单一
# /app/node_modules 解析 worker 与 shared 共用的 drizzle-orm/zod 实例。
RUN rm -rf node_modules/@astella/shared \
 && mkdir -p node_modules/@astella \
 && ln -sf /app/packages/shared node_modules/@astella/shared \
 && ln -sf /app/packages/agent-core node_modules/@astella/agent-core \
 && ln -sf /app/packages/agent-host node_modules/@astella/agent-host \
 && ln -sf /app/packages/card-generation node_modules/@astella/card-generation \
 && ln -sf /app/packages/ai-quality node_modules/@astella/ai-quality
EXPOSE 9100
CMD ["npm", "run", "dev"]


FROM base AS prod
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules /app/node_modules
COPY workers/ai-worker/package.json /app/workers/ai-worker/package.json
COPY workers/ai-worker/tsconfig.json /app/workers/ai-worker/tsconfig.json
COPY workers/ai-worker/src /app/workers/ai-worker/src
COPY packages/shared /app/packages/shared
COPY packages/agent-core /app/packages/agent-core
COPY packages/agent-host /app/packages/agent-host
COPY packages/card-generation /app/packages/card-generation
COPY packages/ai-quality /app/packages/ai-quality
RUN mkdir -p /app/node_modules/@astella \
 && ln -s /app/packages/shared /app/node_modules/@astella/shared \
 && ln -sf /app/packages/agent-core /app/node_modules/@astella/agent-core \
 && ln -sf /app/packages/agent-host /app/node_modules/@astella/agent-host \
 && ln -sf /app/packages/card-generation /app/node_modules/@astella/card-generation \
 && ln -sf /app/packages/ai-quality /app/node_modules/@astella/ai-quality
RUN cd /app/workers/ai-worker && npm run build
WORKDIR /app/workers/ai-worker
# F-027: 以非 root 用户运行
RUN chown -R node:node /app
USER node
EXPOSE 9100
CMD ["node", "dist/index.cjs"]
