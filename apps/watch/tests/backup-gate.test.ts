import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCore } from "@butler/core";
import { createBackupGate } from "../src/backup-gate.js";

describe("createBackupGate", () => {
  it("creates one baseline per stable fingerprint and persists bypass outside backups", async () => {
    const root = mkdtempSync(join(tmpdir(), "watch-backup-gate-"));
    const home = join(root, "home");
    const instanceRoot = join(root, "hermes");
    mkdirSync(instanceRoot, { recursive: true });
    writeFileSync(join(instanceRoot, "config.yaml"), "models: {}\n");
    const core = createCore({ home });
    let calls = 0;
    const backup = {
      async run() { calls += 1; return { id: 7 }; },
    } as never;
    try {
      const gate = createBackupGate({ core, backup, stateDir: join(home, "data-guard") });
      const input = { instanceId: "hermes-main", framework: "hermes", version: "1.0.0", rootPath: instanceRoot, operation: "upgrade" as const };
      const first = await gate.ensure(input);
      expect(first.status).toBe("created");
      gate.bypass({ ...input, operation: "runbook" }, "已人工保存");
      const second = await gate.ensure({ ...input, operation: "runbook" });
      expect(second.status).toBe("bypassed");
      expect(calls).toBe(1);
    } finally {
      core.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
