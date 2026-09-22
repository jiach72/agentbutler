/**
 * butler-watch HTTP 控制通道：node:http 原生实现。
 * 已模块化重构为领域分流架构，具体处理函数分布在 handlers/ 目录下。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  RepairSessionService,
  type RepairActionExecution,
  type RepairDiagnosis,
  type RepairSessionDeps,
} from "./repair-session.js";
import {
  type RequestContext,
  type WatchHttp,
  type WatchHttpDeps,
  type WatchHttpOptions,
  diagnoseRecovery,
  internalErrorResponse,
  originAllowed,
  writeRequestAuthorized,
  recoveryActionCatalog,
  recoveryTracker,
  sendJson,
  skillsManagerErrorBody,
  skillsManagerErrorStatus,
} from "./http-common.js";
import { SkillsManagerError } from "./skills-manager.js";
import {
  handleTasks,
  handleSystem,
  handleRecovery,
  handleTrust,
  handleSkills,
  handleLogs,
  handleMemory,
  handlePrompt,
  handleLlm,
  handleGateway,
  handleEvolution,
  handleCredentials,
} from "./handlers/index.js";

export * from "./http-common.js";
export * from "./handlers/index.js";

const handlers: Array<(ctx: RequestContext) => Promise<boolean>> = [
  handleTasks,
  handleSystem,
  handleRecovery,
  handleTrust,
  handleSkills,
  handleLogs,
  handleMemory,
  handlePrompt,
  handleLlm,
  handleGateway,
  handleEvolution,
  handleCredentials,
];

/** 将现有恢复目录包装成后台修复会话执行器。动作仍复用同一套门禁、快照和复验。 */
export function createRepairSessionService(deps: WatchHttpDeps): RepairSessionService {
  const execute = async (actionId: string, instanceId?: string): Promise<RepairActionExecution> => {
    const action = recoveryActionCatalog(deps, instanceId).find((item) => item.id === actionId);
    if (action === undefined || !action.available) {
      return { ok: false, detail: action?.unavailableReason ?? "修复动作不可用", changes: [] };
    }
    if (actionId === "refresh-probe") {
      return deps.scheduler.runNow()
        ? { ok: true, detail: "已触发重新巡检", changes: [] }
        : { ok: false, detail: "巡检已在执行中", changes: [] };
    }
    if (actionId === "rebuild-memory-index") {
      if (deps.skills === undefined || deps.m6WritesEnabled !== true) {
        return { ok: false, detail: "记忆写操作未启用", changes: [] };
      }
      const result = await deps.skills.rebuildIndex(instanceId === undefined ? {} : { instanceId });
      return result.ok
        ? { ok: true, detail: "记忆索引重建完成", changes: ["重建记忆索引"] }
        : { ok: false, detail: result.error ?? "重建索引失败", changes: [] };
    }
    if (actionId === "reconnect-channel") {
      if (deps.connections === undefined) {
        return { ok: false, detail: "连接管理服务未接线", changes: [] };
      }
      const result = await deps.connections.connect(instanceId);
      if (result.status === "failed" || result.status === "no-instance") {
        return { ok: false, detail: "消息通道重连失败", changes: [] };
      }
      return { ok: true, detail: "消息通道状态已更新", changes: ["重新连接消息通道"] };
    }
    if (actionId === "apply-throttle-patch") {
      if (deps.gateway === undefined) {
        return { ok: false, detail: "网关补丁服务未接线", changes: [] };
      }
      const stats = await deps.gateway.stats();
      const suggestion = stats.suggestions[0];
      if (!suggestion) {
        return { ok: true, detail: "当前没有需要调整的节流参数", changes: [] };
      }
      const patchView = (await deps.gateway.patches()).find((patch) => patch.id === suggestion.patchId);
      if (patchView?.observed !== null && patchView?.observed !== undefined && patchView.applied === null) {
        return { ok: false, detail: "检测到未纳管的手工补丁，已停止自动覆盖", changes: [] };
      }
      const applied = await deps.gateway.applyPatch({
        patchId: suggestion.patchId,
        params: { [suggestion.param]: suggestion.suggested },
        instanceId,
      });
      return applied.status === "ok"
        ? { ok: true, detail: "网关节流补丁已应用", changes: [`应用网关补丁 ${suggestion.patchId}`] }
        : { ok: false, detail: "代码补丁应用失败", changes: [] };
    }
    const runbookId =
      actionId === "cleanup-gateway"
        ? "rb-cleanup-gateway"
        : actionId === "restart-instance"
          ? "rb-restart"
          : null;
    if (runbookId === null) {
      return { ok: false, detail: "未知的受限修复动作", changes: [] };
    }
    const beforeRunAt = deps.runbooks().find((item) => item.id === runbookId)?.lastRun?.at ?? null;
    const job = recoveryTracker.start(actionId, action.label, action.estimatedSeconds, instanceId, true);
    const outcome = await deps.executeRunbook(runbookId, instanceId);
    if (outcome.status !== "started") {
      recoveryTracker.finish(
        job.jobId,
        "failed",
        outcome.status === "circuit-breaker-tripped"
          ? "保护机制暂时阻止了执行"
          : "没有可用的 Hermes 实例",
      );
      return { ok: false, detail: "Runbook 未启动", changes: [] };
    }
    recoveryTracker.monitorRunbook(job.jobId, () => deps.runbooks(), runbookId, beforeRunAt);
    return { ok: true, detail: `已启动${action.label}`, changes: [action.label], jobId: job.jobId };
  };

  const sessionDeps: RepairSessionDeps = {
    diagnose: (instanceId) => diagnoseRecovery(deps, instanceId) as Promise<RepairDiagnosis>,
    actions: (instanceId) => recoveryActionCatalog(deps, instanceId),
    execute,
    getJob: (jobId) => {
      const job = recoveryTracker.get(jobId);
      return job === undefined ? undefined : { jobId: job.jobId, status: job.status, detail: job.detail };
    },
    audit: deps.audit,
  };
  return new RepairSessionService(sessionDeps);
}

