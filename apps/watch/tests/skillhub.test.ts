import { createCore } from "@butler/core";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillAssetService, moveDirSync, skillNameFromFrontmatter } from "../src/skill-assets.js";
import { createSkillHubClient, readZipEntries } from "../src/skillhub.js";

describe("skillNameFromFrontmatter", () => {
  it("解析标准 frontmatter：name 位于 --- 下一行（含 CRLF 与 metadata 子块）", () => {
    const raw = '---\nname: self-improvement\ndescription: "d"\nmetadata:\nslug: self-improving-agent\nversion: 3.0.24\n---\n\n正文';
    expect(skillNameFromFrontmatter(raw)).toBe("self-improvement");
    expect(skillNameFromFrontmatter('---\r\nname: weekly-report\r\ndescription: "d"\r\n---\r\nbody')).toBe("weekly-report");
    expect(skillNameFromFrontmatter("---\ndescription: 没有 name\n---\nbody")).toBeNull();
    expect(skillNameFromFrontmatter("没有 frontmatter")).toBeNull();
  });
});

describe("moveDirSync 跨挂载回退", () => {
  const makeTempDirs = () => {
    const base = mkdtempSync(join(tmpdir(), "butler-move-test-"));
    return { base, from: join(base, "from-dir"), to: join(base, "to-dir") };
  };
  const cleanup = (base: string) => rmSync(base, { recursive: true, force: true });

  it("rename 成功时直接落位（不复制）", () => {
    const { base, from, to } = makeTempDirs();
    try {
      mkdirSync(join(from, "sub"), { recursive: true });
      writeFileSync(join(from, "SKILL.md"), "hello", "utf8");
      writeFileSync(join(from, "sub", "a.md"), "a", "utf8");
      moveDirSync(from, to);
      expect(existsSync(join(to, "SKILL.md"))).toBe(true);
      expect(existsSync(join(to, "sub", "a.md"))).toBe(true);
      expect(existsSync(from)).toBe(false);
    } finally {
      cleanup(base);
    }
  });

  it("rename 抛 EXDEV 时复制 + 校验 + 删源；校验失败回滚目标并保留源", () => {
    const { base, from, to } = makeTempDirs();
    const exdev = () => {
      throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
    };
    try {
      mkdirSync(from, { recursive: true });
      writeFileSync(join(from, "SKILL.md"), "hello", "utf8");
      moveDirSync(from, to, { rename: exdev, verify: verifySkillDirForTest });
      expect(existsSync(join(to, "SKILL.md"))).toBe(true);
      expect(existsSync(from)).toBe(false);

      // 第二轮：verify 失败 → 目标副本被清理，源保留（可重试）。
      rmSync(to, { recursive: true, force: true });
      mkdirSync(from, { recursive: true });
      writeFileSync(join(from, "OTHER.md"), "x", "utf8");
      expect(() => moveDirSync(from, to, { rename: exdev, verify: verifySkillDirForTest })).toThrow(/SKILL\.md/);
      expect(existsSync(to)).toBe(false);
      expect(existsSync(join(from, "OTHER.md"))).toBe(true);
    } finally {
      cleanup(base);
    }
  });

  it("非 EXDEV 的 rename 错误原样抛出，不降级复制", () => {
    const { base, from, to } = makeTempDirs();
    const boom = () => {
      throw Object.assign(new Error("eperm"), { code: "EPERM" });
    };
    try {
      mkdirSync(from, { recursive: true });
      expect(() => moveDirSync(from, to, { rename: boom })).toThrow(/eperm/);
      expect(existsSync(to)).toBe(false);
      expect(existsSync(from)).toBe(true);
    } finally {
      cleanup(base);
    }
  });
});

/** 与 skill-assets 内部校验一致的测试替身。 */
function verifySkillDirForTest(target: string): void {
  if (!existsSync(join(target, "SKILL.md"))) throw new Error("落位后缺少 SKILL.md，已回滚");
}

/** 组装最小 deflate zip（本地头 + 中央目录 + EOCD），用于验证读取器的 inflate 分支。 */
function buildDeflateZip(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const deflated = deflateRawSync(file.data);
    const local = new Uint8Array(30 + nameBytes.length + deflated.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(8, 8, true); // deflate
    view.setUint32(18, deflated.length, true);
    view.setUint32(22, file.data.length, true);
    view.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(deflated, 30 + nameBytes.length);
    locals.push(local);
    const central = new Uint8Array(46 + nameBytes.length);
    const cView = new DataView(central.buffer);
    cView.setUint32(0, 0x02014b50, true);
    cView.setUint16(4, 20, true);
    cView.setUint16(6, 20, true);
    cView.setUint16(10, 8, true); // 中央目录布局：8=flags、10=压缩方法
    cView.setUint32(20, deflated.length, true);
    cView.setUint32(24, file.data.length, true);
    cView.setUint16(28, nameBytes.length, true);
    cView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + end.length);
  let cursor = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, cursor); cursor += part.length; }
  return out;
}

