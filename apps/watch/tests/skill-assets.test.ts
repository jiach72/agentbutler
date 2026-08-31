import { createCore } from "@butler/core";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillAssetService } from "../src/skill-assets.js";

describe("技能资产 GitHub 阶段化下载", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  const makeService = (fetch: (input: string | URL, init?: RequestInit) => Promise<Response>, githubToken?: string) => {
    const home = mkdtempSync(join(tmpdir(), "butler-skill-assets-test-"));
    homes.push(home);
    const core = createCore({ home });
    return { core, service: createSkillAssetService({ core, skills: {} as never, fetch, ...(githubToken === undefined ? {} : { githubToken }) }) };
  };

  it("将 GitHub API 限流 403 转成可执行提示，并携带客户端标识", async () => {
    let requestHeaders: HeadersInit | undefined;
    const { core, service } = makeService(async (_input, init) => {
      requestHeaders = init?.headers;
      return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 403,
        headers: { "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1788142042" },
      });
    });
    try {
      const result = await service.stageRecommendation("github:anthropics/skills");
      expect(result).toMatchObject({
        ok: false,
        error: "github-rate-limit",
        detail: "GitHub 公共 API 当前已达到请求限额。",
      });
      expect(String(new Headers(requestHeaders).get("User-Agent"))).toBe("agent-butler/1.0.0-beta.17");
      expect(new Headers(requestHeaders).get("Authorization")).toBeNull();
    } finally {
      core.close();
    }
  });

  it("使用可选 GitHub Token 阶段化有效 SKILL.md", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const { core, service } = makeService(async (input, init) => {
      const url = String(input);
      requests.push({ url, headers: new Headers(init?.headers) });
      if (url.includes("/git/trees/HEAD")) {
        return new Response(JSON.stringify({ tree: [{ type: "blob", path: "skills/demo/SKILL.md" }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ encoding: "base64", content: Buffer.from("---\nname: demo\n---\n\nhello\n", "utf8").toString("base64") }), { status: 200, headers: { "content-type": "application/json" } });
    }, "ghp_test-token");
    try {
      const result = await service.stageRecommendation("github:anthropics/skills");
      expect(result).toMatchObject({ ok: true, status: "staged", sourcePath: "skills/demo/SKILL.md" });
      expect(requests).toHaveLength(2);
      expect(requests[0]!.headers.get("User-Agent")).toBe("agent-butler/1.0.0-beta.17");
      expect(requests[0]!.headers.get("Authorization")).toBe("Bearer ghp_test-token");
      const stageId = String((result as { id: string }).id);
      expect(readFileSync(join(homeOf(core), "skill-assets", "staged", stageId, "SKILL.md"), "utf8")).toContain("name: demo");
    } finally {
      core.close();
    }
  });
});

function homeOf(core: { paths: { home: string } }): string {
  return core.paths.home;
}
