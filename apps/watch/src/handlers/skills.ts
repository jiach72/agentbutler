import type { SkillHubSortBy } from "../skillhub.js";
import { SkillsManagerError } from "../skills-manager.js";
import { readGithubToken, writeGithubToken } from "../github-token.js";
import {
  type RequestContext,
  readJsonBody,
  sendJson,
  skillInstallStatus,
} from "../http-common.js";

export async function handleSkills(ctx: RequestContext): Promise<boolean> {
  const { deps, req, res, url, path, method } = ctx;

  if (path === "/api/skills") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skills === undefined) {
      sendJson(res, 503, { error: "skills-unavailable" });
      return true;
    }
    const instanceId = url.searchParams.get("instanceId")?.trim() || undefined;
    const keyword = url.searchParams.get("keyword")?.trim() || undefined;
    const limitRaw = url.searchParams.get("limit");
    let limit: number | undefined;
    if (limitRaw !== null) {
      limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit <= 0) {
        sendJson(res, 400, { error: "invalid-limit" });
        return true;
      }
    }
    const status = await deps.skills.status({
      ...(instanceId === undefined ? {} : { instanceId }),
      ...(keyword === undefined ? {} : { keyword }),
      ...(limit === undefined ? {} : { limit }),
    });
    if (deps.skillAssets !== undefined) {
      const usage = await deps.skillAssets.usage(180, "day");
      const byName = new Map(usage.skills.map((item) => [item.name, item]));
      status.skills.items = status.skills.items.map((item) => {
        const observed = byName.get(item.name);
        return observed === undefined
          ? item
          : {
              ...item,
              usage: observed.calls,
              lastUsedAt: observed.lastUsedAt,
              successRate: observed.successRate,
              avgDurationMs: observed.avgDurationMs,
              usageCoverage: usage.coverage,
            };
      });
    }
    sendJson(res, 200, status);
    return true;
  }

  if (path === "/api/skills/usage") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skillAssets === undefined) {
      sendJson(res, 503, { error: "skill-assets-unavailable" });
      return true;
    }
    const range = Number(url.searchParams.get("range")?.replace(/d$/, "") ?? "180");
    const requestedGranularity = url.searchParams.get("granularity");
    const granularity =
      requestedGranularity === "week" || requestedGranularity === "month" ? requestedGranularity : "day";
    sendJson(
      res,
      200,
      await deps.skillAssets.usage([30, 90, 180].includes(range) ? range : 180, granularity),
    );
    return true;
  }

  const skillLifecycle = /^\/api\/skills\/([^/]+)\/(archive|restore|purge)$/.exec(path);
  if (skillLifecycle !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skillAssets === undefined) {
      sendJson(res, 503, { error: "skill-assets-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const name = decodeURIComponent(skillLifecycle[1]!);
    const action = skillLifecycle[2]!;
    const result =
      action === "archive"
        ? await deps.skillAssets.archive(name, typeof body["thresholdDays"] === "number" ? body["thresholdDays"] : 90)
        : action === "restore"
          ? await deps.skillAssets.restore(name)
          : await deps.skillAssets.purge(name, body["confirmed"] === true);
    sendJson(res, result.ok === true ? 200 : 409, result);
    return true;
  }

  if (path === "/api/skills/github-trends") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skillAssets === undefined) {
      sendJson(res, 503, { error: "skill-assets-unavailable" });
      return true;
    }
    sendJson(
      res,
      200,
      await deps.skillAssets.githubTrends({
        filter: url.searchParams.get("filter") ?? undefined,
        sort: url.searchParams.get("sort") ?? undefined,
      }),
    );
    return true;
  }

  if (path === "/api/skills/github-trends/refresh") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skillAssets === undefined) {
      sendJson(res, 503, { error: "skill-assets-unavailable" });
      return true;
    }
    sendJson(res, 200, await deps.skillAssets.refreshGithubTrends());
    return true;
  }

  if (path === "/api/skills/recommendations") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skillAssets === undefined) {
      sendJson(res, 503, { error: "skill-assets-unavailable" });
      return true;
    }
    sendJson(res, 200, await deps.skillAssets.recommendations());
    return true;
  }

  const stageMatch = /^\/api\/skills\/recommendations\/([^/]+)\/stage$/.exec(path);
  if (stageMatch !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skillAssets === undefined) {
      sendJson(res, 503, { error: "skill-assets-unavailable" });
      return true;
    }
    const result = await deps.skillAssets.stageRecommendation(decodeURIComponent(stageMatch[1]!));
    sendJson(res, result.ok === true ? 200 : 409, result);
    return true;
  }

  const installMatch = /^\/api\/skills\/staged\/([^/]+)\/install$/.exec(path);
  if (installMatch !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skillAssets === undefined) {
      sendJson(res, 503, { error: "skill-assets-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const result = await deps.skillAssets.installStaged(
      decodeURIComponent(installMatch[1]!),
      body["confirmed"] === true,
      body["overwrite"] === true,
    );
    sendJson(res, skillInstallStatus(result), result);
    return true;
  }

  // 本机技能（Hermes 技能目录为唯一事实来源）：清单 / 删除 / 更新检查 / 更新落位。
  if (path === "/api/skills/local") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skillAssets === undefined) {
      sendJson(res, 503, { error: "skill-assets-unavailable" });
      return true;
    }
    sendJson(res, 200, await deps.skillAssets.listLocal());
    return true;
  }

  if (path === "/api/skills/local/updates") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skillAssets === undefined) {
      sendJson(res, 503, { error: "skill-assets-unavailable" });
      return true;
    }
    sendJson(res, 200, await deps.skillAssets.checkLocalUpdates());
    return true;
  }

  const localActionMatch = /^\/api\/skills\/local\/([^/]+)\/(remove|update)$/.exec(path);
  if (localActionMatch !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skillAssets === undefined) {
      sendJson(res, 503, { error: "skill-assets-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const name = decodeURIComponent(localActionMatch[1]!);
    const confirmed = body["confirmed"] === true;
    const result =
      localActionMatch[2] === "remove"
        ? await deps.skillAssets.removeLocal(name, confirmed)
        : await deps.skillAssets.updateLocal(name, confirmed);
    sendJson(res, result.ok === true ? 200 : 409, result);
    return true;
  }

  if (path === "/api/skills/git/stage") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skillAssets === undefined) {
      sendJson(res, 503, { error: "skill-assets-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const urlParam = typeof body["url"] === "string" ? body["url"].trim() : "";
    if (urlParam === "") {
      sendJson(res, 400, { error: "missing-url" });
      return true;
    }
    const result = await deps.skillAssets.stageGitSource(urlParam);
    sendJson(res, result.ok === true ? 200 : 409, result);
    return true;
  }

  // SkillHub（skillhub.cn Open API）
  if (path === "/api/skillhub/categories") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skillAssets === undefined) {
      sendJson(res, 503, { error: "skill-assets-unavailable" });
      return true;
    }
    sendJson(res, 200, await deps.skillAssets.skillHubCategories());
    return true;
  }

  if (path === "/api/skillhub/skills") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skillAssets === undefined) {
      sendJson(res, 503, { error: "skill-assets-unavailable" });
      return true;
    }
    const sortByRaw = url.searchParams.get("sortBy") ?? "";
    const sortBy: SkillHubSortBy = (["updated_at", "downloads", "stars", "installs", "score"] as const).includes(
      sortByRaw as SkillHubSortBy,
    )
      ? (sortByRaw as SkillHubSortBy)
      : "downloads";
    const pageRaw = Number(url.searchParams.get("page") ?? "1");
    const pageSizeRaw = Number(url.searchParams.get("pageSize") ?? "24");
    sendJson(
      res,
      200,
      await deps.skillAssets.skillHubList({
        keyword: url.searchParams.get("keyword") ?? undefined,
        category: url.searchParams.get("category") ?? undefined,
        sortBy,
        page: Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1,
        pageSize: Number.isInteger(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(pageSizeRaw, 50) : 24,
      }),
    );
    return true;
  }

  const skillHubStageMatch = /^\/api\/skillhub\/skills\/([^/]+)\/stage$/.exec(path);
  if (skillHubStageMatch !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skillAssets === undefined) {
      sendJson(res, 503, { error: "skill-assets-unavailable" });
      return true;
    }
    const result = await deps.skillAssets.stageSkillHub(decodeURIComponent(skillHubStageMatch[1]!));
    sendJson(res, result.ok === true ? 200 : 409, result);
    return true;
  }

  // 技能库管理器（skills-manager CLI 集成）
  if (path === "/api/skills-manager/status") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skillsManager === undefined) {
      sendJson(res, 503, { error: "skills-manager-unavailable" });
      return true;
    }
    sendJson(res, 200, await deps.skillsManager.status());
    return true;
  }

  if (path === "/api/skills-manager/updates") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skillsManager === undefined) {
      sendJson(res, 503, { error: "skills-manager-unavailable" });
      return true;
    }
    sendJson(res, 200, await deps.skillsManager.check());
    return true;
  }

  if (path === "/api/skills-manager/install") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skillsManager === undefined) {
      sendJson(res, 503, { error: "skills-manager-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const source = typeof body["source"] === "string" ? body["source"].trim() : "";
    if (source === "") {
      sendJson(res, 400, { error: "missing-source" });
      return true;
    }
    const name = typeof body["name"] === "string" && body["name"].trim() !== "" ? body["name"] : undefined;
    const sourceTypeRaw = typeof body["sourceType"] === "string" ? body["sourceType"] : "";
    const sourceType =
      sourceTypeRaw === "skills" || sourceTypeRaw === "local" || sourceTypeRaw === "git"
        ? sourceTypeRaw
        : undefined;
    const result = await deps.skillsManager.install({
      source,
      ...(name === undefined ? {} : { name }),
      ...(sourceType === undefined ? {} : { sourceType }),
      confirmed: body["confirmed"] === true,
    });
    sendJson(res, 200, result);
    return true;
  }

  if (path === "/api/skills-manager/search") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skillsManager === undefined) {
      sendJson(res, 503, { error: "skills-manager-unavailable" });
      return true;
    }
    const query = url.searchParams.get("query")?.trim() ?? "";
    if (query === "") {
      sendJson(res, 400, { error: "missing-query" });
      return true;
    }
    const limitRaw = url.searchParams.get("limit");
    let limit: number | undefined;
    if (limitRaw !== null) {
      limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit <= 0) {
        sendJson(res, 400, { error: "invalid-limit" });
        return true;
      }
    }
    sendJson(res, 200, await deps.skillsManager.search({ query, ...(limit === undefined ? {} : { limit }) }));
    return true;
  }

  const skillDetailMatch = /^\/api\/skills-manager\/skills\/([^/]+)$/.exec(path);
  if (skillDetailMatch !== null) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skillsManager === undefined) {
      sendJson(res, 503, { error: "skills-manager-unavailable" });
      return true;
    }
    const name = decodeURIComponent(skillDetailMatch[1]!).trim();
    if (name === "") {
      sendJson(res, 400, { error: "missing-name" });
      return true;
    }
    sendJson(res, 200, await deps.skillsManager.detail(name));
    return true;
  }

  if (path === "/api/skills-manager/tags") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skillsManager === undefined) {
      sendJson(res, 503, { error: "skills-manager-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const action = body["action"];
    if (action !== "add" && action !== "remove" && action !== "set") {
      sendJson(res, 400, { error: "invalid-action" });
      return true;
    }
    const name = typeof body["name"] === "string" ? body["name"].trim() : "";
    if (name === "") {
      sendJson(res, 400, { error: "missing-name" });
      return true;
    }
    const tags = Array.isArray(body["tags"])
      ? body["tags"]
          .filter((tag): tag is string => typeof tag === "string" && tag.trim() !== "")
          .map((tag) => tag.trim())
      : [];
    if (tags.length === 0) {
      sendJson(res, 400, { error: "missing-tags" });
      return true;
    }
    sendJson(res, 200, await deps.skillsManager.tags({ action, name, tags }));
    return true;
  }

  if (path === "/api/skills-manager/set-source") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skillsManager === undefined) {
      sendJson(res, 503, { error: "skills-manager-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const name = typeof body["name"] === "string" ? body["name"].trim() : "";
    if (name === "") {
      sendJson(res, 400, { error: "missing-name" });
      return true;
    }
    const gitUrl = typeof body["gitUrl"] === "string" ? body["gitUrl"].trim() : "";
    if (gitUrl === "") {
      sendJson(res, 400, { error: "missing-git-url" });
      return true;
    }
    const result = await deps.skillsManager.setSource({
      name,
      gitUrl,
      ...(typeof body["subpath"] === "string" && body["subpath"].trim() !== ""
        ? { subpath: body["subpath"].trim() }
        : {}),
      ...(typeof body["branch"] === "string" && body["branch"].trim() !== ""
        ? { branch: body["branch"].trim() }
        : {}),
      force: body["force"] === true,
      confirmed: body["confirmed"] === true,
    });
    sendJson(res, 200, result);
    return true;
  }

  const skillManagerAction = /^\/api\/skills-manager\/(deploy|undeploy|update|remove|adopt)$/.exec(path);
  if (skillManagerAction !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.skillsManager === undefined) {
      sendJson(res, 503, { error: "skills-manager-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const action = skillManagerAction[1]!;
    if (action === "update" && body["all"] === true) {
      sendJson(res, 200, await deps.skillsManager.updateAll());
      return true;
    }
    if (Array.isArray(body["names"])) {
      if (action === "adopt") {
        sendJson(res, 400, { error: "adopt-no-batch" });
        return true;
      }
      const names = [
        ...new Set(
          body["names"]
            .filter((name): name is string => typeof name === "string" && name.trim() !== "")
            .map((name) => name.trim()),
        ),
      ];
      if (names.length === 0) {
        sendJson(res, 400, { error: "missing-names" });
        return true;
      }
      if (names.length > 100) {
        sendJson(res, 400, { error: "too-many-names" });
        return true;
      }
      const confirmed = body["confirmed"] === true;
      const results = [];
      for (const item of names) {
        try {
          const result =
            action === "deploy"
              ? await deps.skillsManager.deploy({ name: item, confirmed })
              : action === "undeploy"
                ? await deps.skillsManager.undeploy({ name: item, confirmed })
                : action === "update"
                  ? await deps.skillsManager.update({ name: item, confirmed })
                  : await deps.skillsManager.remove({ name: item, confirmed });
          results.push({ name: item, ok: true, result });
        } catch (error) {
          results.push({
            name: item,
            ok: false,
            error:
              error instanceof SkillsManagerError
                ? { code: error.code, message: error.message }
                : {
                    code: "skills-manager-cli-failed",
                    message: error instanceof Error ? error.message : String(error),
                  },
          });
        }
      }
      sendJson(res, 200, { batch: true, results });
      return true;
    }
    const requiredKey = action === "adopt" ? "dir" : "name";
    const value = typeof body[requiredKey] === "string" ? body[requiredKey].trim() : "";
    if (value === "") {
      sendJson(res, 400, { error: `missing-${requiredKey}` });
      return true;
    }
    const confirmed = body["confirmed"] === true;
    const result =
      action === "deploy"
        ? await deps.skillsManager.deploy({ name: value, confirmed })
        : action === "undeploy"
          ? await deps.skillsManager.undeploy({ name: value, confirmed })
          : action === "update"
            ? await deps.skillsManager.update({ name: value, confirmed })
            : action === "remove"
              ? await deps.skillsManager.remove({ name: value, confirmed })
              : await deps.skillsManager.adopt({ dir: value, confirmed });
    sendJson(res, 200, result);
    return true;
  }

  if (path === "/api/github-token") {
    if (method !== "GET" && method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.dataDir === undefined) {
      sendJson(res, 503, { error: "github-token-unavailable" });
      return true;
    }
    if (method === "GET") {
      sendJson(res, 200, { configured: readGithubToken(deps.dataDir) !== null });
      return true;
    }
    if (method === "POST") {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      if (body["clear"] === true) {
        writeGithubToken(deps.dataDir, null);
        sendJson(res, 200, { configured: false });
        return true;
      }
      const token = typeof body["token"] === "string" ? body["token"].trim() : "";
      if (token.length < 8 || token.length > 200) {
        sendJson(res, 400, { error: "invalid-github-token", detail: "令牌长度需在 8-200 字符之间。" });
        return true;
      }
      writeGithubToken(deps.dataDir, token);
      sendJson(res, 200, { configured: true });
      return true;
    }
  }

  return false;
}
