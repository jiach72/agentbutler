FROM docker:29.7.2-cli AS docker-cli

FROM node:22-slim AS build

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
COPY apps/updater/package.json apps/updater/
COPY ui/package.json ui/
RUN corepack pnpm install --frozen-lockfile
COPY . .
RUN corepack pnpm exec tsc -b apps/updater/tsconfig.json --force

FROM node:22-slim
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
WORKDIR /app
COPY --from=build /app/apps/updater/dist ./apps/updater/dist
COPY --from=build /app/apps/updater/package.json ./apps/updater/package.json
RUN mkdir -p /home/butler && chown -R node:node /app /home/butler
USER node
EXPOSE 7540
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:7540/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/updater/dist/main.js"]