describe("SkillHub zip 读取器", () => {
  it("读取 deflate zip 并保留字节内容", () => {
    const zip = buildDeflateZip([
      { name: "SKILL.md", data: new TextEncoder().encode("---\nname: demo\n---\nbody") },
      { name: "references/api.md", data: new TextEncoder().encode("# api") },
    ]);
    const entries = readZipEntries(zip);
    expect(entries.map((entry) => entry.path)).toEqual(["SKILL.md", "references/api.md"]);
    expect(new TextDecoder().decode(entries[0]!.data)).toContain("name: demo");
  });

  it("拒绝路径穿越与超限条目", () => {
    const evil = buildDeflateZip([{ name: "../evil.md", data: new Uint8Array([1]) }]);
    expect(() => readZipEntries(evil)).toThrow(/不安全路径/);
    const two = buildDeflateZip([
      { name: "a.md", data: new Uint8Array([1]) },
      { name: "b.md", data: new Uint8Array([2]) },
    ]);
    expect(() => readZipEntries(two, { maxEntries: 1 })).toThrow(/文件数超过/);
    expect(() => readZipEntries(new Uint8Array([1, 2, 3]))).toThrow(/不是有效的 zip/);
  });
});

describe("SkillHub Open API 客户端", () => {
  it("列表映射信封结构并透传筛选参数", async () => {
    const requests: string[] = [];
    const client = createSkillHubClient({
      fetchImpl: async (input) => {
        const url = String(input);
        requests.push(url);
        return new Response(JSON.stringify({
          code: 0,
          message: "success",
          data: {
            total: 107008,
            skills: [{
              slug: "find-skill-skillhub",
              source: "community",
              iconUrl: null,
              ownerName: "user_1",
              category: "ai-agent",
              name: "find skill",
              description: "English desc",
              description_zh: "在 SkillHub 查找技能",
              version: "1.0.2",
              homepage: "https://api.skillhub.cn/user_1/find-skill-skillhub",
              tags: ["latest"],
              subCategories: [{ key: "agent-tool-use", name: "工具调用" }],
              downloads: 43390,
              stars: 176,
              installs: 0,
              created_at: 1742000000000,
              updated_at: 1742100000000,
              labels: { requires_api_key: "true" },
            }],
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const view = await client.list({ keyword: "find skill", category: "ai-agent", sortBy: "score", page: 2, pageSize: 5 });
    expect(requests[0]).toContain("/api/skills?");
    expect(requests[0]).toContain("keyword=find+skill");
    expect(requests[0]).toContain("category=ai-agent");
    expect(requests[0]).toContain("sortBy=score");
    expect(requests[0]).toContain("page=2");
    expect(view.total).toBe(107008);
    expect(view.items[0]).toMatchObject({
      slug: "find-skill-skillhub",
      description: "在 SkillHub 查找技能",
      requiresApiKey: true,
      updatedAt: "2025-03-16T04:40:00.000Z",
    });
  });

  it("分类带 TTL 缓存，失败返回 error 字段而非抛错", async () => {
    let calls = 0;
    let clock = 1_000_000;
    const client = createSkillHubClient({
      now: () => clock,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 3) return new Response("boom", { status: 500 });
        return new Response(JSON.stringify({
          count: 1,
          items: [{ key: "office-efficiency", level: 1, name: "办公效率", nameEn: "Office Efficiency", sortOrder: 10, active: true }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const first = await client.categories();
    const second = await client.categories();
    expect(calls).toBe(1);
    expect(first.items[0]).toEqual({ key: "office-efficiency", name: "办公效率", nameEn: "Office Efficiency" });
    expect(second.items).toEqual(first.items);
    clock += 7 * 60 * 60 * 1000; // 越过 6h TTL
    await client.categories();
    expect(calls).toBe(2);
    clock += 7 * 60 * 60 * 1000;
    const failed = await client.categories();
    expect(calls).toBe(3);
    expect(failed.items).toEqual([]);
    expect(failed.error).toBe("skillhub-unreachable");
    expect(failed.fix).toContain("稍后重试");
  });

  it("下载失败与超限抛可读错误", async () => {
    const client = createSkillHubClient({
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("missing")) return new Response("{}", { status: 404 });
        if (url.includes("huge")) {
          return new Response(new Uint8Array(60 * 1024 * 1024), { status: 200 });
        }
        return new Response("{}", { status: 500 });
      },
    });
    await expect(client.download("missing")).rejects.toThrow(/不存在/);
    await expect(client.download("huge")).rejects.toThrow(/上限/);
    await expect(client.download("broken")).rejects.toThrow(/HTTP 500/);
  });
});

describe("SkillHub 隔离暂存（stageSkillHub）", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  const makeService = (skillHub: ReturnType<typeof createSkillHubClient>) => {
    const home = mkdtempSync(join(tmpdir(), "butler-skillhub-stage-test-"));
    homes.push(home);
    const core = createCore({ home });
    return { core, home, service: createSkillAssetService({ core, skills: {} as never, skillHub }) };
  };

  const skillHubWith = (zip: Uint8Array | Error) =>
    createSkillHubClient({
      fetchImpl: async () => {
        if (zip instanceof Error) throw zip;
        return new Response(zip, { status: 200 });
      },
    });

  it("下载 zip → 解压 → 风险扫描 → 写入隔离区", async () => {
    const zip = buildDeflateZip([
      { name: "SKILL.md", data: new TextEncoder().encode("---\nname: demo-skill\ndescription: 演示\n---\n安全内容，无外联。") },
      { name: "references/api.md", data: new TextEncoder().encode("# api") },
    ]);
    const { core, home, service } = makeService(skillHubWith(zip));
    try {
      const result = await service.stageSkillHub("demo-skill");
      expect(result).toMatchObject({ ok: true, status: "staged", slug: "demo-skill", name: "demo-skill" });
      const risk = (result as { risk?: { status: string } }).risk;
      expect(risk?.status).toBe("clear");
      const stageId = (result as { id: string }).id;
      const stageDir = join(home, "skill-assets", "staged", stageId);
      expect(existsSync(join(stageDir, "SKILL.md"))).toBe(true);
      expect(existsSync(join(stageDir, "references", "api.md"))).toBe(true);
      const source = JSON.parse(readFileSync(join(stageDir, "source.json"), "utf8")) as Record<string, unknown>;
      expect(source).toMatchObject({ source: "skillhub", slug: "demo-skill" });
      expect(String(source.sourceUrl)).toContain("skillhub.cn/skills/demo-skill");
    } finally {
      core.close();
    }
  });

  it("剥掉唯一顶层目录前缀后仍能定位 SKILL.md；缺 SKILL.md 则拒绝", async () => {
    const nested = buildDeflateZip([
      { name: "pkg/SKILL.md", data: new TextEncoder().encode("---\nname: nested\n---\n内容") },
      { name: "pkg/references/x.md", data: new TextEncoder().encode("x") },
    ]);
    const { core, service, home } = makeService(skillHubWith(nested));
    try {
      const ok = await service.stageSkillHub("nested");
      expect(ok).toMatchObject({ ok: true, name: "nested" });
      const stageDir = join(home, "skill-assets", "staged", (ok as { id: string }).id);
      expect(existsSync(join(stageDir, "references", "x.md"))).toBe(true);
    } finally {
      core.close();
    }

    const flat = buildDeflateZip([{ name: "README.md", data: new TextEncoder().encode("no skill here") }]);
    const second = makeService(skillHubWith(flat));
    try {
      const missing = await second.service.stageSkillHub("no-skill-md");
      expect(missing).toMatchObject({ ok: false, error: "skill-md-missing" });
    } finally {
      second.core.close();
    }
  });

  it("下载失败与非法 slug 分别归一为可执行提示", async () => {
    const failing = makeService(skillHubWith(new Error("network down")));
    try {
      const result = await failing.service.stageSkillHub("any-slug");
      expect(result).toMatchObject({ ok: false, error: "skillhub-download-failed" });
      expect(String((result as { detail?: string }).detail)).toContain("network down");
    } finally {
      failing.core.close();
    }
    const second = makeService(skillHubWith(new Uint8Array([1, 2, 3])));
    try {
      expect(await second.service.stageSkillHub("../escape")).toMatchObject({ ok: false, error: "invalid-slug" });
    } finally {
      second.core.close();
    }
  });
});
