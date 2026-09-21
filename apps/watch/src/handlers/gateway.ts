import {
  type RequestContext,
  readJsonBody,
  sendJson,
} from "../http-common.js";

export async function handleGateway(ctx: RequestContext): Promise<boolean> {
  const { deps, req, res, path, method } = ctx;

  if (path === "/api/gateway/stats") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.gateway === undefined) {
      sendJson(res, 503, { error: "gateway-unavailable" });
      return true;
    }
    sendJson(res, 200, { stats: await deps.gateway.stats() });
    return true;
  }

  if (path === "/api/gateway/patches") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.gateway === undefined) {
      sendJson(res, 503, { error: "gateway-unavailable" });
      return true;
    }
    sendJson(res, 200, { patches: await deps.gateway.patches() });
    return true;
  }

  const patchPreviewMatch = /^\/api\/gateway\/patches\/([^/]+)\/preview$/.exec(path);
  if (patchPreviewMatch !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.gateway === undefined) {
      sendJson(res, 503, { error: "gateway-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const rawParams = body["params"];
    const params =
      rawParams !== null && typeof rawParams === "object" && !Array.isArray(rawParams)
        ? (Object.fromEntries(
            Object.entries(rawParams as Record<string, unknown>).filter(([, value]) => typeof value === "number"),
          ) as Record<string, number>)
        : undefined;
    const outcome = await deps.gateway.previewPatch({
      patchId: decodeURIComponent(patchPreviewMatch[1]!),
      params,
      instanceId: typeof body["instanceId"] === "string" ? body["instanceId"] : undefined,
    });
    if (outcome.status === "ok") {
      sendJson(res, 200, { preview: outcome.preview });
      return true;
    }
    if (outcome.status === "unknown-patch") {
      sendJson(res, 404, { error: "unknown-patch" });
      return true;
    }
    sendJson(res, 503, { error: "no-instance" });
    return true;
  }

  const patchActionMatch = /^\/api\/gateway\/patches\/([^/]+)\/(apply|reapply|detect)$/.exec(path);
  if (patchActionMatch !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.gateway === undefined) {
      sendJson(res, 503, { error: "gateway-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const id = decodeURIComponent(patchActionMatch[1]!);
    const action = patchActionMatch[2]!;
    const instanceId =
      typeof body["instanceId"] === "string" && body["instanceId"] !== ""
        ? body["instanceId"]
        : undefined;

    if (action === "detect") {
      const outcome = await deps.gateway.detectPatch({ patchId: id, instanceId });
      if (outcome.status === "ok") {
        sendJson(res, 200, { report: outcome.report });
        return true;
      }
      if (outcome.status === "unknown-patch") {
        sendJson(res, 404, { error: "unknown-patch" });
        return true;
      }
      sendJson(res, 503, { error: "no-instance" });
      return true;
    }

    const rawParams = body["params"];
    let params: Record<string, number> | undefined;
    if (rawParams !== undefined) {
      if (rawParams === null || typeof rawParams !== "object" || Array.isArray(rawParams)) {
        sendJson(res, 400, {
          error: "invalid-params",
          detail: "params 必须是对象（参数名 → 数值）",
        });
        return true;
      }
      for (const [key, value] of Object.entries(rawParams as Record<string, unknown>)) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          sendJson(res, 400, {
            error: "invalid-params",
            detail: `参数 params.${key} 必须是数值`,
          });
          return true;
        }
      }
      params = rawParams as Record<string, number>;
    }

    const outcome =
      action === "apply"
        ? await deps.gateway.applyPatch({ patchId: id, params, instanceId })
        : await deps.gateway.reapplyPatch({ patchId: id, params, instanceId });
    if (outcome.status === "ok") {
      sendJson(res, 200, {
        status: "ok",
        result: outcome.result,
        targetPath: outcome.targetPath,
        params: outcome.params,
      });
      return true;
    }
    if (outcome.status === "unknown-patch") {
      sendJson(res, 404, { error: "unknown-patch" });
      return true;
    }
    if (outcome.status === "invalid-params") {
      sendJson(res, 400, { error: "invalid-params", detail: outcome.error });
      return true;
    }
    if (outcome.status === "patch-conflict") {
      sendJson(res, 409, { error: "patch-conflict", detail: outcome.error });
      return true;
    }
    if (outcome.status === "config-blocked") {
      sendJson(res, 409, { error: "config-invariants-blocked", detail: outcome.error });
      return true;
    }
    sendJson(res, 503, { error: "no-instance" });
    return true;
  }

  return false;
}
