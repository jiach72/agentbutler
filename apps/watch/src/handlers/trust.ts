import { GROUP_LABEL, type InstanceGroup } from "../federation.js";
import type { BudgetActionConfig, BudgetStatus } from "../budget.js";
import {
  type RequestContext,
  parseActionKind,
  parseSeverityParam,
  parseTrustSeverity,
  parseTrustStatus,
  readBoundedNumber,
  readJsonBody,
  readNonEmptyString,
  sendJson,
  serializeTrustEvent,
} from "../http-common.js";

export async function handleTrust(ctx: RequestContext): Promise<boolean> {
  const { deps, req, res, url, path, method, credentialWritesAllowed } = ctx;

  if (path === "/api/budget") {
    if (deps.budget === undefined) {
      sendJson(res, 503, { error: "budget-unavailable" });
      return true;
    }
    if (method === "GET") {
      sendJson(res, 200, deps.budget.status());
      return true;
    }
    if (method === "POST") {
      if (!credentialWritesAllowed) {
        sendJson(res, 403, { error: "credential-writes-disabled" });
        return true;
      }
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const monthlyUsd = Number(body["monthlyUsd"]);
      const action = body["action"];
      if (!Number.isFinite(monthlyUsd) || monthlyUsd < 0 || monthlyUsd > 100_000) {
        sendJson(res, 400, { error: "invalid-monthly-usd" });
        return true;
      }
      if (action !== undefined && action !== "alert" && action !== "downgrade" && action !== "pause") {
        sendJson(res, 400, { error: "invalid-action" });
        return true;
      }
      try {
        const status = deps.budget.setConfig({
          monthlyUsd,
          action: (action as BudgetActionConfig | undefined) ?? "alert",
        });
        deps.audit?.append({
          actor: "panel",
          action: "budget-config-set",
          target: status.month,
          detail: { monthlyUsd, action: status.action },
        });
        sendJson(res, 200, status);
      } catch (error) {
        sendJson(res, 400, {
          error: "invalid-budget-config",
          detail: String(error instanceof Error ? error.message : error),
        });
      }
      return true;
    }
    sendJson(res, 405, { error: "method-not-allowed" });
    return true;
  }

  if (path === "/api/budget/check") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.budget === undefined) {
      sendJson(res, 503, { error: "budget-unavailable" });
      return true;
    }
    const status: BudgetStatus = await deps.budget.checkNow();
    sendJson(res, 200, status);
    return true;
  }

  // 记忆探针频率（审计：完整写入探针触发提供方 LLM 抽取，有 API 成本）。
  if (path === "/api/memory-probe/config") {
    if (deps.probeConfig === undefined) {
      sendJson(res, 503, { error: "probe-config-unavailable" });
      return true;
    }
    if (method === "GET") {
      sendJson(res, 200, { intervalMin: deps.probeConfig.get() });
      return true;
    }
    if (method === "POST") {
      if (!credentialWritesAllowed) {
        sendJson(res, 403, { error: "credential-writes-disabled" });
        return true;
      }
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const intervalMin = Number(body["intervalMin"]);
      if (!Number.isFinite(intervalMin) || intervalMin < 5 || intervalMin > 1440) {
        sendJson(res, 400, { error: "invalid-interval", detail: "intervalMin 须在 5 ~ 1440 分钟之间" });
        return true;
      }
      deps.probeConfig.set(Math.floor(intervalMin));
      deps.audit?.append({
        actor: "panel",
        action: "probe-interval-set",
        target: "memory",
        detail: { intervalMin },
      });
      sendJson(res, 200, { intervalMin: deps.probeConfig.get() });
      return true;
    }
    sendJson(res, 405, { error: "method-not-allowed" });
    return true;
  }

  // 行为审计流（M1.2）：按时间窗过滤的动作时间线 + 汇总。
  if (path === "/api/audit/actions") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.actionAudit === undefined) {
      sendJson(res, 503, { error: "audit-unavailable" });
      return true;
    }
    const windowHours = readBoundedNumber(url, "hours", 1, 24 * 90, 24);
    const limit = readBoundedNumber(url, "limit", 1, 1000, 200);
    const kind = parseActionKind(url.searchParams.get("kind"));
    if (url.searchParams.get("kind") !== null && kind === undefined) {
      sendJson(res, 400, { error: "invalid-kind" });
      return true;
    }
    const severity = parseSeverityParam(url.searchParams.get("severity"));
    if (url.searchParams.get("severity") !== null && severity === undefined) {
      sendJson(res, 400, { error: "invalid-severity" });
      return true;
    }
    sendJson(res, 200, {
      windowHours,
      actions: deps.actionAudit.actions({ windowHours, kind, severity, limit }),
      collector: deps.actionAudit.collectorView(),
    });
    return true;
  }

  if (path === "/api/audit/summary") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.actionAudit === undefined) {
      sendJson(res, 503, { error: "audit-unavailable" });
      return true;
    }
    const windowHours = readBoundedNumber(url, "hours", 1, 24 * 90, 24);
    sendJson(res, 200, deps.actionAudit.summary(windowHours));
    return true;
  }

  // 全局急停（M1.3）：状态 / 触发 / 解除。engage 与 release 都落审计与事件。
  if (path === "/api/killswitch") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.killswitch === undefined) {
      sendJson(res, 503, { error: "killswitch-unavailable" });
      return true;
    }
    sendJson(res, 200, deps.killswitch.state());
    return true;
  }

  if (path === "/api/killswitch/engage") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.killswitch === undefined) {
      sendJson(res, 503, { error: "killswitch-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const outcome = await deps.killswitch.engage({
      trigger: typeof body["trigger"] === "string" ? body["trigger"] : undefined,
      actor: typeof body["actor"] === "string" ? body["actor"] : undefined,
    });
    if (outcome.status === "already-engaged") {
      sendJson(res, 409, { error: "killswitch-already-engaged", state: outcome.state });
      return true;
    }
    sendJson(res, 200, outcome.state);
    return true;
  }

  if (path === "/api/killswitch/release") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.killswitch === undefined) {
      sendJson(res, 503, { error: "killswitch-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const outcome = await deps.killswitch.release({
      actor: typeof body["actor"] === "string" ? body["actor"] : undefined,
    });
    if (outcome.status === "not-engaged") {
      sendJson(res, 409, { error: "killswitch-not-engaged", state: outcome.state });
      return true;
    }
    sendJson(res, 200, outcome.state);
    return true;
  }

  // 事件中心（M2.2）：列表（regressed/active 置顶）+ 详情 + 状态流转。
  if (path === "/api/trust/events") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.trustEvents === undefined) {
      sendJson(res, 503, { error: "trust-events-unavailable" });
      return true;
    }
    const status = parseTrustStatus(url.searchParams.get("status"));
    if (url.searchParams.get("status") !== null && status === undefined) {
      sendJson(res, 400, { error: "invalid-status" });
      return true;
    }
    const severity = parseTrustSeverity(url.searchParams.get("severity"));
    if (url.searchParams.get("severity") !== null && severity === undefined) {
      sendJson(res, 400, { error: "invalid-severity" });
      return true;
    }
    const limitRaw = url.searchParams.get("limit");
    if (limitRaw !== null) {
      const limitValue = Number(limitRaw);
      if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 500) {
        sendJson(res, 400, { error: "limit-out-of-range", max: 500 });
        return true;
      }
    }
    const limit = readBoundedNumber(url, "limit", 1, 500, 100);
    const offsetRaw = url.searchParams.get("offset");
    const offsetValue = offsetRaw === null ? 0 : Number(offsetRaw);
    const offset = Number.isInteger(offsetValue) && offsetValue > 0 ? offsetValue : 0;
    sendJson(res, 200, {
      events: deps.trustEvents.list({ status, severity, limit, offset }).map(serializeTrustEvent),
    });
    return true;
  }

  const trustEventMatch = /^\/api\/trust\/events\/(\d+)$/.exec(path);
  if (trustEventMatch !== null) {
    if (deps.trustEvents === undefined) {
      sendJson(res, 503, { error: "trust-events-unavailable" });
      return true;
    }
    const id = Number(trustEventMatch[1]);
    if (method === "GET") {
      const event = deps.trustEvents.get(id);
      if (event === undefined) {
        sendJson(res, 404, { error: "event-not-found" });
      } else {
        sendJson(res, 200, { event: serializeTrustEvent(event) });
      }
      return true;
    }
    if (method === "POST") {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const next = body["status"];
      if (next !== "acknowledged" && next !== "resolved" && next !== "active") {
        sendJson(res, 400, { error: "invalid-status" });
        return true;
      }
      const updated = deps.trustEvents.setStatus(id, next);
      if (updated === undefined) {
        sendJson(res, 404, { error: "event-not-found" });
      } else {
        sendJson(res, 200, { event: serializeTrustEvent(updated) });
      }
      return true;
    }
    sendJson(res, 405, { error: "method-not-allowed" });
    return true;
  }

  // ── M2.1 Agent 周报 ──
  if (path === "/api/trust/report") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.weeklyReport === undefined) {
      sendJson(res, 503, { error: "weekly-report-unavailable" });
      return true;
    }
    const current = await deps.weeklyReport.current();
    sendJson(res, 200, current);
    return true;
  }

  if (path === "/api/trust/report/history") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.weeklyReport === undefined) {
      sendJson(res, 503, { error: "weekly-report-unavailable" });
      return true;
    }
    const limit = readBoundedNumber(url, "limit", 1, 52, 12);
    const reports = deps.weeklyReport
      .history(limit)
      .map(({ markdown: _markdown, dataJson: _dataJson, ...rest }) => rest);
    sendJson(res, 200, { reports });
    return true;
  }

  const reportMatch = /^\/api\/trust\/report\/(\d+)$/.exec(path);
  if (reportMatch !== null) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.weeklyReport === undefined) {
      sendJson(res, 503, { error: "weekly-report-unavailable" });
      return true;
    }
    const row = deps.weeklyReport.get(Number(reportMatch[1]));
    if (row === undefined) {
      sendJson(res, 404, { error: "report-not-found" });
      return true;
    }
    let data: unknown = null;
    try {
      data = JSON.parse(row.dataJson) as unknown;
    } catch {
      data = null;
    }
    sendJson(res, 200, { report: { ...row, dataJson: undefined, data } });
    return true;
  }

  if (path === "/api/trust/report/run") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.weeklyReport === undefined) {
      sendJson(res, 503, { error: "weekly-report-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const row = await deps.weeklyReport.runFor(undefined, { push: body["push"] === true });
    sendJson(res, 200, { report: { ...row, dataJson: undefined } });
    return true;
  }

  // ── M2.3 会话索引 ──
  if (path === "/api/sessions") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.sessions === undefined) {
      sendJson(res, 503, { error: "sessions-unavailable" });
      return true;
    }
    const anomalyOnly = url.searchParams.get("anomalyOnly") === "1" || url.searchParams.get("anomalyOnly") === "true";
    const outcome = url.searchParams.get("outcome");
    const limit = readBoundedNumber(url, "limit", 1, 500, 100);
    const offset = readBoundedNumber(url, "offset", 0, 100_000, 0);
    const windowDaysRaw = url.searchParams.get("windowDays");
    const windowDays = windowDaysRaw === null ? undefined : readBoundedNumber(url, "windowDays", 1, 90, 30);
    sendJson(res, 200, {
      ...deps.sessions.list({
        limit,
        offset,
        anomalyOnly,
        ...(outcome === null || outcome === "" ? {} : { outcome }),
        ...(windowDays === undefined ? {} : { windowDays }),
      }),
      lastRefresh: deps.sessions.lastRefresh(),
    });
    return true;
  }

  if (path === "/api/sessions/reindex") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.sessions === undefined) {
      sendJson(res, 503, { error: "sessions-unavailable" });
      return true;
    }
    const result = await deps.sessions.refresh();
    sendJson(res, 200, result);
    return true;
  }

  const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(path);
  if (sessionMatch !== null) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.sessions === undefined) {
      sendJson(res, 503, { error: "sessions-unavailable" });
      return true;
    }
    const sessionId = decodeURIComponent(sessionMatch[1]!);
    const detail = deps.sessions.detail(sessionId);
    if (detail === null) {
      sendJson(res, 404, { error: "session-not-found" });
      return true;
    }
    if (deps.progress !== undefined) {
      const claims = deps.progress.claims({ sessionId, windowDays: 90, limit: 500 });
      const nodes = claims.map((claim) => ({
        at: claim.ts,
        kind: "progress" as const,
        label: `${claim.verdict === "verified" ? "✓" : "？"} ${
          claim.claimedPct === null ? "声称已完成" : `声称完成 ${claim.claimedPct}%`
        }`,
        severity: claim.verdict === "verified" ? ("info" as const) : ("warn" as const),
        payload: {
          claimId: claim.id,
          verdict: claim.verdict,
          sideEffectCount: claim.sideEffectCount,
          sideEffectKinds: claim.sideEffectKinds,
          reason: claim.reason,
        },
      }));
      sendJson(res, 200, {
        ...detail,
        timeline: [...detail.timeline, ...nodes].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
        progress: deps.progress.sessionProgress(sessionId),
      });
      return true;
    }
    sendJson(res, 200, detail);
    return true;
  }

  // ── M4.4 多实例联邦 ──
  if (path === "/api/federation") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.federation === undefined) {
      sendJson(res, 503, { error: "federation-unavailable" });
      return true;
    }
    const windowDays = readBoundedNumber(url, "windowDays", 1, 90, 7);
    const view = deps.federation.view(windowDays);
    sendJson(res, 200, { ...view, groupLabels: GROUP_LABEL });
    return true;
  }

  if (path === "/api/federation/group") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.federation === undefined) {
      sendJson(res, 503, { error: "federation-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const instanceId = readNonEmptyString(body["instanceId"]);
    const group = readNonEmptyString(body["group"]);
    const validGroups: InstanceGroup[] = ["work", "lab", "sandbox", "unassigned"];
    if (instanceId === null || group === null || !validGroups.includes(group as InstanceGroup)) {
      sendJson(res, 400, { error: "instanceId 必填；group 必须是 work | lab | sandbox | unassigned" });
      return true;
    }
    deps.federation.setGroup(instanceId, group as InstanceGroup);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ── M4.3 记忆变更流 ──
  if (path === "/api/memory-diff") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.memoryDiff === undefined) {
      sendJson(res, 503, { error: "memory-diff-unavailable" });
      return true;
    }
    const windowDays = readBoundedNumber(url, "windowDays", 1, 90, 7);
    sendJson(res, 200, deps.memoryDiff.diff(windowDays));
    return true;
  }

  // ── M3.3 假进度检测 ──
  if (path === "/api/progress") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.progress === undefined) {
      sendJson(res, 503, { error: "progress-unavailable" });
      return true;
    }
    const windowDays = readBoundedNumber(url, "windowDays", 1, 90, 7);
    const verdictRaw = url.searchParams.get("verdict");
    const verdict =
      verdictRaw === "verified" || verdictRaw === "suspect" || verdictRaw === "unverifiable"
        ? verdictRaw
        : undefined;
    const limit = readBoundedNumber(url, "limit", 1, 500, 200);
    sendJson(res, 200, {
      summary: deps.progress.summary(windowDays),
      claims: deps.progress.claims({
        windowDays,
        limit,
        ...(verdict === undefined ? {} : { verdict }),
      }),
    });
    return true;
  }

  if (path === "/api/progress/scan") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.progress === undefined) {
      sendJson(res, 503, { error: "progress-unavailable" });
      return true;
    }
    deps.progress.tick();
    sendJson(res, 200, { summary: deps.progress.summary(7) });
    return true;
  }

  const progressSession = /^\/api\/progress\/sessions\/([^/]+)$/.exec(path);
  if (progressSession !== null) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.progress === undefined) {
      sendJson(res, 503, { error: "progress-unavailable" });
      return true;
    }
    const sessionId = decodeURIComponent(progressSession[1]!);
    const progress = deps.progress.sessionProgress(sessionId);
    sendJson(res, 200, {
      sessionId,
      progress,
      claims: deps.progress.claims({ sessionId, windowDays: 90, limit: 500 }),
    });
    return true;
  }

  // ── M3.2 升级金丝雀 ──
  if (path === "/api/canary") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.canary === undefined) {
      sendJson(res, 503, { error: "canary-unavailable" });
      return true;
    }
    const status = readNonEmptyString(url.searchParams.get("status"));
    const limit = readBoundedNumber(url, "limit", 1, 200, 50);
    sendJson(
      res,
      200,
      deps.canary.list({
        ...(status === null ? {} : { status: status as never }),
        limit,
      }),
    );
    return true;
  }

  if (path === "/api/canary/policy") {
    if (deps.canary === undefined) {
      sendJson(res, 503, { error: "canary-unavailable" });
      return true;
    }
    if (method === "GET") {
      sendJson(res, 200, { policy: deps.canary.getPolicy() });
      return true;
    }
    if (method === "POST") {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const policy = readNonEmptyString(body["policy"]);
      if (policy !== "aggressive" && policy !== "standard" && policy !== "conservative") {
        sendJson(res, 400, { error: "policy 必须是 aggressive | standard | conservative" });
        return true;
      }
      sendJson(res, 200, { policy: deps.canary.setPolicy(policy) });
      return true;
    }
    sendJson(res, 405, { error: "method-not-allowed" });
    return true;
  }

  if (path === "/api/canary/plan" || path === "/api/canary/start") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.canary === undefined) {
      sendJson(res, 503, { error: "canary-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const targetVersion = readNonEmptyString(body["targetVersion"]);
    if (targetVersion === null) {
      sendJson(res, 400, { error: "targetVersion 为必填非空字符串" });
      return true;
    }
    const instance = readNonEmptyString(body["instance"]);
    const fromVersion = readNonEmptyString(body["fromVersion"]);
    const runInput = {
      targetVersion,
      ...(instance === null ? {} : { instance }),
      fromVersion: fromVersion ?? null,
    };
    if (path === "/api/canary/plan") {
      sendJson(res, 200, { run: deps.canary.plan(runInput) });
      return true;
    }
    const snapshotRaw = body["rollbackSnapshotId"];
    const rollbackSnapshotId =
      typeof snapshotRaw === "number" && Number.isSafeInteger(snapshotRaw) && snapshotRaw > 0
        ? snapshotRaw
        : null;
    sendJson(res, 200, { run: await deps.canary.start({ ...runInput, rollbackSnapshotId }) });
    return true;
  }

  if (path === "/api/canary/tick") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.canary === undefined) {
      sendJson(res, 503, { error: "canary-unavailable" });
      return true;
    }
    sendJson(res, 200, { handled: await deps.canary.tick() });
    return true;
  }

  const canaryMatch = /^\/api\/canary\/([^/]+)$/.exec(path);
  if (canaryMatch !== null) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.canary === undefined) {
      sendJson(res, 503, { error: "canary-unavailable" });
      return true;
    }
    const run = deps.canary.get(decodeURIComponent(canaryMatch[1]!));
    if (run === null) {
      sendJson(res, 404, { error: "canary-run-not-found" });
      return true;
    }
    sendJson(res, 200, { run });
    return true;
  }

  // ── M3.1 通知即操作（操作审批） ──
  if (path === "/api/approvals") {
    if (deps.approvals === undefined) {
      sendJson(res, 503, { error: "approvals-unavailable" });
      return true;
    }
    if (method === "GET") {
      const status = url.searchParams.get("status");
      const escalateOnly =
        url.searchParams.get("escalateOnly") === "1" || url.searchParams.get("escalateOnly") === "true";
      const limit = readBoundedNumber(url, "limit", 1, 500, 100);
      const offset = readBoundedNumber(url, "offset", 0, 100_000, 0);
      sendJson(res, 200, {
        ...deps.approvals.list({
          ...(status === null || status === "" ? {} : { status }),
          escalateOnly,
          limit,
          offset,
        }),
        scan: deps.approvals.scanView(),
      });
      return true;
    }
    if (method === "POST") {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const actionId = readNonEmptyString(body["actionId"]);
      const kind = readNonEmptyString(body["kind"]);
      const title = readNonEmptyString(body["title"]);
      if (actionId === null || kind === null || title === null) {
        sendJson(res, 400, { error: "actionId/kind/title 均为必填非空字符串" });
        return true;
      }
      const item = deps.approvals.request({
        actionId,
        kind,
        title,
        ...(body["detail"] === undefined ? {} : { detail: body["detail"] }),
        ...(readNonEmptyString(body["instance"]) === null
          ? {}
          : { instance: readNonEmptyString(body["instance"])! }),
        ...(readNonEmptyString(body["sessionId"]) === null
          ? {}
          : { sessionId: readNonEmptyString(body["sessionId"])! }),
        ...(readNonEmptyString(body["fingerprint"]) === null
          ? {}
          : { fingerprint: readNonEmptyString(body["fingerprint"])! }),
      });
      sendJson(res, 201, { item });
      return true;
    }
    sendJson(res, 405, { error: "method-not-allowed" });
    return true;
  }

  // ── 批量批准 / 拒绝 ──
  if (path === "/api/approvals/bulk-decide") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.approvals === undefined) {
      sendJson(res, 503, { error: "approvals-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const decision = readNonEmptyString(body["decision"]);
    const all = body["all"] === true;
    const rawIds = body["ids"];
    const ids = Array.isArray(rawIds)
      ? rawIds.filter((item): item is string => typeof item === "string")
      : [];
    if (decision !== "approve" && decision !== "deny") {
      sendJson(res, 400, { error: "invalid-bulk-decision" });
      return true;
    }
    if (!all && ids.length === 0) {
      sendJson(res, 400, { error: "invalid-bulk-decision" });
      return true;
    }
    sendJson(
      res,
      200,
      deps.approvals.bulkDecide({
        decision,
        ...(all ? { all: true } : { ids }),
        ...(readNonEmptyString(body["actor"]) === null
          ? {}
          : { actor: readNonEmptyString(body["actor"])! }),
      }),
    );
    return true;
  }

  // ── 动作指纹防御规则管理 ──
  if (path === "/api/approvals/rules") {
    if (deps.approvals === undefined) {
      sendJson(res, 503, { error: "approvals-unavailable" });
      return true;
    }
    if (method === "GET") {
      sendJson(res, 200, { rules: deps.approvals.listRules() });
      return true;
    }
    if (method === "POST") {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const fingerprint = readNonEmptyString(body["fingerprint"]);
      const kind = readNonEmptyString(body["kind"]) ?? "action";
      const target = readNonEmptyString(body["target"]) ?? "";
      const rule = readNonEmptyString(body["rule"]);
      if (fingerprint === null || (rule !== "block" && rule !== "trust")) {
        sendJson(res, 400, { error: "fingerprint and rule ('block' | 'trust') are required" });
        return true;
      }
      const created = deps.approvals.setRule({
        fingerprint,
        kind,
        target,
        rule,
        ...(readNonEmptyString(body["reason"]) === null
          ? {}
          : { reason: readNonEmptyString(body["reason"])! }),
      });
      sendJson(res, 200, { rule: created });
      return true;
    }
    sendJson(res, 405, { error: "method-not-allowed" });
    return true;
  }

  const ruleDeleteMatch = /^\/api\/approvals\/rules\/([^/]+)$/.exec(path);
  if (ruleDeleteMatch !== null) {
    if (method !== "DELETE") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.approvals === undefined) {
      sendJson(res, 503, { error: "approvals-unavailable" });
      return true;
    }
    const fingerprint = decodeURIComponent(ruleDeleteMatch[1]!);
    const deleted = deps.approvals.deleteRule(fingerprint);
    sendJson(res, 200, { ok: true, deleted });
    return true;
  }

  const approveDecide = /^\/api\/approvals\/([^/]+)\/decide$/.exec(path);
  if (approveDecide !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.approvals === undefined) {
      sendJson(res, 503, { error: "approvals-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const decision = readNonEmptyString(body["decision"]);
    if (decision !== "approve" && decision !== "deny") {
      sendJson(res, 400, { error: "decision 必须是 approve | deny" });
      return true;
    }
    const id = decodeURIComponent(approveDecide[1]!);
    const outcome = deps.approvals.decide(id, {
      decision,
      ...(readNonEmptyString(body["actor"]) === null ? {} : { actor: readNonEmptyString(body["actor"])! }),
      ...(readNonEmptyString(body["channel"]) === null ? {} : { channel: readNonEmptyString(body["channel"])! }),
      ...(readNonEmptyString(body["reason"]) === null ? {} : { reason: readNonEmptyString(body["reason"])! }),
      blockFingerprint: body["blockFingerprint"] === true,
      trustFingerprint: body["trustFingerprint"] === true,
      allowEscalatedInline: body["source"] === "panel" || body["source"] === "web",
    });
    if (!outcome.ok) {
      const code =
        outcome.reason === "not-found"
          ? 404
          : outcome.reason === "requires-web-confirm"
            ? 409
            : outcome.reason === "expired"
              ? 410
              : 409;
      sendJson(res, code, { error: outcome.reason, item: outcome.item });
      return true;
    }
    sendJson(res, 200, { item: outcome.item });
    return true;
  }

  const approvalMatch = /^\/api\/approvals\/([^/]+)$/.exec(path);
  if (approvalMatch !== null) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.approvals === undefined) {
      sendJson(res, 503, { error: "approvals-unavailable" });
      return true;
    }
    const item = deps.approvals.get(decodeURIComponent(approvalMatch[1]!));
    if (item === null) {
      sendJson(res, 404, { error: "approval-not-found" });
      return true;
    }
    sendJson(res, 200, { item });
    return true;
  }

  return false;
}
