import { afterEach, describe, expect, it } from "vitest";
import { startWatchHttp, type WatchHttp, type WatchHttpDeps } from "../src/http.js";
import type { SkillAssetService } from "../src/skill-assets.js";
import type { SkillsMemoryService } from "../src/skills.js";

function makeDeps(assets?: SkillAssetService): WatchHttpDeps {
  const skills: SkillsMemoryService = {
    status: async () => ({}) as never,
    analyze: async () => ({ ok: false, instanceId: null }),
    archiveCold: async () => ({ ok: false, instanceId: null }),
    restoreCold: async () => ({ ok: false, instanceId: null }),
    purge: async () => ({ ok: false, instanceId: null }),
    rebuildIndex: async () => ({ ok: false, instanceId: null }),
    exportEncrypted: async () => ({ ok: false, instanceId: null }),
  };
  return { skills, ...(assets === undefined ? {} : { skillAssets: assets }) } as unknown as WatchHttpDeps;
}

describe("startWatchHttp SkillHub 端点", () => {
  let http: WatchHttp;
  let base: string;

  const start = async (assets?: SkillAssetService) => {
    http = startWatchHttp(makeDeps(assets), { port: 0 });
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;
  };

  afterEach(() => http.close());

  it("GET 分类与列表透传查询参数，未接线返回 503", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await start({
      skillHubCategories: async () => ({ items: [{ key: "office-efficiency", name: "办公效率", nameEn: null }], syncedAt: "2026-09-01T00:00:00.000Z" }),
      skillHubList: async (query) => {
        seen.push(query);
        return { total: 1, page: 2, pageSize: 5, items: [] };
      },
      stageSkillHub: async () => ({ ok: true }),
    } as unknown as SkillAssetService);
    const categories = await fetch(`${base}/api/skillhub/categories`);
    expect(categories.status).toBe(200);
    await expect(categories.json()).resolves.toMatchObject({ items: [{ key: "office-efficiency" }] });

    const list = await fetch(`${base}/api/skillhub/skills?keyword=pdf&category=office-efficiency&sortBy=score&page=2&pageSize=5`);
    expect(list.status).toBe(200);
    expect(seen[0]).toMatchObject({ keyword: "pdf", category: "office-efficiency", sortBy: "score", page: 2, pageSize: 5 });
    // 非法 sortBy / 越界 pageSize 归一到安全默认值。
    await fetch(`${base}/api/skillhub/skills?sortBy=evil&pageSize=999`);
    expect(seen[1]).toMatchObject({ sortBy: "downloads", pageSize: 50 });

    http.close();
    await start(undefined);
    expect((await fetch(`${base}/api/skillhub/categories`)).status).toBe(503);
    expect((await fetch(`${base}/api/skillhub/skills`)).status).toBe(503);
  });

  it("POST stage：成功 200、失败 409、方法不允许 405", async () => {
    await start({
      skillHubCategories: async () => ({ items: [] }),
      skillHubList: async () => ({ total: 0, items: [] }),
      stageSkillHub: async (slug) =>
        slug === "blocked-skill"
          ? { ok: false, error: "skill-md-missing", fix: "该技能包缺少 SKILL.md，无法安装。" }
          : { ok: true, id: "stage-1", status: "staged", slug, risk: { status: "clear" } },
    } as unknown as SkillAssetService);
    const ok = await fetch(`${base}/api/skillhub/skills/demo/stage`, { method: "POST" });
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toMatchObject({ ok: true, slug: "demo" });

    const blocked = await fetch(`${base}/api/skillhub/skills/blocked-skill/stage`, { method: "POST" });
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({ ok: false, error: "skill-md-missing" });

    expect((await fetch(`${base}/api/skillhub/skills/demo/stage`, { method: "GET" })).status).toBe(405);
  });
});
