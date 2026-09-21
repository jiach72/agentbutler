import type { FastifyInstance } from "fastify";
import type { SqliteStore } from "@butler/core";
import type { ProxyHelpers } from "../proxy-helpers.js";
import type { AvailableVersionsView, UpgradeJobView, VersionsApiView } from "../server.js";

export interface UpgradeRouteOptions {
  proxy: ProxyHelpers;
  getStore: () => SqliteStore | null;
}

/**
 * 升级与快照代理路由插件（Task 13.3）
 */
export async function registerUpgradeRoutes(
  app: FastifyInstance,
  options: UpgradeRouteOptions,
): Promise<void> {
  const { proxy, getStore } = options;
  const { fetchWatch, proxyWatchPost } = proxy;

  /** 代理 watch /api/upgrade/status；不可达/响应异常 → job:null。 */
  const upgradeStatusFromWatch = async (): Promise<{
    watchOk: boolean;
    job: UpgradeJobView | null;
  }> => {
    const res = await fetchWatch("/api/upgrade/status");
    if (res === null || !res.ok) return { watchOk: false, job: null };
    try {
      const body = (await res.json()) as Record<string, unknown>;
      const job = body["job"];
      return {
        watchOk: true,
        job: job !== null && typeof job === "object" ? (job as UpgradeJobView) : null,
      };
    } catch {
      return { watchOk: true, job: null };
    }
  };

  /** 代理 watch /api/upgrade/versions；不可达/响应异常 → reachable:false 空列表。 */
  const availableVersionsFromWatch = async (): Promise<{
    watchOk: boolean;
    view: AvailableVersionsView;
  }> => {
    const res = await fetchWatch("/api/upgrade/versions");
    if (res === null || !res.ok)
      return { watchOk: false, view: { reachable: false, versions: [] } };
    try {
      const body = (await res.json()) as Record<string, unknown>;
      const view: AvailableVersionsView = {
        reachable: body["reachable"] === true,
        versions: Array.isArray(body["versions"])
          ? (body["versions"] as AvailableVersionsView["versions"])
          : [],
      };
      if (typeof body["source"] === "string" && body["source"] !== "") view.source = body["source"];
      if (typeof body["checkedAt"] === "string") view.checkedAt = body["checkedAt"];
      if (Array.isArray(body["attempts"])) view.attempts = body["attempts"] as AvailableVersionsView["attempts"];
      return { watchOk: true, view };
    } catch {
      return { watchOk: true, view: { reachable: false, versions: [] } };
    }
  };

  // 版本页一次聚合：实例当前版本与快照历史直读共享 SQLite，升级 Job 与可用版本源代理
  // watch（两路并发）；db 不可达时 instances/snapshots 为空数组并附 degraded 标记。
  app.get("/api/versions", async () => {
    const store = getStore();
    const instances: VersionsApiView["instances"] =
      store === null
        ? []
        : store.listInstances().map((row) => ({
            instanceId: row.instanceId,
            state: row.state,
            runtime: row.runtime,
            version: row.version,
          }));
    const snapshots: VersionsApiView["snapshots"] =
      store === null
        ? []
        : store.listSnapshots().map((row) => ({
            id: row.id,
            instance: row.instance,
            label: row.label,
            createdAt: row.createdAt,
            status: row.status,
          }));
    const [status, versions] = await Promise.all([
      upgradeStatusFromWatch(),
      availableVersionsFromWatch(),
    ]);
    return {
      instances,
      upgradeJob: status.job,
      availableVersions: versions.view,
      snapshots,
      watchReachable: status.watchOk || versions.watchOk,
      ...(store === null ? { degraded: ["db:unreachable"] } : {}),
    };
  });

  // 发起升级包含升级前备份，可能超过普通控制请求的 5 秒；必须给备份和流水线
  // 足够时间完成登记，否则 Web 会误报“未执行”，而 watch 仍在后台继续升级。
  app.post("/api/upgrade/run", async (request, reply) =>
    proxyWatchPost("/api/upgrade/run", request.body, reply, 120_000),
  );
  app.post("/api/upgrade/compatibility", async (request, reply) =>
    proxyWatchPost("/api/upgrade/compatibility", request.body, reply),
  );

  // 快照回滚：:id 为 snapshots 表行 id；watch 的 200/404/503 原样透传，不可达 → 502。
  app.post("/api/snapshots/:id/rollback", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(`/api/snapshots/${id}/rollback`, request.body, reply);
  });
}
