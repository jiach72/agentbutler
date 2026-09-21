import {
  type RequestContext,
  diagnoseRecovery,
  readJsonBody,
  recoveryActionCatalog,
  recoveryTracker,
  sendJson,
} from "../http-common.js";

export async function handleRecovery(ctx: RequestContext): Promise<boolean> {
  const { deps, req, res, url, path, method } = ctx;

  if (path === "/api/runbooks") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    sendJson(res, 200, { runbooks: deps.runbooks() });
    return true;
  }

  const executeMatch = /^\/api\/runbooks\/([^/]+)\/execute$/.exec(path);
  if (executeMatch !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const id = decodeURIComponent(executeMatch[1]!);
    if (body["confirmed"] !== true) {
      sendJson(res, 400, {
        error: "confirmation-required",
        detail: "执行修复动作前需要用户确认，请带上 confirmed: true 重试。",
      });
      return true;
    }
    const instanceId =
      typeof body["instanceId"] === "string" && body["instanceId"] !== ""
        ? body["instanceId"]
        : undefined;
    const outcome = await deps.executeRunbook(id, instanceId);
    if (outcome.status === "started") {
      sendJson(res, 202, { started: true });
      return true;
    }
    if (outcome.status === "unknown-runbook") {
      sendJson(res, 404, { error: `unknown-runbook: ${id}` });
      return true;
    }
    if (outcome.status === "circuit-breaker-tripped") {
      sendJson(res, 409, { error: "circuit-breaker-tripped" });
      return true;
    }
    sendJson(res, 503, { error: "no-servicing-instance" });
    return true;
  }

  const resetMatch = /^\/api\/runbooks\/([^/]+)\/reset$/.exec(path);
  if (resetMatch !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const id = decodeURIComponent(resetMatch[1]!);
    const instanceId =
      typeof body["instanceId"] === "string" && body["instanceId"] !== ""
        ? body["instanceId"]
        : undefined;
    if (deps.resetRunbookBreaker === undefined) {
      sendJson(res, 503, { error: "breaker-reset-unavailable" });
      return true;
    }
    const outcome = await deps.resetRunbookBreaker(id, instanceId);
    if (outcome.status === "reset") {
      sendJson(res, 200, outcome);
      return true;
    }
    if (outcome.status === "unknown-runbook") {
      sendJson(res, 404, { error: `unknown-runbook: ${id}` });
      return true;
    }
    sendJson(res, 409, { error: "circuit-breaker-not-tripped" });
    return true;
  }

  if (path === "/api/inspect/run") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const started = deps.scheduler.runNow();
    sendJson(
      res,
      started ? 202 : 409,
      started ? { started: true } : { error: "inspection-in-flight" },
    );
    return true;
  }

  if (path === "/api/inspect/status") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    sendJson(res, 200, deps.scheduler.status());
    return true;
  }

  if (path === "/api/host/metrics") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.hostMetrics === undefined) {
      sendJson(res, 503, { error: "host-metrics-unavailable" });
      return true;
    }
    sendJson(res, 200, await deps.hostMetrics.snapshot());
    return true;
  }

  if (path === "/api/recovery/diagnose") {
    if (method !== "POST" && method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (method === "POST") {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const instanceId =
        typeof body["instanceId"] === "string" && body["instanceId"].trim() !== ""
          ? body["instanceId"].trim()
          : undefined;
      sendJson(res, 200, await diagnoseRecovery(deps, instanceId));
      return true;
    }
    const queryInstance = url.searchParams.get("instanceId");
    const instanceId = queryInstance !== null && queryInstance.trim() !== "" ? queryInstance.trim() : undefined;
    sendJson(res, 200, await diagnoseRecovery(deps, instanceId));
    return true;
  }

  if (path === "/api/recovery/sessions") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.repairSessions === undefined) {
      sendJson(res, 503, { error: "repair-sessions-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const instanceId =
      typeof body["instanceId"] === "string" && body["instanceId"].trim() !== ""
        ? body["instanceId"].trim()
        : undefined;
    sendJson(res, 202, deps.repairSessions.start(instanceId));
    return true;
  }

  const repairSessionMatch = /^\/api\/recovery\/sessions\/([^/]+)$/.exec(path);
  if (repairSessionMatch !== null) {
    if (deps.repairSessions === undefined) {
      sendJson(res, 503, { error: "repair-sessions-unavailable" });
      return true;
    }
    const sessionId = decodeURIComponent(repairSessionMatch[1]!);
    if (method === "GET") {
      const session = deps.repairSessions.get(sessionId);
      if (session === undefined) {
        sendJson(res, 404, { error: "repair-session-not-found" });
      } else {
        sendJson(res, 200, session);
      }
      return true;
    }
    sendJson(res, 405, { error: "method-not-allowed" });
    return true;
  }

  const repairApprovalMatch = /^\/api\/recovery\/sessions\/([^/]+)\/approve$/.exec(path);
  if (repairApprovalMatch !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.repairSessions === undefined) {
      sendJson(res, 503, { error: "repair-sessions-unavailable" });
      return true;
    }
    const session = deps.repairSessions.approve(decodeURIComponent(repairApprovalMatch[1]!));
    if (session === undefined) {
      sendJson(res, 404, { error: "repair-session-not-found" });
    } else {
      sendJson(res, 202, session);
    }
    return true;
  }

  const recoveryActionMatch = /^\/api\/recovery\/actions\/([^/]+)\/execute$/.exec(path);
  if (recoveryActionMatch !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const actionId = decodeURIComponent(recoveryActionMatch[1]!);
    const instanceId =
      typeof body["instanceId"] === "string" && body["instanceId"].trim() !== ""
        ? body["instanceId"].trim()
        : undefined;
    const action = recoveryActionCatalog(deps, instanceId).find((item) => item.id === actionId);
    if (action === undefined) {
      sendJson(res, 404, { error: "recovery-action-not-found" });
      return true;
    }
    if (!action.available) {
      sendJson(res, 409, { error: "recovery-action-unavailable", detail: action.unavailableReason });
      return true;
    }
    if (action.requiresConfirmation && body["confirmed"] !== true) {
      sendJson(res, 400, { error: "confirmation-required", action });
      return true;
    }
    const job = recoveryTracker.start(
      actionId,
      action.label,
      action.estimatedSeconds,
      instanceId,
      actionId === "cleanup-gateway" || actionId === "restart-instance",
    );
    const jobId = job.jobId;
    if (actionId === "refresh-probe") {
      const started = deps.scheduler.runNow();
      if (!started) {
        recoveryTracker.finish(jobId, "failed", "巡检已在执行中");
        sendJson(res, 409, { error: "inspection-in-flight" });
        return true;
      }
      sendJson(res, 202, { jobId, actionId, status: "running" });
      return true;
    }
    if (actionId === "rebuild-memory-index") {
      if (deps.skills === undefined || deps.m6WritesEnabled !== true) {
        recoveryTracker.finish(jobId, "failed", "记忆写操作未启用");
        sendJson(res, 409, { error: "memory-write-disabled", jobId });
        return true;
      }
      const result = await deps.skills.rebuildIndex(instanceId === undefined ? {} : { instanceId });
      if (!result.ok) recoveryTracker.finish(jobId, "failed", result.error ?? "重建索引失败");
      else recoveryTracker.finish(jobId, "done", "记忆索引重建完成");
      sendJson(
        res,
        result.ok ? 200 : 409,
        result.ok
          ? { jobId, actionId, status: "done", verification: result.report }
          : { error: result.error ?? "rebuild-index-failed", jobId },
      );
      return true;
    }
    if (actionId === "reconnect-channel") {
      if (deps.connections === undefined) {
        recoveryTracker.finish(jobId, "failed", "连接管理服务未接线");
        sendJson(res, 503, { error: "connections-unavailable", jobId });
        return true;
      }
      const result = await deps.connections.connect(instanceId);
      if (result.status === "failed") recoveryTracker.finish(jobId, "failed", "消息通道重连失败");
      else if (result.status === "connected" || result.status === "disconnected") {
        recoveryTracker.finish(jobId, "done", "消息通道状态已更新");
      }
      sendJson(
        res,
        result.status === "no-instance" ? 404 : result.status === "failed" ? 409 : 202,
        {
          jobId,
          actionId,
          status: result.status,
          ...("connection" in result ? { verification: result.connection } : {}),
        },
      );
      return true;
    }
    if (actionId === "apply-throttle-patch") {
      if (deps.gateway === undefined) {
        recoveryTracker.finish(jobId, "failed", "网关补丁服务未接线");
        sendJson(res, 503, { error: "gateway-unavailable", jobId });
        return true;
      }
      const stats = await deps.gateway.stats();
      const suggestion = stats.suggestions[0];
      if (!suggestion) {
        recoveryTracker.finish(jobId, "done", "当前没有需要调整的节流参数");
        sendJson(res, 200, { jobId, actionId, status: "done", detail: "当前没有需要调整的节流参数" });
        return true;
      }
      const patchView = (await deps.gateway.patches()).find((patch) => patch.id === suggestion.patchId);
      if (patchView?.observed !== null && patchView?.observed !== undefined && patchView.applied === null) {
        const detail =
          "已检测到同等的手工补丁，但 Butler 尚未纳管，不能直接覆盖。请先在网关补丁页核对差异并选择纳管或手工调整。";
        recoveryTracker.finish(jobId, "failed", detail);
        sendJson(res, 409, {
          error: "patch-observed",
          detail,
          current: patchView.observed.params,
          targetPath: patchView.observed.targetPath,
          nextAction: "open-gateway-patches",
          jobId,
        });
        return true;
      }
      const applied = await deps.gateway.applyPatch({
        patchId: suggestion.patchId,
        params: { [suggestion.param]: suggestion.suggested },
        instanceId,
      });
      if (applied.status !== "ok") {
        recoveryTracker.finish(jobId, "failed", "代码补丁应用失败");
        sendJson(res, 409, { error: "patch-apply-failed", detail: applied.status, jobId });
        return true;
      }
      recoveryTracker.finish(jobId, "done", "网关节流补丁已应用");
      sendJson(res, 200, { jobId, actionId, status: "done", verification: applied });
      return true;
    }
    const runbookId = actionId === "cleanup-gateway" ? "rb-cleanup-gateway" : "rb-restart";
    const beforeRunAt = deps.runbooks().find((item) => item.id === runbookId)?.lastRun?.at ?? null;
    const outcome = await deps.executeRunbook(runbookId, instanceId);
    if (outcome.status === "started") {
      recoveryTracker.monitorRunbook(jobId, () => deps.runbooks(), runbookId, beforeRunAt);
      sendJson(res, 202, { jobId, actionId, status: "running", instanceId: outcome.instanceId });
      return true;
    }
    recoveryTracker.finish(
      jobId,
      "failed",
      outcome.status === "circuit-breaker-tripped"
        ? "保护机制暂时阻止了执行"
        : "没有可用的 Hermes 实例",
    );
    if (outcome.status === "unknown-runbook") {
      sendJson(res, 404, { error: "runbook-not-found" });
      return true;
    }
    if (outcome.status === "circuit-breaker-tripped") {
      sendJson(res, 409, { error: "circuit-breaker-tripped" });
      return true;
    }
    sendJson(res, 503, { error: "no-servicing-instance" });
    return true;
  }

  const recoveryJobMatch = /^\/api\/recovery\/jobs\/([^/]+)$/.exec(path);
  if (recoveryJobMatch !== null) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const job = recoveryTracker.get(decodeURIComponent(recoveryJobMatch[1]!));
    if (!job) {
      sendJson(res, 404, { error: "recovery-job-not-found" });
      return true;
    }
    sendJson(res, 200, job);
    return true;
  }

  if (path === "/api/connections") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.connections === undefined) {
      sendJson(res, 503, { error: "connections-unavailable" });
      return true;
    }
    sendJson(res, 200, deps.connections.status());
    return true;
  }

  if (path === "/api/connections/check") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.connections === undefined) {
      sendJson(res, 503, { error: "connections-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const instanceId =
      typeof body["instanceId"] === "string" && body["instanceId"] !== ""
        ? body["instanceId"]
        : undefined;
    const outcome = await deps.connections.check(instanceId);
    if (outcome.status === "no-instance") {
      sendJson(res, 404, { error: "no-instance" });
      return true;
    }
    sendJson(res, 200, outcome);
    return true;
  }

  const connectionAction = /^\/api\/connections\/([^/]+)\/(connect|disconnect)$/.exec(path);
  if (connectionAction !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (connectionAction[2] === "connect" && deps.killswitch?.isEngaged() === true) {
      sendJson(res, 409, { error: "killswitch-engaged" });
      return true;
    }
    if (deps.connections === undefined) {
      sendJson(res, 503, { error: "connections-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const instanceId = decodeURIComponent(connectionAction[1]!);
    const action = connectionAction[2] === "connect" ? deps.connections.connect : deps.connections.disconnect;
    const outcome = await action(instanceId);
    if (outcome.status === "no-instance") {
      sendJson(res, 404, { error: "no-instance" });
      return true;
    }
    sendJson(res, outcome.status === "failed" ? 409 : 200, outcome);
    return true;
  }

  if (path === "/api/openclaw/status") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.openclawInstall === undefined) {
      sendJson(res, 503, { error: "openclaw-install-unavailable" });
      return true;
    }
    sendJson(res, 200, deps.openclawInstall.status());
    return true;
  }

  if (path === "/api/upgrade/run") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.killswitch?.isEngaged() === true) {
      sendJson(res, 409, { error: "killswitch-engaged" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const targetVersion = body["targetVersion"];
    if (typeof targetVersion !== "string" || targetVersion.trim() === "") {
      sendJson(res, 400, { error: "missing-target-version" });
      return true;
    }
    const instanceId =
      typeof body["instanceId"] === "string" && body["instanceId"] !== ""
        ? body["instanceId"]
        : undefined;
    const channel =
      body["channel"] === "beta" ? "beta" : body["channel"] === "stable" ? "stable" : undefined;
    const outcome = await deps.upgrade.startUpgrade({ instanceId, targetVersion, channel });
    if (outcome.status === "started") {
      sendJson(res, 202, {
        started: true,
        jobId: outcome.jobId,
        instanceId: outcome.instanceId,
      });
      return true;
    }
    if (outcome.status === "upgrade-in-flight") {
      sendJson(res, 409, { error: "upgrade-in-flight" });
      return true;
    }
    if (outcome.status === "missing-target-version") {
      sendJson(res, 400, { error: "missing-target-version" });
      return true;
    }
    if (outcome.status === "backup-failed") {
      sendJson(res, 503, { error: "upgrade-prebackup-failed", detail: outcome.error });
      return true;
    }
    sendJson(res, 503, { error: "no-servicing-instance" });
    return true;
  }

  if (path === "/api/upgrade/status") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    sendJson(res, 200, { job: deps.upgrade.status() });
    return true;
  }

  if (path === "/api/upgrade/versions") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const result = await deps.upgrade.listVersions();
    sendJson(res, 200, result);
    return true;
  }

  if (path === "/api/upgrade/compatibility") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    if (typeof body["targetVersion"] !== "string" || body["targetVersion"].trim() === "") {
      sendJson(res, 400, { error: "missing-target-version" });
      return true;
    }
    sendJson(
      res,
      200,
      deps.upgrade.compatibility({
        targetVersion: body["targetVersion"],
        instanceId: typeof body["instanceId"] === "string" ? body["instanceId"] : undefined,
      }),
    );
    return true;
  }

  const rollbackMatch = /^\/api\/snapshots\/([^/]+)\/rollback$/.exec(path);
  if (rollbackMatch !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const idRaw = decodeURIComponent(rollbackMatch[1]!);
    if (!/^\d+$/.test(idRaw)) {
      sendJson(res, 400, { error: "invalid-snapshot-id" });
      return true;
    }
    const instanceId =
      typeof body["instanceId"] === "string" && body["instanceId"] !== ""
        ? body["instanceId"]
        : undefined;
    const outcome = await deps.upgrade.rollbackSnapshot(Number(idRaw), instanceId);
    if (outcome.status === "ok") {
      sendJson(res, 200, { job: outcome.job });
      return true;
    }
    if (outcome.status === "snapshot-not-found") {
      sendJson(res, 404, { error: "snapshot-not-found" });
      return true;
    }
    sendJson(res, 503, { error: "no-servicing-instance" });
    return true;
  }

  return false;
}