/** 组装并启动 HTTP 控制通道。 */
export function startWatchHttp(deps: WatchHttpDeps, options: WatchHttpOptions = {}): WatchHttp {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 7533;
  const loopbackHost = host === "127.0.0.1" || host === "localhost" || host === "::1";
  const credentialWritesAllowed = options.credentialWritesAllowed ?? loopbackHost;

  const server: Server = createServer((req, res) => {
    void handle(deps, req, res, { credentialWritesAllowed });
  });
  // 长连接（keep-alive）不阻碍关闭：close() 时统一断开。
  server.keepAliveTimeout = 5_000;

  let listening: { host: string; port: number } | null = null;
  let startPromise: Promise<{ host: string; port: number }> | undefined;

  const http: WatchHttp = {
    start(): Promise<{ host: string; port: number }> {
      if (startPromise !== undefined) return startPromise;
      startPromise = new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(requestedPort, host, () => {
          const addr = server.address();
          listening =
            addr !== null && typeof addr === "object"
              ? { host: addr.address, port: addr.port }
              : { host, port: requestedPort };
          resolve(listening);
        });
      });
      return startPromise;
    },
    close(): void {
      if (!server.listening) return;
      server.close();
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      listening = null;
    },
    address(): { host: string; port: number } | null {
      return listening;
    },
  };
  return http;
}

/** 路由分发。 */
export async function handle(
  deps: WatchHttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  options: { credentialWritesAllowed: boolean } = { credentialWritesAllowed: true },
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://butler-watch.local");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";

  if (!originAllowed(req)) {
    sendJson(res, 403, {
      error: "origin-not-allowed",
      detail: "这个请求来自不受信任的页面，管家已拒绝执行。",
    });
    return;
  }

  // 写操作无 Origin 时必须带口令（plan0922 fail-closed）。
  if (!writeRequestAuthorized(req)) {
    sendJson(res, 401, {
      error: "unauthorized",
      detail: "写操作需要访问口令（Authorization: Bearer 或 x-butler-token）。",
    });
    return;
  }

  const ctx: RequestContext = {
    deps,
    req,
    res,
    url,
    path,
    method,
    credentialWritesAllowed: options.credentialWritesAllowed,
  };

  try {
    for (const handler of handlers) {
      if (await handler(ctx)) return;
    }
    sendJson(res, 404, { error: "not-found" });
  } catch (error) {
    if (error instanceof SkillsManagerError) {
      sendJson(res, skillsManagerErrorStatus(error.code), skillsManagerErrorBody(error));
      return;
    }
    sendJson(res, 500, internalErrorResponse(error));
  }
}
