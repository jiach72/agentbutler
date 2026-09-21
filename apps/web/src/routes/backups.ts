import type { FastifyInstance } from "fastify";
import type { SqliteStore } from "@butler/core";
import type { ProxyHelpers } from "../proxy-helpers.js";

export interface BackupsRouteOptions {
  proxy: ProxyHelpers;
  getStore: () => SqliteStore | null;
}

/**
 * 管家自身维护、备份、安全基线与追加审计日志代理路由插件（Task 18 / V1.7 / M7）
 */
export async function registerBackupsRoutes(
  app: FastifyInstance,
  options: BackupsRouteOptions,
): Promise<void> {
  const { proxy, getStore } = options;
  const { fetchWatch, proxyWatchPost } = proxy;

  app.get("/api/butler/version", async () => {
    const res = await fetchWatch("/api/butler/version");
    if (res === null || !res.ok) {
      return {
        reachable: false,
        version: null,
        source: null,
        branch: null,
        commit: null,
        tag: null,
        repository: null,
        repositoryConfigured: false,
        repositorySource: "configured-default",
        changelog: null,
        checkedAt: null,
      };
    }
    try {
      const body = (await res.json()) as Record<string, unknown>;
      return { reachable: true, ...body };
    } catch {
      return {
        reachable: false,
        version: null,
        source: null,
        branch: null,
        commit: null,
        tag: null,
        repository: null,
        repositoryConfigured: false,
        repositorySource: "configured-default",
        changelog: null,
        checkedAt: null,
      };
    }
  });

  // 管家自身版本管理（V1.7）：状态 / 一键升级 / 回滚 / 更新偏好（透传 watch）。
  app.get("/api/butler/self", async () => {
    const res = await fetchWatch("/api/butler/self", 30_000);
    if (res === null || !res.ok) {
      return {
        reachable: false,
        source: null,
        version: null,
        branch: null,
        commit: null,
        tag: null,
        repository: null,
        repoClean: true,
        remoteConfigured: false,
        prefs: { channel: "beta", locked: false },
        snapshots: [],
        availableUpdates: [],
        lastJob: null,
        checkedAt: null,
      };
    }
    try {
      const body = (await res.json()) as Record<string, unknown>;
      return { reachable: true, ...body };
    } catch {
      return {
        reachable: false,
        source: null,
        version: null,
        branch: null,
        commit: null,
        tag: null,
        repository: null,
        repoClean: true,
        remoteConfigured: false,
        prefs: { channel: "beta", locked: false },
        snapshots: [],
        availableUpdates: [],
        lastJob: null,
        checkedAt: null,
      };
    }
  });

  app.post("/api/butler/self/upgrade", async (request, reply) =>
    proxyWatchPost("/api/butler/self/upgrade", request.body, reply, 10 * 60_000),
  );

  app.post("/api/butler/self/rollback", async (request, reply) =>
    proxyWatchPost("/api/butler/self/rollback", request.body, reply),
  );

  app.post("/api/butler/self/prefs", async (request, reply) =>
    proxyWatchPost("/api/butler/self/prefs", request.body, reply),
  );

  // 备份时间线 + 状态（watch 不可达 → 降级空列表，不 5xx）。
  app.get("/api/backups", async () => {
    const res = await fetchWatch("/api/backups");
    if (res === null || !res.ok) {
      return { items: [], status: null, watchReachable: false };
    }
    try {
      const body = (await res.json()) as Record<string, unknown>;
      return { watchReachable: true, ...body };
    } catch {
      return { items: [], status: null, watchReachable: false };
    }
  });

  // 手动备份（立即备份）。
  app.post("/api/backups", async (request, reply) =>
    proxyWatchPost("/api/backups", request.body, reply),
  );

  // 还原备份（先做当前态快照；确认词由前端二次确认承载）。
  app.post("/api/backups/:id/restore", async (request, reply) =>
    proxyWatchPost(
      `/api/backups/${(request.params as Record<string, string>)["id"]}/restore`,
      request.body,
      reply,
    ),
  );

  // 备份可恢复性验证：Watch 在临时目录检查，不会回写 Hermes 实际数据。
  app.post("/api/backups/verify", async (request, reply) =>
    proxyWatchPost("/api/backups/verify", request.body, reply, 30_000),
  );

  // 安全基线：三条配置不变式 + 密钥文件权限扫描。
  app.get("/api/security", async () => {
    const res = await fetchWatch("/api/security");
    if (res === null || !res.ok) {
      return {
        watchReachable: false,
        checkedAt: null,
        invariants: [],
        secrets: [],
        totalSecretFiles: 0,
        insecureSecretFiles: 0,
        message: "管家服务暂时连不上，安全检查稍后再试。",
      };
    }
    try {
      const body = (await res.json()) as Record<string, unknown>;
      return { watchReachable: true, ...body };
    } catch {
      return {
        watchReachable: false,
        checkedAt: null,
        invariants: [],
        secrets: [],
        totalSecretFiles: 0,
        insecureSecretFiles: 0,
        message: "安全检查结果暂时读不到。",
      };
    }
  });

  // 追加式审计日志（只读，只增不改；直接读共享 SQLite）。
  app.get("/api/audit", async (request) => {
    const store = getStore();
    if (store === null) return { items: [], degraded: ["db:unreachable"] };
    const query = request.query as Record<string, unknown>;
    const limitRaw = typeof query["limit"] === "string" ? query["limit"] : "100";
    const limit = Math.min(Math.max(1, Number(limitRaw) || 100), 500);
    return { items: store.listAudit({ limit }) };
  });
}
