import { CONTROL_API_SCHEMA_VERSION } from "@butler/contract";
import { toUserFacingError } from "@butler/core";
import { createDiagnosticZip } from "../diagnostics.js";
import {
  type RequestContext,
  WATCH_SERVICE_VERSION,
  markdownErrorResponse,
  publicMarkdownFile,
  readJsonBody,
  sendJson,
  sendMarkdown,
  sendZip,
} from "../http-common.js";

export async function handleSystem(ctx: RequestContext): Promise<boolean> {
  const { deps, req, res, url, path, method } = ctx;

  if (path === "/healthz") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const dbOk = deps.dbProbe ? deps.dbProbe() : true;
    const critical = deps.scheduler.status().criticalProbe;
    const schedulerOk = critical ? !critical.overdue : true;
    const ok = dbOk && schedulerOk;
    sendJson(res, ok ? 200 : 503, {
      ok,
      service: "watch",
      serviceVersion: WATCH_SERVICE_VERSION,
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      checks: {
        db: dbOk,
        scheduler: schedulerOk,
        criticalOverdue: critical?.overdue ?? null,
        lastCompletedAt: critical?.lastCompletedAt ?? null,
      },
    });
    return true;
  }

  if (path === "/api/runtime") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    sendJson(res, 200, deps.runtime?.() ?? { kind: "unknown", detail: "运行时信息不可用" });
    return true;
  }

  if (path === "/api/backups") {
    if (deps.backup === undefined) {
      sendJson(res, 503, { error: "backup-unavailable" });
      return true;
    }
    if (method === "GET") {
      const kindParam = url.searchParams.get("kind")?.trim();
      const kind =
        kindParam === "full" || kindParam === "memory" || kindParam === "event"
          ? kindParam
          : undefined;
      sendJson(res, 200, { items: deps.backup.list(kind), status: deps.backup.status() });
      return true;
    }
    if (method === "POST") {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const kind = body["kind"];
      if (kind !== "full" && kind !== "memory" && kind !== "event") {
        sendJson(res, 400, { error: "invalid-backup-kind" });
        return true;
      }
      const label = typeof body["label"] === "string" ? body["label"].trim() : undefined;
      try {
        const backup = await deps.backup.run(kind, label || undefined);
        sendJson(res, 201, { backup });
      } catch (error) {
        const classified = toUserFacingError(error, {
          detail: "备份没有完成，当前操作未继续。",
          nextStep: "确认备份目录可写后重试，或导出诊断报告。",
        });
        sendJson(res, 500, {
          error: "backup-failed",
          code: classified.code,
          userHint: classified.detail,
          nextStep: classified.nextStep,
          errorId: classified.errorId,
        });
      }
      return true;
    }
    sendJson(res, 405, { error: "method-not-allowed" });
    return true;
  }

  const restoreMatch = /^\/api\/backups\/([^/]+)\/restore$/.exec(path);
  if (restoreMatch !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.backup === undefined) {
      sendJson(res, 503, { error: "backup-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const id = Number(restoreMatch[1]);
    if (!Number.isInteger(id) || id <= 0) {
      sendJson(res, 400, { error: "invalid-backup-id" });
      return true;
    }
    const outcome = await deps.backup.restore(id, body["confirmed"] === true);
    if (!outcome.ok) {
      if (outcome.error === "confirmation-required") {
        sendJson(res, 400, {
          error: "confirmation-required",
          userHint: "还原会覆盖当前记忆/配置，必须先确认。",
        });
        return true;
      }
      if (outcome.error === "backup-not-found" || outcome.error === "backup-manifest-corrupt") {
        sendJson(res, 404, { error: outcome.error });
        return true;
      }
      sendJson(res, 400, { error: outcome.error });
      return true;
    }
    sendJson(res, 200, outcome);
    return true;
  }

  if (path === "/api/backups/verify") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.backup === undefined) {
      sendJson(res, 503, { error: "backup-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const rawId = body["id"];
    if (rawId !== undefined && (typeof rawId !== "number" || !Number.isInteger(rawId) || rawId <= 0)) {
      sendJson(res, 400, { error: "invalid-backup-id" });
      return true;
    }
    const outcome = await deps.backup.verify(rawId);
    if (!outcome.ok) {
      const status = outcome.error === "backup-not-found" ? 404 : 409;
      sendJson(res, status, outcome);
      return true;
    }
    sendJson(res, 200, outcome);
    return true;
  }

  if (path === "/api/security") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.security === undefined) {
      sendJson(res, 503, { error: "security-unavailable" });
      return true;
    }
    const status = await deps.security.status();
    sendJson(res, 200, { ...status, memoryWritesEnabled: deps.m6WritesEnabled === true });
    return true;
  }

  /* ---------------------- 核心 Markdown 文件管理 ---------------------- */
  if (path === "/api/markdown/files") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.markdownFiles === undefined) {
      sendJson(res, 503, { error: "markdown-unavailable", nextStep: "请同步部署 Watch 服务后重试。" });
      return true;
    }
    try {
      const instanceId = url.searchParams.get("instanceId")?.trim() || undefined;
      sendJson(res, 200, { instanceId: instanceId ?? null, files: deps.markdownFiles.list(instanceId).map(publicMarkdownFile) });
    } catch (error) {
      const mapped = markdownErrorResponse(error);
      sendJson(res, mapped.status, mapped.body);
    }
    return true;
  }

  const markdownFileMatch = /^\/api\/markdown\/files\/([^/]+)$/.exec(path);
  if (markdownFileMatch !== null) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.markdownFiles === undefined) {
      sendJson(res, 503, { error: "markdown-unavailable", nextStep: "请同步部署 Watch 服务后重试。" });
      return true;
    }
    try {
      const fileId = decodeURIComponent(markdownFileMatch[1]!);
      const result = deps.markdownFiles.read(fileId);
      sendJson(res, 200, { file: publicMarkdownFile(result.file), content: result.content });
    } catch (error) {
      const mapped = markdownErrorResponse(error);
      sendJson(res, mapped.status, mapped.body);
    }
    return true;
  }

  const markdownPreviewMatch = /^\/api\/markdown\/files\/([^/]+)\/preview$/.exec(path);
  if (markdownPreviewMatch !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.markdownFiles === undefined) {
      sendJson(res, 503, { error: "markdown-unavailable", nextStep: "请同步部署 Watch 服务后重试。" });
      return true;
    }
    const body = await readJsonBody(req, res, 2 * 1024 * 1024);
    if (body === null) return true;
    if (typeof body["content"] !== "string" || typeof body["baseSha256"] !== "string") {
      sendJson(res, 400, { error: "invalid-markdown-input", detail: "需要提供 content 和 baseSha256。", nextStep: "重新读取文件后再预览。" });
      return true;
    }
    try {
      const preview = deps.markdownFiles.preview(decodeURIComponent(markdownPreviewMatch[1]!), body["content"], body["baseSha256"]);
      sendJson(res, 200, { ...preview, file: publicMarkdownFile(preview.file) });
    } catch (error) {
      const mapped = markdownErrorResponse(error);
      sendJson(res, mapped.status, mapped.body);
    }
    return true;
  }

  const markdownApplyMatch = /^\/api\/markdown\/files\/([^/]+)\/apply$/.exec(path);
  if (markdownApplyMatch !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.markdownFiles === undefined) {
      sendJson(res, 503, { error: "markdown-unavailable", nextStep: "请同步部署 Watch 服务后重试。" });
      return true;
    }
    const body = await readJsonBody(req, res, 2 * 1024 * 1024);
    if (body === null) return true;
    if (typeof body["content"] !== "string" || typeof body["baseSha256"] !== "string") {
      sendJson(res, 400, { error: "invalid-markdown-input", detail: "需要提供 content 和 baseSha256。", nextStep: "重新读取文件后再保存。" });
      return true;
    }
    try {
      const result = await deps.markdownFiles.apply(decodeURIComponent(markdownApplyMatch[1]!), {
        content: body["content"],
        baseSha256: body["baseSha256"],
        confirmed: body["confirmed"] === true,
        note: typeof body["note"] === "string" ? body["note"] : undefined,
      });
      sendJson(res, 200, { file: publicMarkdownFile(result.file), revision: result.revision });
    } catch (error) {
      const mapped = markdownErrorResponse(error);
      sendJson(res, mapped.status, mapped.body);
    }
    return true;
  }

  const markdownRevisionsMatch = /^\/api\/markdown\/files\/([^/]+)\/revisions$/.exec(path);
  if (markdownRevisionsMatch !== null) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.markdownFiles === undefined) {
      sendJson(res, 503, { error: "markdown-unavailable", nextStep: "请同步部署 Watch 服务后重试。" });
      return true;
    }
    try {
      sendJson(res, 200, { revisions: deps.markdownFiles.revisions(decodeURIComponent(markdownRevisionsMatch[1]!)) });
    } catch (error) {
      const mapped = markdownErrorResponse(error);
      sendJson(res, mapped.status, mapped.body);
    }
    return true;
  }

  const markdownBackupMatch = /^\/api\/markdown\/files\/([^/]+)\/backup$/.exec(path);
  if (markdownBackupMatch !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.markdownFiles === undefined) {
      sendJson(res, 503, { error: "markdown-unavailable", nextStep: "请同步部署 Watch 服务后重试。" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    try {
      sendJson(res, 201, {
        revision: deps.markdownFiles.backup(
          decodeURIComponent(markdownBackupMatch[1]!),
          typeof body["note"] === "string" ? body["note"] : undefined
        ),
      });
    } catch (error) {
      const mapped = markdownErrorResponse(error);
      sendJson(res, mapped.status, mapped.body);
    }
    return true;
  }

  const markdownRestoreMatch = /^\/api\/markdown\/files\/([^/]+)\/revisions\/([^/]+)\/restore$/.exec(path);
  if (markdownRestoreMatch !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.markdownFiles === undefined) {
      sendJson(res, 503, { error: "markdown-unavailable", nextStep: "请同步部署 Watch 服务后重试。" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    if (typeof body["baseSha256"] !== "string") {
      sendJson(res, 400, { error: "invalid-markdown-input", detail: "需要提供 baseSha256。", nextStep: "重新读取文件后再恢复。" });
      return true;
    }
    try {
      const result = await deps.markdownFiles.restore(
        decodeURIComponent(markdownRestoreMatch[1]!),
        decodeURIComponent(markdownRestoreMatch[2]!),
        body["confirmed"] === true,
        body["baseSha256"]
      );
      sendJson(res, 200, { file: publicMarkdownFile(result.file), revision: result.revision });
    } catch (error) {
      const mapped = markdownErrorResponse(error);
      sendJson(res, mapped.status, mapped.body);
    }
    return true;
  }

  const markdownDownloadMatch = /^\/api\/markdown\/files\/([^/]+)\/download$/.exec(path);
  if (markdownDownloadMatch !== null) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.markdownFiles === undefined) {
      sendJson(res, 503, { error: "markdown-unavailable", nextStep: "请同步部署 Watch 服务后重试。" });
      return true;
    }
    try {
      const result = deps.markdownFiles.download(decodeURIComponent(markdownDownloadMatch[1]!));
      sendMarkdown(res, result.filename, result.content);
    } catch (error) {
      const mapped = markdownErrorResponse(error);
      sendJson(res, mapped.status, mapped.body);
    }
    return true;
  }

  if (path === "/api/butler/version") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.butler === undefined) {
      sendJson(res, 503, { error: "butler-unavailable" });
      return true;
    }
    sendJson(res, 200, deps.butler.version());
    return true;
  }

  if (path === "/api/butler/self") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.butlerSelf === undefined) {
      sendJson(res, 503, { error: "butler-self-unavailable" });
      return true;
    }
    if (deps.butlerSelf.refresh !== undefined) await deps.butlerSelf.refresh();
    sendJson(res, 200, deps.butlerSelf.status());
    return true;
  }

  if (path === "/api/butler/self/upgrade") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.butlerSelf === undefined) {
      sendJson(res, 503, { error: "butler-self-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const target =
      typeof body["target"] === "string" && body["target"].trim() !== ""
        ? body["target"].trim()
        : undefined;
    const channel = body["channel"] === "beta" ? "beta" : body["channel"] === "stable" ? "stable" : undefined;
    const outcome = await deps.butlerSelf.startUpgrade({
      ...(target === undefined ? {} : { target }),
      ...(channel === undefined ? {} : { channel }),
      confirmed: body["confirmed"] === true,
      trigger: "manual",
    });
    if (outcome.status === "started") {
      sendJson(res, 202, { started: true, jobId: outcome.jobId, snapshotId: outcome.snapshotId });
      return true;
    }
    if (outcome.status === "confirmation-required") {
      sendJson(res, 400, { error: "confirmation-required", userHint: "升级前会备份并重启服务，必须先确认。" });
      return true;
    }
    if (outcome.status === "upgrade-in-flight") {
      sendJson(res, 409, { error: "upgrade-in-flight" });
      return true;
    }
    if (outcome.status === "backup-failed") {
      sendJson(res, 500, {
        error: "backup-failed",
        userHint: "升级前全量备份失败，已取消升级。请检查备份目录和数据库状态后重试。",
      });
      return true;
    }
    if (outcome.status === "invalid-target" || outcome.status === "no-target") {
      sendJson(res, 400, { error: outcome.status, userHint: "没有找到可用的目标版本。" });
      return true;
    }
    sendJson(res, 503, { error: "no-repo", userHint: "源码目录还不是 Git 仓库，暂时不能自我升级。" });
    return true;
  }

  if (path === "/api/butler/self/rollback") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.butlerSelf === undefined) {
      sendJson(res, 503, { error: "butler-self-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const snapshotId = typeof body["snapshotId"] === "string" ? body["snapshotId"] : "";
    const outcome = deps.butlerSelf.rollback({
      snapshotId,
      confirmed: body["confirmed"] === true,
    });
    if (outcome.status === "started") {
      sendJson(res, 202, { started: true, jobId: outcome.jobId });
      return true;
    }
    if (outcome.status === "confirmation-required") {
      sendJson(res, 400, { error: "confirmation-required", userHint: "回滚会重建并重启服务，必须先确认。" });
      return true;
    }
    if (outcome.status === "upgrade-in-flight") {
      sendJson(res, 409, { error: "upgrade-in-flight" });
      return true;
    }
    if (outcome.status === "snapshot-not-found") {
      sendJson(res, 404, { error: "snapshot-not-found" });
      return true;
    }
    sendJson(res, 503, { error: "no-repo" });
    return true;
  }

  if (path === "/api/butler/self/prefs") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.butlerSelf === undefined) {
      sendJson(res, 503, { error: "butler-self-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const channel = body["channel"] === "beta" ? "beta" : body["channel"] === "stable" ? "stable" : undefined;
    const locked = typeof body["locked"] === "boolean" ? body["locked"] : undefined;
    sendJson(res, 200, deps.butlerSelf.updatePrefs({
      ...(channel === undefined ? {} : { channel }),
      ...(locked === undefined ? {} : { locked }),
    }));
    return true;
  }

  if (path === "/api/diagnostics/report") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.renderDiagnostics === undefined) {
      sendJson(res, 503, { error: "diagnostics-unavailable" });
      return true;
    }
    const markdown = await deps.renderDiagnostics();
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    if (url.searchParams.get("format") === "zip") {
      sendZip(res, `agent-butler-diagnostic-${stamp}.zip`, createDiagnosticZip(markdown));
      return true;
    }
    sendMarkdown(res, `agent-butler-diagnostic-${stamp}.md`, markdown);
    return true;
  }

  if (path === "/api/diagnostics/summary") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.diagnosticSummary === undefined) {
      sendJson(res, 503, { error: "diagnostics-unavailable" });
      return true;
    }
    sendJson(res, 200, await deps.diagnosticSummary());
    return true;
  }

  return false;
}
