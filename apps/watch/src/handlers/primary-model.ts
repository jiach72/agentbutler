import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { atomicWriteText } from "@butler/core";
import {
  type RequestContext,
  readJsonBody,
  sendJson,
} from "../http-common.js";

/**
 * Hermes 主模型 (Primary Model) 控制接口：
 * - GET /api/models/primary: 读取当前 ~/.hermes/config.yaml 中配置的主模型
 * - POST /api/models/primary: 安全更新主模型（带时间戳备份），同步写入 .env 与实例绑定
 */
export async function handlePrimaryModel(ctx: RequestContext): Promise<boolean> {
  const { deps, req, res, path, method, credentialWritesAllowed } = ctx;

  if (path !== "/api/models/primary") {
    return false;
  }

  const hermesRoot =
    deps.hermesRoot ??
    process.env["BUTLER_HERMES_ROOT"] ??
    process.env["HERMES_ROOT"] ??
    "/home/butler/hermes";
  const configPath = join(hermesRoot, "config.yaml");

  // 1. GET /api/models/primary
  if (method === "GET") {
    let provider = "deepseek";
    let model = "deepseek-chat";
    let endpoint = "";

    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, "utf8");
        const parsed = (parseYaml(raw) as Record<string, unknown>) || {};
        const modelCfg =
          typeof parsed["model"] === "object" && parsed["model"] !== null
            ? (parsed["model"] as Record<string, unknown>)
            : {};
        provider = String(modelCfg["provider"] || "").trim() || provider;
        model = String(modelCfg["default"] || modelCfg["model"] || "").trim() || model;
        endpoint = String(modelCfg["base_url"] || modelCfg["baseUrl"] || "").trim();

        // 检查 custom_providers 补全 endpoint
        const custom = Array.isArray(parsed["custom_providers"]) ? parsed["custom_providers"] : [];
        for (const item of custom) {
          if (typeof item !== "object" || item === null) continue;
          const rec = item as Record<string, unknown>;
          const itemProvider = String(rec["provider"] || rec["name"] || "").trim();
          const itemModel = String(rec["model"] || rec["default"] || "").trim();
          if (
            (provider && itemProvider.toLowerCase() === provider.toLowerCase()) ||
            (model && itemModel.toLowerCase() === model.toLowerCase())
          ) {
            endpoint = endpoint || String(rec["base_url"] || rec["baseUrl"] || "").trim();
            break;
          }
        }
      } catch {
        // parse error fallback to defaults
      }
    }

    const isLocal = provider.toLowerCase() === "ollama" || /11434/.test(endpoint);
    const costCategory = isLocal ? "free" : "standard";

    sendJson(res, 200, {
      ok: true,
      primary: {
        provider,
        model,
        endpoint,
        source: isLocal ? "ollama" : "credential",
        category: isLocal ? "local" : "cloud",
        costCategory,
        configPath,
      },
    });
    return true;
  }

  // 2. POST /api/models/primary
  if (method === "POST") {
    if (!credentialWritesAllowed) {
      sendJson(res, 403, { error: "credential-writes-require-loopback" });
      return true;
    }

    const body = await readJsonBody(req, res);
    if (body === null) return true;

    const provider = String(body["provider"] || "").trim();
    const model = String(body["model"] || "").trim();
    const endpoint = typeof body["endpoint"] === "string" ? body["endpoint"].trim() : "";
    const source = typeof body["source"] === "string" ? body["source"] : "credential";
    const envVar = typeof body["envVar"] === "string" ? body["envVar"].trim() : undefined;
    const apiKey = typeof body["apiKey"] === "string" ? body["apiKey"].trim() : undefined;
    const restartNow = body["restartNow"] === true;

    if (!provider || !model) {
      sendJson(res, 400, { error: "invalid-primary-model", detail: "provider 和 model 均不能为空" });
      return true;
    }

    // A. 自动安全备份与更新 config.yaml
    try {
      mkdirSync(dirname(configPath), { recursive: true });
      let origConfig: Record<string, unknown> = {};

      if (existsSync(configPath)) {
        const origText = readFileSync(configPath, "utf8");
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupPath = `${configPath}.bak-butler-${stamp}`;
        copyFileSync(configPath, backupPath);

        try {
          origConfig = (parseYaml(origText) as Record<string, unknown>) || {};
        } catch {
          origConfig = {};
        }
      }

      const newConfig = { ...origConfig };
      const modelObj =
        typeof newConfig["model"] === "object" && newConfig["model"] !== null
          ? { ...(newConfig["model"] as Record<string, unknown>) }
          : {};

      modelObj["provider"] = provider;
      modelObj["default"] = model;
      if (endpoint) {
        modelObj["base_url"] = endpoint;
      } else {
        delete modelObj["base_url"];
      }
      newConfig["model"] = modelObj;

      // 若为 Ollama 或自定义 Provider，确保 custom_providers 同步注册
      if (provider.toLowerCase() === "ollama") {
        const custom = Array.isArray(newConfig["custom_providers"])
          ? [...(newConfig["custom_providers"] as Array<Record<string, unknown>>)]
          : [];
        const existingIdx = custom.findIndex(
          (p) => p && String(p["provider"]).toLowerCase() === "ollama",
        );
        const ollamaEntry: Record<string, unknown> = {
          provider: "ollama",
          base_url: endpoint || "http://ollama:11434/v1",
          model,
        };
        if (existingIdx >= 0) {
          custom[existingIdx] = ollamaEntry;
        } else {
          custom.push(ollamaEntry);
        }
        newConfig["custom_providers"] = custom;
      }

      atomicWriteText(configPath, stringifyYaml(newConfig), {
        mode: 0o644,
        description: "更新 Hermes 主模型",
      });

      // B. 若提供了 API Key / envVar，同步写入 .env
      if (envVar && apiKey) {
        const envPath = join(hermesRoot, ".env");
        let envContent = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
        const reg = new RegExp(`^${envVar}=.*$`, "m");
        if (reg.test(envContent)) {
          envContent = envContent.replace(reg, `${envVar}=${apiKey}`);
        } else {
          envContent = `${envContent.trimEnd()}\n${envVar}=${apiKey}\n`;
        }
        atomicWriteText(envPath, envContent, { mode: 0o600, description: "更新 Hermes 模型 API Key" });
      }

      // C. 尝试同步登记至 Butler 实例绑定 (Instance Default)
      if (deps.llm) {
        try {
          const profiles = deps.llm.listProfiles();
          let matchedProfile = profiles.find(
            (p) => p.model === model && p.provider.toLowerCase() === provider.toLowerCase(),
          );

          if (!matchedProfile && apiKey) {
            matchedProfile = await deps.llm.createProfile({
              profileId: `primary-${provider}-${model.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
              provider,
              protocol: "openai-compatible",
              endpoint: endpoint || "https://api.openai.com/v1",
              model,
              apiKey,
            });
          }

          if (matchedProfile) {
            deps.llm.addBinding({
              bindingId: `bind-primary-${Date.now()}`,
              scope: "instance",
              instanceId: "hermes-main",
              frameworkId: "hermes",
              profileId: matchedProfile.profileId,
            });
          }
        } catch {
          // 尽力而为：绑定即使失败不影响 config.yaml 更新
        }
      }

      // D. 审计记录
      deps.audit?.append({
        actor: "panel",
        action: "primary-model-updated",
        target: "hermes",
        detail: { provider, model, endpoint, source, restartNow },
      });

      // E. 立即优雅重启（面板勾选 restartNow 时）：与 memory apply 走同一
      //    rb-restart 通道。config.yaml 已落盘，重启失败不回滚——Hermes 下次
      //    重载自然生效；响应带 restarted 供面板如实反馈（修复 P1 空开关）。
      let restarted = false;
      if (restartNow) {
        try {
          const restartRes = await deps.executeRunbook("rb-restart");
          restarted = restartRes.status === "started";
        } catch {
          // restart best effort
        }
      }

      sendJson(res, 200, {
        ok: true,
        restarted,
        primary: {
          provider,
          model,
          endpoint,
          source,
          category: provider.toLowerCase() === "ollama" ? "local" : "cloud",
          costCategory: provider.toLowerCase() === "ollama" ? "free" : "standard",
        },
      });
      return true;
    } catch (error) {
      sendJson(res, 500, {
        error: "primary-model-update-failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  sendJson(res, 405, { error: "method-not-allowed" });
  return true;
}
