import {
  listSupportedMemorySystems,
  previewMemoryBackendChange,
  applyMemoryBackendChange,
  detectMemoryBackend,
} from "@butler/adapter-hermes";
import { JevClient } from "@butler/core";
import type {
  JevAdvisorRequest,
  MemoryApplyParams,
  MemoryDeployMode,
  MemoryEngineId,
} from "@butler/contract";
import {
  type RequestContext,
  isStringArray,
  readJsonBody,
  sendBytes,
  sendJson,
} from "../http-common.js";

export async function handleMemory(ctx: RequestContext): Promise<boolean> {
  const { deps, req, res, url, path, method } = ctx;

  if (path === "/api/memory/systems") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const hermesRoot = deps.hermesRoot ?? process.env.BUTLER_HERMES_ROOT ?? "./.runtime/hermes";
    const current = detectMemoryBackend(hermesRoot);
    const systems = listSupportedMemorySystems(hermesRoot);
    const typesafeKey = deps.apiKeyCredentials?.getDecryptedKeyByEnvVar("TYPESAFE_API_KEY") ?? process.env.TYPESAFE_API_KEY;
    sendJson(res, 200, {
      ok: true,
      activeBackend: current.backend,
      activeDetail: current.detail,
      activeSource: current.source,
      systems,
      jevStatus: {
        configured: Boolean(typesafeKey && typesafeKey.trim() !== ""),
        endpoint: "https://api.typesafe.ai",
      },
    });
    return true;
  }

  if (path === "/api/memory/advisor") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const body = (await readJsonBody(req, res)) as JevAdvisorRequest | null;
    if (body === null) return true;

    const typesafeKey = deps.apiKeyCredentials?.getDecryptedKeyByEnvVar("TYPESAFE_API_KEY") ?? process.env.TYPESAFE_API_KEY;
    const client = new JevClient({ apiKey: typesafeKey });
    const result = await client.adviseMemorySystem(body);
    sendJson(res, 200, { ok: true, result });
    return true;
  }

  if (path === "/api/memory/config/preview") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const body = (await readJsonBody(req, res)) as {
      engine?: MemoryEngineId;
      mode?: MemoryDeployMode;
      config?: { apiUrl?: string; apiKey?: string; port?: number };
    } | null;
    if (body === null) return true;

    const engine = body.engine ?? "hindsight";
    const mode = body.mode ?? "docker";
    const hermesRoot = deps.hermesRoot ?? process.env.BUTLER_HERMES_ROOT ?? "./.runtime/hermes";
    const preview = previewMemoryBackendChange(hermesRoot, engine, mode, body.config);
    sendJson(res, 200, { ok: true, preview });
    return true;
  }

  if (path === "/api/memory/config/apply") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const body = (await readJsonBody(req, res)) as MemoryApplyParams | null;
    if (body === null) return true;

    const engine = body.engine;
    const mode = body.mode;
    if (!engine || !mode) {
      sendJson(res, 400, { error: "missing-engine-or-mode" });
      return true;
    }

    const hermesRoot = deps.hermesRoot ?? process.env.BUTLER_HERMES_ROOT ?? "./.runtime/hermes";
    const applyOutcome = applyMemoryBackendChange(hermesRoot, engine, mode, body.config);

    let restarted = false;
    if (body.restartNow) {
      try {
        const restartRes = await deps.executeRunbook("rb-restart");
        restarted = restartRes.status === "started";
      } catch {
        // restart best effort
      }
    }

    sendJson(res, 200, {
      ok: true,
      result: {
        ...applyOutcome,
        restarted,
      },
    });
    return true;
  }

  if (path === "/api/memory") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skills === undefined) {
      sendJson(res, 503, { error: "skills-unavailable" });
      return true;
    }
    const instanceId = url.searchParams.get("instanceId")?.trim() || undefined;
    const view = await deps.skills.status({
      ...(instanceId === undefined ? {} : { instanceId }),
      limit: 20,
    });
    sendJson(res, 200, { instance: view.instance, memory: view.memory });
    return true;
  }

  if (
    path === "/api/memory/archive" ||
    path === "/api/memory/restore" ||
    path === "/api/memory/purge"
  ) {
    if (deps.m6WritesEnabled !== true) {
      sendJson(res, 404, { error: "not-found" });
      return true;
    }
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skills === undefined) {
      sendJson(res, 503, { error: "skills-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const instanceId =
      typeof body["instanceId"] === "string" && body["instanceId"] !== ""
        ? body["instanceId"]
        : undefined;
    const entryIds = isStringArray(body["entryIds"]) ? body["entryIds"] : undefined;
    const olderThan =
      typeof body["olderThan"] === "string" && body["olderThan"] !== ""
        ? body["olderThan"]
        : undefined;
    const query = instanceId === undefined ? {} : { instanceId };
    let result;
    if (path === "/api/memory/archive") {
      const dryRun = body["dryRun"] === true;
      const keepMonths =
        typeof body["keepMonths"] === "number" && Number.isFinite(body["keepMonths"])
          ? body["keepMonths"]
          : undefined;
      result = await deps.skills.archiveCold(query, {
        dryRun,
        ...(olderThan === undefined ? {} : { olderThan }),
        ...(keepMonths === undefined ? {} : { keepMonths }),
        ...(entryIds === undefined ? {} : { entryIds }),
      });
    } else if (path === "/api/memory/restore") {
      result = await deps.skills.restoreCold(query, {
        ...(entryIds === undefined ? {} : { entryIds }),
        ...(olderThan === undefined ? {} : { olderThan }),
      });
    } else {
      const confirmed = body["confirmed"] === true;
      const kind = body["kind"] === "probes" ? "probes" : body["kind"] === "archived" ? "archived" : undefined;
      const archivedBefore =
        typeof body["archivedBefore"] === "string" && body["archivedBefore"] !== ""
          ? body["archivedBefore"]
          : undefined;
      result = await deps.skills.purge(query, {
        confirmed,
        ...(kind === undefined ? {} : { kind }),
        ...(entryIds === undefined ? {} : { entryIds }),
        ...(archivedBefore === undefined ? {} : { archivedBefore }),
      });
    }
    if (result.ok) {
      sendJson(res, 200, {
        ok: true,
        instanceId: result.instanceId,
        report: result.report,
      });
      return true;
    }
    const status = result.code === "E002" ? 400 : result.code === "E403" ? 409 : 500;
    sendJson(res, status, {
      error: result.error ?? "memory-action-failed",
      userHint: result.userHint,
    });
    return true;
  }

  if (path === "/api/memory/rebuild-index") {
    if (deps.m6WritesEnabled !== true) {
      sendJson(res, 404, { error: "not-found" });
      return true;
    }
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skills === undefined) {
      sendJson(res, 503, { error: "skills-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const instanceId =
      typeof body["instanceId"] === "string" && body["instanceId"] !== ""
        ? body["instanceId"]
        : undefined;
    const query = instanceId === undefined ? {} : { instanceId };
    const result = await deps.skills.rebuildIndex(query);
    if (result.ok) {
      sendJson(res, 200, {
        ok: true,
        instanceId: result.instanceId,
        report: result.report,
      });
      return true;
    }
    const status = result.code === "E002" ? 400 : result.code === "E403" ? 409 : 500;
    sendJson(res, status, {
      error: result.error ?? "memory-rebuild-index-failed",
      userHint: result.userHint,
    });
    return true;
  }

  if (path === "/api/memory/export") {
    if (deps.m6WritesEnabled !== true) {
      sendJson(res, 404, { error: "not-found" });
      return true;
    }
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skills === undefined) {
      sendJson(res, 503, { error: "skills-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const instanceId =
      typeof body["instanceId"] === "string" && body["instanceId"] !== ""
        ? body["instanceId"]
        : undefined;
    const passphrase = typeof body["passphrase"] === "string" ? body["passphrase"] : "";
    const result = await deps.skills.exportEncrypted(
      instanceId === undefined ? {} : { instanceId },
      passphrase,
    );
    if (!result.ok) {
      const status =
        result.code === "passphrase-too-short" ||
        result.code === "memory-store-not-found" ||
        result.code === "E002"
          ? 400
          : 500;
      sendJson(res, status, {
        error: result.error ?? "memory-export-failed",
        userHint: result.userHint,
      });
      return true;
    }
    sendBytes(res, result.filename ?? "butler-memory-export.abmem", result.data ?? new Uint8Array());
    return true;
  }

  if (path === "/api/memory/self-check") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.memorySelfCheck === undefined) {
      sendJson(res, 503, { error: "memory-self-check-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const instanceId =
      typeof body["instanceId"] === "string" && body["instanceId"] !== ""
        ? body["instanceId"]
        : undefined;
    const outcome = await deps.memorySelfCheck(instanceId);
    if (!outcome.ok) {
      sendJson(res, 503, { error: outcome.error ?? outcome.code });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      instanceId: outcome.instanceId,
      result: outcome.result,
    });
    return true;
  }

  return false;
}
