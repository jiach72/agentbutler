FROM node:22-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app
# 依赖清单先行复制：仅源码变更时命中缓存，跳过 pnpm install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contract/package.json packages/contract/
COPY packages/core/package.json packages/core/
COPY packages/installer/package.json packages/installer/
COPY packages/adapters/hermes/package.json packages/adapters/hermes/
COPY packages/adapters/openclaw/package.json packages/adapters/openclaw/
COPY apps/gateway/package.json apps/gateway/
COPY apps/watch/package.json apps/watch/
COPY apps/web/package.json apps/web/
COPY ui/package.json ui/
RUN corepack pnpm install --frozen-lockfile

COPY . .
RUN corepack pnpm exec tsc -b --force && corepack pnpm --filter @butler/ui exec vite build

# 生产依赖单独安装：清单层与 build 阶段相同，命中缓存后只执行一次精简安装
FROM node:22-slim AS deps-prod

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contract/package.json packages/contract/
COPY packages/core/package.json packages/core/
COPY packages/installer/package.json packages/installer/
COPY packages/adapters/hermes/package.json packages/adapters/hermes/
COPY packages/adapters/openclaw/package.json packages/adapters/openclaw/
COPY apps/gateway/package.json apps/gateway/
COPY apps/watch/package.json apps/watch/
COPY apps/web/package.json apps/web/
COPY ui/package.json ui/
RUN corepack pnpm install --frozen-lockfile --prod

FROM node:22-slim AS runtime

ENV NODE_ENV=production
ENV BUTLER_HOME=/home/butler
WORKDIR /app

# skills-manager CLI（中央技能库）：固定版本、构建参数可覆盖；ENV 供服务回报版本。
# glibc 动态链接二进制，node:22-slim（Debian）直接可跑；git 供 CLI 的 git 安装源使用，
# curl 仅下载期需要，装完即清除以保持镜像面最小。
ARG SKILLS_MANAGER_CLI_VERSION=v1.36.0
ARG SKILLS_MANAGER_CLI_URL=https://github.com/xingkongliang/skills-manager/releases/download/${SKILLS_MANAGER_CLI_VERSION}/skills-manager-cli-Linux-x64
ENV SKILLS_MANAGER_CLI_VERSION=${SKILLS_MANAGER_CLI_VERSION}
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && curl -fsSL "$SKILLS_MANAGER_CLI_URL" -o /usr/local/bin/skills-manager-cli \
  && chmod +x /usr/local/bin/skills-manager-cli \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

# 只带运行时产物：生产依赖树 + 各包编译输出；不含 devDependencies 与源码
COPY --from=deps-prod --chown=node:node /app /app
COPY --from=build --chown=node:node /app/packages/contract/dist ./packages/contract/dist
COPY --from=build --chown=node:node /app/packages/core/dist ./packages/core/dist
COPY --from=build --chown=node:node /app/packages/installer/dist ./packages/installer/dist
COPY --from=build --chown=node:node /app/packages/adapters/hermes/dist ./packages/adapters/hermes/dist
COPY --from=build --chown=node:node /app/packages/adapters/openclaw/dist ./packages/adapters/openclaw/dist
COPY --from=build --chown=node:node /app/packages/adapters/hermes/manifest.json ./packages/adapters/hermes/manifest.json
COPY --from=build --chown=node:node /app/packages/adapters/openclaw/manifest.json ./packages/adapters/openclaw/manifest.json
COPY --from=build --chown=node:node /app/apps/watch/dist ./apps/watch/dist
RUN mkdir -p /home/butler/data && chown -R node:node /home/butler

USER node
EXPOSE 7533
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7533/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/watch/dist/main.js"]
