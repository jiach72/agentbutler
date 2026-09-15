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
# 更新版本时必须同步更新 x64 与 arm64 两个 sha256（来源：官方 Release 产物自行哈希后交叉核对）；
# 少填任何一个都会让构建直接失败——这是有意的 fail-closed，不要改成「没 sha 就跳过」。
# 多架构（Apple Silicon / OrbStack 用 docker buildx 构建 linux/arm64）：
# 按 TARGETPLATFORM 映射产物名，与 apps/watch/src/skills-manager.ts 的
# SKILLS_MANAGER_DOWNLOAD_ARTIFACTS 五产物清单保持命名一致（v1.36.1 实测）。
ARG SKILLS_MANAGER_CLI_VERSION=v1.36.1
# x64 默认产物（现网 WSL 生产路径，ARG URL/SHA256 行为保持不变）。
ARG SKILLS_MANAGER_CLI_URL=https://github.com/xingkongliang/skills-manager/releases/download/${SKILLS_MANAGER_CLI_VERSION}/skills-manager-cli-Linux-x64
# v1.36.1 skills-manager-cli-Linux-x64 (25099216 bytes)
ARG SKILLS_MANAGER_CLI_SHA256=6c00468993aff8e8aafd56bbbbbe1f2ca5d7e61ff71b524f7c435d6c18e04bd8
# arm64 产物：与 x64 **同一 release tag v1.36.1**（不引入新的信任来源），命名同
# skills-manager.ts L107-116。sha256 为该 release 资产实测值（22492720 bytes）：
#   curl -fsSL <下方 arm64 URL> | sha256sum
# 复核方式：GitHub Release API 的资产 size 与实测字节数一致；同一哈希经 node
# crypto / sha256sum / certutil 三套工具与两次独立下载交叉验证。
ARG SKILLS_MANAGER_CLI_ARM64_SHA256=4f229d931a2e2d4a3ceed3aa13c2f27e5e21cc9385cd4c7d947acb5466476d9a
# 按 TARGETPLATFORM 选产物：arm64 构建改写下载 URL；linux/amd64（含默认构建）保持原 ARG。
# 运行时 skills-manager.ts 还有 --version 冒烟 + 平台产物自愈下载兜底。
# arm64 分支同时收 `linux/arm64/v8` 这类带 variant 的写法（部分 buildkit/旧
# builder 会把 variant 拼进 TARGETPLATFORM）：漏掉它会让 Apple Silicon 构建静默
# 装成 x64 二进制（x64 的 sha 校验照样通过，靠运行时冒烟才自愈）。
RUN case "$TARGETPLATFORM" in \
      linux/arm64|linux/arm64/*) \
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
  && if [ -z "$SKILLS_CLI_SHA256" ]; then \
       echo "ERROR: ${TARGETPLATFORM:-unknown} 缺少 skills-manager CLI 的 sha256，拒绝跳过校验（fail-closed）；改版本时必须同步改哈希。" >&2; \
       exit 1; \
     fi \
  && echo "${SKILLS_CLI_SHA256}  /usr/local/bin/skills-manager-cli" | sha256sum -c - \
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
