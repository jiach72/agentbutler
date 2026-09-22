import { describe, expect, it } from "vitest";
import { createMem0MemoryDriver } from "../src/drivers/mem0-memory.js";

describe("createMem0MemoryDriver", () => {
  it("可根据 mock fetch 获取 stats 与 preview 列表", async () => {
    const mockMemories = [
      {
        id: "mem-1",
        memory: "用户偏好深色模式并配置了思源黑体",
        created_at: "2026-09-20T10:00:00Z",
        updated_at: "2026-09-21T12:00:00Z",
        categories: ["preferences"],
      },
      {
        id: "mem-2",
        memory: "完成 WSL 与 Docker 部署流程验证",
        created_at: "2026-09-22T08:00:00Z",
        categories: ["operations"],
      },
    ];

    const driver = createMem0MemoryDriver({
      baseUrl: "http://127.0.0.1:8888",
      fetchFn: async (_url, _init) => {
        return {
          ok: true,
          status: 200,
          json: async () => mockMemories,
        };
      },
    });

    const scope = { instance: { framework: "hermes" as const, id: "test" }, rootPath: "/tmp/mock-hermes" };

    // 1. stats
    const statsRes = await driver.stats(scope);
    expect(statsRes.ok).toBe(true);
    if (statsRes.ok) {
      expect(statsRes.data.totalEntries).toBe(2);
      expect(statsRes.data.lastWriteAt).toBe("2026-09-22T08:00:00.000Z");
      expect(statsRes.data.byMonth.length).toBeGreaterThanOrEqual(1);
    }

    // 2. preview
    const previewRes = await driver.preview(scope, { keyword: "WSL" });
    expect(previewRes.ok).toBe(true);
    if (previewRes.ok) {
      expect(previewRes.data.length).toBe(2);
      expect(previewRes.data[0]?.content).toContain("深色模式");
      expect(previewRes.data[1]?.content).toContain("WSL");
    }

    // 3. health analysis
    const healthRes = await driver.analyze(scope);
    expect(healthRes.ok).toBe(true);
    if (healthRes.ok) {
      expect(healthRes.data.signals.length).toBeGreaterThanOrEqual(1);
      expect(healthRes.data.score).toBeGreaterThanOrEqual(90);
    }

    // 4. 写操作只读保护
    const archiveRes = await driver.archiveCold(scope, {});
    expect(archiveRes.ok).toBe(false);
    if (!archiveRes.ok) {
      expect(archiveRes.error.code).toBe("E403");
    }
  });

  it("当服务离线时优雅返回 E302 错误并附带可操作提示", async () => {
    const driver = createMem0MemoryDriver({
      baseUrl: "http://127.0.0.1:8888",
      fetchFn: async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:8888");
      },
    });

    const scope = { instance: { framework: "hermes" as const, id: "test" }, rootPath: "/tmp/mock-hermes" };
    const statsRes = await driver.stats(scope);
    expect(statsRes.ok).toBe(false);
    if (!statsRes.ok) {
      expect(statsRes.error.code).toBe("E302");
      expect(statsRes.error.userHint).toContain("Mem0");
    }
  });
});
