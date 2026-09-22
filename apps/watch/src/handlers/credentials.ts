import {
  API_CREDENTIAL_PRESETS,
  type ApiCredentialCategory,
} from "@butler/core";
import {
  type RequestContext,
  readJsonBody,
  sendJson,
} from "../http-common.js";
import { probeApiKey } from "../probes/api-key-probes.js";

export async function handleCredentials(ctx: RequestContext): Promise<boolean> {
  const { deps, req, res, path, method, credentialWritesAllowed } = ctx;

  if (!path.startsWith("/api/credentials")) {
    return false;
  }

  const credService = deps.apiKeyCredentials;
  if (!credService) {
    sendJson(res, 503, { error: "api-credentials-service-unavailable" });
    return true;
  }

  // 1. GET /api/credentials
  if (path === "/api/credentials" && method === "GET") {
    const list = credService.listCredentials();
    sendJson(res, 200, {
      credentials: list,
      presets: API_CREDENTIAL_PRESETS,
    });
    return true;
  }

  // 2. POST /api/credentials/test (测试探针，无需事先保存)
  if (path === "/api/credentials/test" && method === "POST") {
    if (!credentialWritesAllowed) {
      sendJson(res, 403, { error: "credential-writes-require-loopback" });
      return true;
    }

    const body = await readJsonBody(req, res);
    if (body === null) return true;

    const provider = typeof body["provider"] === "string" ? body["provider"].trim() : "";
    const apiKey = typeof body["apiKey"] === "string" ? body["apiKey"].trim() : "";
    const endpoint = typeof body["endpoint"] === "string" ? body["endpoint"].trim() : null;

    if (!provider || !apiKey) {
      sendJson(res, 400, { error: "missing-provider-or-key" });
      return true;
    }

    const probe = await probeApiKey(provider, apiKey, { endpoint });
    sendJson(res, 200, { probe });
    return true;
  }

  // 3. POST /api/credentials/sync (手动全量对齐 ~/.hermes/.env)
  if (path === "/api/credentials/sync" && method === "POST") {
    if (!credentialWritesAllowed) {
      sendJson(res, 403, { error: "credential-writes-require-loopback" });
      return true;
    }

    if (!deps.hermesRoot) {
      sendJson(res, 400, { error: "hermes-root-not-configured" });
      return true;
    }

    try {
      const result = await credService.syncToHermesEnv(deps.hermesRoot);
      sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  // 4. POST /api/credentials/:id/probe (针对已有受管密钥测试连通性)
  const probeMatch = /^\/api\/credentials\/([^/]+)\/probe$/.exec(path);
  if (probeMatch && method === "POST") {
    const id = decodeURIComponent(probeMatch[1]!);
    const list = credService.listCredentials();
    const item = list.find((c) => c.id === id);
    if (!item) {
      sendJson(res, 404, { error: "credential-not-found" });
      return true;
    }

    const decryptedKey = credService.getDecryptedKey(id);
    if (!decryptedKey) {
      sendJson(res, 500, { error: "unable-to-decrypt-key" });
      return true;
    }

    const probe = await probeApiKey(item.provider, decryptedKey, {
      endpoint: item.endpoint,
    });
    credService.updateProbe(id, probe.status, probe.category, probe.detail);

    sendJson(res, 200, { probe });
    return true;
  }

  // 5. POST /api/credentials (保存/创建密钥，安全门禁)
  if (path === "/api/credentials" && method === "POST") {
    if (!credentialWritesAllowed) {
      sendJson(res, 403, { error: "credential-writes-require-loopback" });
      return true;
    }

    const body = await readJsonBody(req, res);
    if (body === null) return true;

    const name = typeof body["name"] === "string" ? body["name"].trim() : "";
    const category = body["category"] as ApiCredentialCategory;
    const envVar = typeof body["envVar"] === "string" ? body["envVar"].trim().toUpperCase() : "";
    const provider = typeof body["provider"] === "string" ? body["provider"].trim() : "";
    const apiKey = typeof body["apiKey"] === "string" ? body["apiKey"].trim() : "";
    const endpoint = typeof body["endpoint"] === "string" ? body["endpoint"].trim() : null;
    const id = typeof body["id"] === "string" && body["id"].trim() !== "" ? body["id"].trim() : undefined;

    if (!name || !category || !envVar || !provider || !apiKey) {
      sendJson(res, 400, { error: "invalid-credential-payload" });
      return true;
    }

    try {
      const saved = credService.saveCredential({
        id,
        name,
        category,
        envVar,
        provider,
        endpoint,
        apiKey,
      });

      // 自动安全同步回写至 ~/.hermes/.env
      if (deps.hermesRoot) {
        try {
          await credService.syncToHermesEnv(deps.hermesRoot);
        } catch {
          // 同步失败不阻断凭据已持久化事实，但记录日志
        }
      }

      sendJson(res, 201, { credential: saved });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  // 6. DELETE /api/credentials/:id (删除密钥，安全门禁)
  const deleteMatch = /^\/api\/credentials\/([^/]+)$/.exec(path);
  if (deleteMatch && method === "DELETE") {
    if (!credentialWritesAllowed) {
      sendJson(res, 403, { error: "credential-writes-require-loopback" });
      return true;
    }

    const id = decodeURIComponent(deleteMatch[1]!);
    const list = credService.listCredentials();
    const item = list.find((c) => c.id === id);
    const deleted = credService.deleteCredential(id);
    if (!deleted) {
      sendJson(res, 404, { error: "credential-not-found" });
      return true;
    }

    if (item && deps.hermesRoot) {
      try {
        credService.removeEnvVarFromHermesEnv(deps.hermesRoot, item.envVar);
      } catch {
        // 尽力而为
      }
    }

    sendJson(res, 200, { ok: true });
    return true;
  }

  sendJson(res, 405, { error: "method-not-allowed" });
  return true;
}
