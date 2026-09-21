import { randomUUID } from "node:crypto";
import type { LlmProtocol } from "@butler/core";
import {
  type RequestContext,
  readJsonBody,
  sendJson,
} from "../http-common.js";

export async function handleLlm(ctx: RequestContext): Promise<boolean> {
  const { deps, req, res, url, path, method, credentialWritesAllowed } = ctx;

  if (path === "/api/llm/usage") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.llmUsage === undefined) {
      sendJson(res, 503, { error: "llm-usage-unavailable" });
      return true;
    }
    const daysRaw = Number(url.searchParams.get("days") ?? "7");
    const days = Number.isInteger(daysRaw) && daysRaw >= 1 && daysRaw <= 180 ? daysRaw : 7;
    const view = await deps.llmUsage.usage(days);
    if (view === null) {
      sendJson(res, 503, { error: "llm-usage-unavailable" });
      return true;
    }
    sendJson(res, 200, view);
    return true;
  }

  if (path === "/api/llm/cost/summary") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.llmUsage === undefined) {
      sendJson(res, 503, { error: "llm-usage-unavailable" });
      return true;
    }
    const daysRaw = Number(url.searchParams.get("days") ?? "30");
    const days = Number.isInteger(daysRaw) && daysRaw >= 1 && daysRaw <= 180 ? daysRaw : 30;
    const view = await deps.llmUsage.costSummary(days);
    if (view === null) {
      sendJson(res, 503, { error: "llm-usage-unavailable" });
      return true;
    }
    sendJson(res, 200, view);
    return true;
  }

  if (path === "/api/llm/profiles") {
    if (deps.llm === undefined) {
      sendJson(res, 503, { error: "llm-manager-unavailable" });
      return true;
    }
    if (method === "GET") {
      sendJson(res, 200, { profiles: deps.llm.listProfiles() });
      return true;
    }
    if (!credentialWritesAllowed) {
      sendJson(res, 403, { error: "credential-writes-require-loopback" });
      return true;
    }
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const protocol = body["protocol"];
    if (
      typeof body["provider"] !== "string" ||
      typeof body["endpoint"] !== "string" ||
      body["endpoint"].trim() === "" ||
      typeof body["model"] !== "string" ||
      body["model"].trim() === "" ||
      typeof body["apiKey"] !== "string" ||
      body["apiKey"] === "" ||
      !["openai-compatible", "anthropic", "gemini"].includes(String(protocol))
    ) {
      sendJson(res, 400, { error: "invalid-llm-profile" });
      return true;
    }
    try {
      const provider = body["provider"].trim();
      const endpoint = body["endpoint"].trim();
      const model = body["model"].trim();
      const existing = deps.llm.listProfiles().find(
        (p) => p.provider === provider && p.model === model && p.endpoint === endpoint,
      );
      if (existing !== undefined) {
        sendJson(res, 200, { profile: existing });
        return true;
      }
      const profileId =
        typeof body["profileId"] === "string" && body["profileId"].trim() !== ""
          ? body["profileId"].trim()
          : randomUUID();
      const profile = await deps.llm.createProfile({
        profileId,
        provider,
        protocol: protocol as LlmProtocol,
        endpoint,
        model,
        apiKey: body["apiKey"],
        ...(typeof body["instanceId"] === "string" ? { instanceId: body["instanceId"] } : {}),
      });
      sendJson(res, 201, { profile });
    } catch (error) {
      const code = error instanceof Error ? error.message : "llm-profile-create-failed";
      sendJson(
        res,
        code === "secret-vault-unavailable" ? 503 : code === "profile-not-found" ? 404 : 409,
        { error: code },
      );
    }
    return true;
  }

  if (path === "/api/llm/bindings") {
    if (deps.llm === undefined) {
      sendJson(res, 503, { error: "llm-manager-unavailable" });
      return true;
    }
    if (method === "GET") {
      sendJson(res, 200, { bindings: deps.llm.listBindings() });
      return true;
    }
    if (!credentialWritesAllowed) {
      sendJson(res, 403, { error: "credential-writes-require-loopback" });
      return true;
    }
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    if (
      typeof body["profileId"] !== "string" ||
      !["instance", "framework", "skill", "plugin", "evolution"].includes(String(body["scope"]))
    ) {
      sendJson(res, 400, { error: "invalid-llm-binding" });
      return true;
    }
    try {
      const binding = deps.llm.addBinding({
        bindingId: randomUUID(),
        scope: body["scope"] as "instance" | "framework" | "skill" | "plugin" | "evolution",
        profileId: body["profileId"],
        ...(typeof body["instanceId"] === "string" ? { instanceId: body["instanceId"] } : {}),
        ...(typeof body["frameworkId"] === "string" ? { frameworkId: body["frameworkId"] } : {}),
        ...(typeof body["targetRef"] === "string" ? { targetRef: body["targetRef"] } : {}),
      });
      sendJson(res, 201, { binding });
    } catch (error) {
      const code = error instanceof Error ? error.message : "llm-binding-conflict";
      const status =
        code === "profile-not-found"
          ? 404
          : ["binding-target-required", "binding-instance-required", "binding-framework-required"].includes(code)
            ? 400
            : 409;
      sendJson(res, status, { error: code });
    }
    return true;
  }

  if (path === "/api/llm/status") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.llm === undefined) {
      sendJson(res, 503, { error: "llm-manager-unavailable" });
    } else {
      sendJson(res, 200, deps.llm.status());
    }
    return true;
  }

  const llmProfileAction = /^\/api\/llm\/profiles\/([^/]+)\/(rotate|probe|disable|enable)$/.exec(path);
  if (llmProfileAction !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (!credentialWritesAllowed) {
      sendJson(res, 403, { error: "credential-writes-require-loopback" });
      return true;
    }
    if (deps.llm === undefined) {
      sendJson(res, 503, { error: "llm-manager-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const profileId = decodeURIComponent(llmProfileAction[1]!);
    try {
      if (llmProfileAction[2] === "rotate") {
        if (typeof body["apiKey"] !== "string" || body["apiKey"] === "") {
          sendJson(res, 400, { error: "invalid-api-key" });
          return true;
        }
        sendJson(res, 200, { profile: await deps.llm.rotateProfile(profileId, body["apiKey"]) });
        return true;
      }
      if (llmProfileAction[2] === "probe") {
        sendJson(res, 200, { probe: await deps.llm.probeProfile(profileId) });
        return true;
      }
      if (llmProfileAction[2] === "enable") {
        const outcome = await deps.llm.enableProfile(profileId);
        sendJson(res, 200, outcome);
        return true;
      }
      sendJson(res, 200, { profile: deps.llm.disableProfile(profileId) });
    } catch (error) {
      const code = error instanceof Error ? error.message : "llm-profile-action-failed";
      sendJson(
        res,
        code === "profile-not-found" || code === "profile-version-not-found"
          ? 404
          : code === "secret-vault-unavailable"
            ? 503
            : 409,
        { error: code },
      );
    }
    return true;
  }

  const llmProfileDelete = /^\/api\/llm\/profiles\/([^/]+)$/.exec(path);
  if (llmProfileDelete !== null) {
    if (method !== "DELETE") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (!credentialWritesAllowed) {
      sendJson(res, 403, { error: "credential-writes-require-loopback" });
      return true;
    }
    if (deps.llm === undefined) {
      sendJson(res, 503, { error: "llm-manager-unavailable" });
      return true;
    }
    if (deps.llm.deleteProfile(decodeURIComponent(llmProfileDelete[1]!))) {
      sendJson(res, 204, null);
    } else {
      sendJson(res, 404, { error: "llm-profile-not-found" });
    }
    return true;
  }

  const llmBindingMatch = /^\/api\/llm\/bindings\/([^/]+)$/.exec(path);
  if (llmBindingMatch !== null) {
    if (method !== "DELETE") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.llm === undefined) {
      sendJson(res, 503, { error: "llm-manager-unavailable" });
      return true;
    }
    if (!credentialWritesAllowed) {
      sendJson(res, 403, { error: "credential-writes-require-loopback" });
      return true;
    }
    if (deps.llm.deleteBinding(decodeURIComponent(llmBindingMatch[1]!))) {
      sendJson(res, 204, null);
    } else {
      sendJson(res, 404, { error: "llm-binding-not-found" });
    }
    return true;
  }

  if (path === "/api/llm/discovered") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.llm === undefined || typeof deps.llm.discover !== "function") {
      sendJson(res, 503, { error: "llm-discovery-unavailable" });
      return true;
    }
    sendJson(res, 200, { configs: await deps.llm.discover() });
    return true;
  }

  const discoveredImport = /^\/api\/llm\/discovered\/([^/]+)\/import$/.exec(path);
  if (discoveredImport !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (!credentialWritesAllowed) {
      sendJson(res, 403, { error: "credential-writes-require-loopback" });
      return true;
    }
    if (deps.llm === undefined || typeof deps.llm.importDiscovered !== "function") {
      sendJson(res, 503, { error: "llm-discovery-unavailable" });
      return true;
    }
    try {
      sendJson(res, 201, { profile: await deps.llm.importDiscovered(decodeURIComponent(discoveredImport[1]!)) });
    } catch (error) {
      const code = error instanceof Error ? error.message : "llm-discovery-import-failed";
      sendJson(
        res,
        code === "discovered-config-not-found" ? 404 : code === "secret-vault-unavailable" ? 503 : 409,
        { error: code },
      );
    }
    return true;
  }

  return false;
}
