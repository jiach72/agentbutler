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
# 供应链：下载后必须通过 sha256 校验（fail-closed）——Release 被替换时构建直接失败。
# 更新版本时同步更新 SKILLS_MANAGER_CLI_SHA256（来源：官方 Release 产物自行哈希后交叉核对）。
# 多架构（Apple Silicon / OrbStack 用 docker buildx 构建 linux/arm64）：
# 按 TARGETPLATFORM 映射产物名，与 apps/watch/src/skills-manager.ts 的
# SKILLS_MANAGER_DOWNLOAD_ARTIFACTS 五产物清单保持命名一致（v1.36.1 实测）。
ARG SKILLS_MANAGER_CLI_VERSION=v1.36.1
# x64 默认产物（现网 WSL 生产路径，ARG URL/SHA256 行为保持不变）。
ARG SKILLS_MANAGER_CLI_URL=https://github.com/xingkongliang/skills-manager/releases/download/${SKILLS_MANAGER_CLI_VERSION}/skills-manager-cli-Linux-x64
# v1.36.1 skills-manager-cli-Linux-x64 (25099216 bytes)
ARG SKILLS_MANAGER_CLI_SHA256=6c00468993aff8e8aafd56bbbbbe1f2ca5d7e61ff71b524f7c435d6c18e04bd8
# arm64 产物：上游 release 提供独立产物（命名同 skills-manager.ts L107-116），
# 但其 sha256 尚未实测核对——暂留空并在下方按「有 sha 必校验、无 sha 跳过」处理。
# TODO(供应链): 官方发布 arm64 产物后自行哈希并交叉核对，补上此 ARG 值恢复 fail-closed。
ARG SKILLS_MANAGER_CLI_ARM64_SHA256=
# 按 TARGETPLATFORM 选产物：arm64 构建改写下载 URL；linux/amd64（含默认构建）保持原 ARG。
# 运行时 skills-manager.ts 还有 --version 冒烟 + 平台产物自愈下载兜底。
RUN case "$TARGETPLATFORM" in \
      linux/arm64) \
        SKILLS_CLI_URL="https://github.com/xingkongliang/skills-manager/releases/download/${SKILLS_MANAGER_CLI_VERSION}/skills-manager-cli-Linux-arm64"; \
        SKILLS_CLI_SHA256="$SKILLS_MANAGER_CLI_ARM64_SHA256"; \
        ;; \
      *) \
        SKILLS_CLI_URL="$SKILLS_MANAGER_CLI_URL"; \
        SKILLS_CLI_SHA256="$SKILLS_MANAGER_CLI_SHA256"; \
        ;; \
    esac \
  && apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && curl -fsSL "$SKILLS_CLI_URL" -o /usr/local/bin/skills-manager-cli \
  && if [ -n "$SKILLS_CLI_SHA256" ]; then \
       echo "${SKILLS_CLI_SHA256}  /usr/local/bin/skills-manager-cli" | sha256sum -c -; \
     fi \
  && chmod +x /usr/local/bin/skills-manager-cli \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*
ENV SKILLS_MANAGER_CLI_VERSION=${SKILLS_MANAGER_CLI_VERSION}

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
