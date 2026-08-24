FROM node:22-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app
COPY . .
RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm run build

FROM node:22-slim AS runtime

ENV NODE_ENV=production
ENV BUTLER_HOME=/home/butler
WORKDIR /app

COPY --from=build --chown=node:node /app /app
RUN mkdir -p /home/butler/data && chown -R node:node /home/butler

USER node
EXPOSE 7532
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7532/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/gateway/dist/main.js"]
