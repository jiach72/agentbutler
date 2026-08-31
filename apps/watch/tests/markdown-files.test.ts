import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCore, type Core } from "@butler/core";
import { createHermesAdapter } from "@butler/adapter-hermes";
import { createMarkdownFileService, type MarkdownFileService } from "../src/markdown-files.js";
import type { BackupGate } from "../src/backup-gate.js";

const roots: string[] = [];
const make = (): { core: Core; service: MarkdownFileService; root: string } => {
  const root = mkdtempSync(join(tmpdir(), "butler-markdown-"));
  roots.push(root);
  const home = join(root, "butler");
  const core = createCore({ home });
  const adapter = createHermesAdapter();
  expect(core.registry.register(adapter).ok).toBe(true);
  expect(core.instances.createInstance({ instanceId: "hermes-test", frameworkId: "hermes", rootPath: root, runtime: "process" }).ok).toBe(true);
  const backupGate: BackupGate = {
    fingerprint: () => "fp",
    bypass: () => ({ allowed: true, status: "bypassed", fingerprint: "fp", detail: "test" }),
    ensure: async () => ({ allowed: true, status: "existing", fingerprint: "fp", detail: "test" }),
  };
  return { core, service: createMarkdownFileService({ core, backupGate }), root };
};

afterEach(() => {
  // Core closes the sqlite handle; temporary folders are left to the OS test runner.
});

describe("核心 Markdown 文件管理", () => {
  it("发现固定文件并把 memory 标记为只读", () => {
    const { core, service, root } = make();
    writeFileSync(join(root, "USER.md"), "name: Ada\n");
    writeFileSync(join(root, "MEMORY.md"), "runtime memory\n");
    const files = service.list("hermes-test");
    expect(files.find((file) => file.key === "user")?.exists).toBe(true);
    expect(files.find((file) => file.key === "memory")).toMatchObject({ exists: true, editable: false });
    core.close();
  });

  it("预览无副作用，确认后原子保存旧版本", async () => {
    const { core, service, root } = make();
    writeFileSync(join(root, "SOUL.md"), "old\n");
    const file = service.list("hermes-test").find((item) => item.key === "soul")!;
    const preview = service.preview(file.fileId, "new\n", file.sha256!);
    expect(preview.canApply).toBe(true);
    expect(readFileSync(join(root, "SOUL.md"), "utf8")).toBe("old\n");
    const applied = await service.apply(file.fileId, { content: "new\n", baseSha256: file.sha256!, confirmed: true });
    expect(readFileSync(join(root, "SOUL.md"), "utf8")).toBe("new\n");
    expect(service.revisions(file.fileId)).toHaveLength(1);
    expect(applied.revision.sha256).toBe(file.sha256);
    core.close();
  });

  it("检测外部修改并拒绝覆盖", async () => {
    const { core, service, root } = make();
    writeFileSync(join(root, "AGENTS.md"), "before\n");
    const file = service.list("hermes-test").find((item) => item.key === "agent")!;
    writeFileSync(join(root, "AGENTS.md"), "outside\n");
    await expect(service.apply(file.fileId, { content: "mine\n", baseSha256: file.sha256!, confirmed: true })).rejects.toMatchObject({ code: "markdown-conflict" });
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("outside\n");
    core.close();
  });
});
