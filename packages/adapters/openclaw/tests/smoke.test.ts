import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenClawAdapter, detect } from "../src/index.js";
import { isOpenClawNodeSatisfied } from "../../../installer/src/install.js";

const tempDirs: string[] = [];
function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "butler-openclaw-"));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, "workspace", "skills", "hello"), { recursive: true });
  fs.mkdirSync(path.join(root, "workspace", "memory"), { recursive: true });
  fs.mkdirSync(path.join(root, "state", "logs"), { recursive: true });
  fs.writeFileSync(path.join(root, "openclaw.json"), "{\"gateway\":{\"port\":18789}}\n");
  fs.writeFileSync(path.join(root, "workspace", "skills", "hello", "SKILL.md"), "---\nname: hello\nversion: 1.0.0\nsource: user\n---\n# Hello\n");
  fs.writeFileSync(path.join(root, "workspace", "MEMORY.md"), "remember this\n");
  fs.writeFileSync(path.join(root, "state", "logs", "gateway.log"), "ready\n");
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("OpenClaw adapter L0-L2", () => {
  it("detects baseline root and exposes no messaging capability", async () => {
    const root = fixture();
    const result = await detect({ rootPath: root });
    expect(result.ok).toBe(true);
    expect(result.data?.[0]).toMatchObject({ instanceId: "openclaw-main", rootPath: root, runtime: "process" });
    const adapter = createOpenClawAdapter();
    const scan = await adapter.discovery.capabilityScan({ instanceId: "openclaw-main", rootPath: root });
    expect(scan.data?.effectiveLevel).toBe(2);
    expect(scan.data?.capabilities.messaging).toBe("not-implemented");
  });

  it("enumerates skills, markdown memory and logs as read-only surfaces", async () => {
    const root = fixture();
    const adapter = createOpenClawAdapter();
    const scope = { instance: { instanceId: "openclaw-main", rootPath: root }, rootPath: root };
    const skills = await adapter.drivers!.skill!.enumerate(scope);
    expect(skills.data?.[0]?.name).toBe("hello");
    const memory = await adapter.drivers!.memory!.preview(scope, { keyword: "remember" });
    expect(memory.data).toHaveLength(1);
    expect(adapter.discovery.logSources({ instanceId: "openclaw-main", rootPath: root })[0]?.format).toBe("text");
    const write = await adapter.drivers!.skill!.setEnabled({ name: "hello" }, false);
    expect(write.ok).toBe(false);
    expect(write.error?.code).toBe("E403");
  });

  it("executes config validation and snapshot/rollback through injected commands", async () => {
    const root = fixture();
    const calls: Array<{ command: string; args: string[] }> = [];
    const adapter = createOpenClawAdapter({
      snapshotsDir: path.join(root, "snapshots"),
      exec: async (command, args) => {
        calls.push({ command, args });
        return { code: 0, stdout: JSON.stringify({ valid: true }), stderr: "" };
      },
    });
    const ref = { instanceId: "openclaw-main", rootPath: root };
    const validated = await adapter.control!.validateConfig(ref);
    expect(validated.data?.passed).toBe(true);
    const snapshot = await adapter.control!.snapshot(ref, { include: ["config"], label: "test" });
    expect(snapshot.ok).toBe(true);
    expect(calls.some((call) => call.command === "openclaw" && call.args.join(" ").includes("config validate"))).toBe(true);
    expect(isOpenClawNodeSatisfied("24.15.0")).toBe(true);
    expect(isOpenClawNodeSatisfied("22.22.2")).toBe(false);
  });

  it("M4 快照覆盖 OpenClaw workspace 资产并登记 snapshotId", async () => {
    const root = fixture();
    const snapshotsDir = path.join(root, "snapshots");
    const records: Array<{ instanceId: string; scope: { include: string[]; label?: string }; snapshotId: string }> = [];
    const adapter = createOpenClawAdapter({
      snapshotsDir,
      snapshotRecorder: (input) => records.push(input),
    });

    const result = await adapter.control!.snapshot(
      { instanceId: "openclaw-main", rootPath: root },
      { include: ["skills", "memory"], label: "pre-evolution" },
    );

    expect(result.ok).toBe(true);
    expect(result.data?.steps).toEqual([
      { id: "copy-skills", label: "复制 skills", status: "passed" },
      { id: "copy-memory", label: "复制 memory", status: "passed" },
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      instanceId: "openclaw-main",
      scope: { include: ["skills", "memory"], label: "pre-evolution" },
    });
    const snapshotId = records[0]!.snapshotId;
    expect(fs.existsSync(path.join(snapshotsDir, snapshotId, "skills", "hello", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(snapshotsDir, snapshotId, "memory", "workspace", "MEMORY.md"))).toBe(true);
  });

  it("M4 快照回滚按 manifest 恢复 skills 与 memory 原始路径", async () => {
    const root = fixture();
    const snapshotsDir = path.join(root, "snapshots");
    let snapshotId = "";
    const adapter = createOpenClawAdapter({
      snapshotsDir,
      snapshotRecorder: (input) => {
        snapshotId = input.snapshotId;
      },
    });
    const ref = { instanceId: "openclaw-main", rootPath: root };
    const snapshot = await adapter.control!.snapshot(ref, {
      include: ["skills", "memory"],
      label: "pre-evolution",
    });
    expect(snapshot.ok).toBe(true);
    expect(snapshotId).not.toBe("");

    fs.writeFileSync(
      path.join(root, "workspace", "skills", "hello", "SKILL.md"),
      "changed\n",
    );
    fs.writeFileSync(path.join(root, "workspace", "MEMORY.md"), "changed-memory\n");
    const rollback = await adapter.control!.rollback(ref, { snapshotId });

    expect(rollback.ok).toBe(true);
    expect(
      fs.readFileSync(path.join(root, "workspace", "skills", "hello", "SKILL.md"), "utf8"),
    ).toContain("name: hello");
    expect(fs.readFileSync(path.join(root, "workspace", "MEMORY.md"), "utf8")).toBe(
      "remember this\n",
    );
  });

  it("升级前快照存在缺失资产时 fail-closed，不执行 npm 安装", async () => {
    const root = fixture();
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const calls: Array<{ command: string; args: string[] }> = [];
    const adapter = createOpenClawAdapter({
      snapshotsDir: path.join(root, "snapshots"),
      exec: async (command, args) => {
        calls.push({ command, args });
        if (command === "openclaw" && args[0] === "--version") {
          return { code: 0, stdout: "1.2.3", stderr: "" };
        }
        if (command === "openclaw" && args[0] === "config") {
          return { code: 0, stdout: JSON.stringify({ valid: true }), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    const result = await adapter.control!.upgrade(
      { instanceId: "openclaw-main", rootPath: root },
      { version: "2.0.0" },
      { idempotencyKey: "upgrade-missing-snapshot-asset" },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("升级前快照未完成");
    expect(calls.some((call) => call.command === "npm")).toBe(false);
  });

  it("start/restart 在配置不变式失败时 fail-closed，不执行 gateway 命令", async () => {
    const root = fixture();
    const calls: Array<{ command: string; args: string[] }> = [];
    const adapter = createOpenClawAdapter({
      exec: async (command, args) => {
        calls.push({ command, args });
        if (command === "openclaw" && args[0] === "config") {
          return { code: 0, stdout: JSON.stringify({ valid: false, errors: ["gateway token missing"] }), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const result = await adapter.control!.start({ instanceId: "openclaw-main", rootPath: root });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("E203");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: "openclaw", args: ["config", "validate", "--json"] });
  });

  it("upgrade 成功：记录当前版本、快照、npm 安装并校验，按幂等键缓存 Job", async () => {
    const root = fixture();
    const calls: Array<{ command: string; args: string[] }> = [];
    const adapter = createOpenClawAdapter({
      snapshotsDir: path.join(root, "snapshots"),
      exec: async (command, args) => {
        calls.push({ command, args });
        if (command === "openclaw" && args[0] === "--version") return { code: 0, stdout: "OpenClaw 1.2.3\n", stderr: "" };
        if (command === "openclaw" && args[0] === "config") return { code: 0, stdout: JSON.stringify({ valid: true }), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const ref = { instanceId: "openclaw-main", rootPath: root };
    const first = await adapter.control!.upgrade(ref, { version: "2.0.0" }, { idempotencyKey: "upgrade-success" });
    const second = await adapter.control!.upgrade(ref, { version: "2.0.0" }, { idempotencyKey: "upgrade-success" });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.data?.jobId).toBe(first.data?.jobId);
    expect(calls.map((call) => `${call.command} ${call.args.join(" ")}`)).toEqual([
      "openclaw config validate --json",
      "openclaw --version",
      "npm install --global openclaw@2.0.0",
      "openclaw config validate --json",
    ]);
  });

  it("npm 安装失败：恢复快照文件和旧 npm 包，并明确自动回滚", async () => {
    const root = fixture();
    const snapshotsDir = path.join(root, "snapshots");
    const calls: Array<{ command: string; args: string[] }> = [];
    const adapter = createOpenClawAdapter({
      snapshotsDir,
      exec: async (command, args) => {
        calls.push({ command, args });
        if (command === "openclaw" && args[0] === "config") return { code: 0, stdout: JSON.stringify({ valid: true }), stderr: "" };
        if (command === "openclaw" && args[0] === "--version") return { code: 0, stdout: "1.2.3\n", stderr: "" };
        if (command === "npm" && args.at(-1) === "openclaw@2.0.0") {
          fs.writeFileSync(path.join(root, "openclaw.json"), "{\"gateway\":{\"port\":19999}}\n");
          return { code: 1, stdout: "", stderr: "registry unavailable" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const result = await adapter.control!.upgrade(
      { instanceId: "openclaw-main", rootPath: root },
      { version: "2.0.0" },
      { idempotencyKey: "upgrade-install-fail" },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("E203");
    expect(result.error?.message).toContain("已自动回滚");
    expect(fs.readFileSync(path.join(root, "openclaw.json"), "utf8")).toContain("18789");
    expect(calls.map((call) => `${call.command} ${call.args.join(" ")}`)).toEqual([
      "openclaw config validate --json",
      "openclaw --version",
      "npm install --global openclaw@2.0.0",
      "npm install --global openclaw@1.2.3",
    ]);
  });

  it("升级后配置校验返回 valid=false：自动回滚而不是误报成功", async () => {
    const root = fixture();
    const calls: Array<{ command: string; args: string[] }> = [];
    const adapter = createOpenClawAdapter({
      snapshotsDir: path.join(root, "snapshots"),
      exec: async (command, args) => {
        calls.push({ command, args });
        if (command === "openclaw" && args[0] === "--version") return { code: 0, stdout: "1.2.3", stderr: "" };
        if (command === "openclaw" && args[0] === "config") {
          const validationCount = calls.filter((call) => call.command === "openclaw" && call.args[0] === "config").length;
          return validationCount === 1
            ? { code: 0, stdout: JSON.stringify({ valid: true }), stderr: "" }
            : { code: 0, stdout: JSON.stringify({ valid: false, errors: ["gateway token missing"] }), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const result = await adapter.control!.upgrade(
      { instanceId: "openclaw-main", rootPath: root },
      { version: "2.0.0" },
      { idempotencyKey: "upgrade-invalid-config" },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("配置不满足安全不变式");
    expect(result.error?.message).toContain("已自动回滚");
    expect(calls.filter((call) => call.command === "npm")).toHaveLength(2);
  });

  it("升级后配置校验输出损坏：自动回滚并返回可诊断错误", async () => {
    const root = fixture();
    const calls: Array<{ command: string; args: string[] }> = [];
    const adapter = createOpenClawAdapter({
      snapshotsDir: path.join(root, "snapshots"),
      exec: async (command, args) => {
        calls.push({ command, args });
        if (command === "openclaw" && args[0] === "config") {
          const count = calls.filter((call) => call.command === "openclaw" && call.args[0] === "config").length;
          return count === 1
            ? { code: 0, stdout: JSON.stringify({ valid: true }), stderr: "" }
            : { code: 0, stdout: "not-json", stderr: "" };
        }
        if (command === "openclaw" && args[0] === "--version") return { code: 0, stdout: "1.2.3", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const result = await adapter.control!.upgrade(
      { instanceId: "openclaw-main", rootPath: root },
      { version: "2.0.0" },
      { idempotencyKey: "upgrade-invalid-json" },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("配置校验失败");
    expect(result.error?.message).toContain("已自动回滚");
    expect(calls.filter((call) => call.command === "npm")).toHaveLength(2);
  });

  it("skipSnapshot：失败时不调用旧版本恢复，也不声称已自动回滚", async () => {
    const root = fixture();
    const calls: Array<{ command: string; args: string[] }> = [];
    const adapter = createOpenClawAdapter({
      exec: async (command, args) => {
        calls.push({ command, args });
        if (command === "openclaw" && args[0] === "config") return { code: 0, stdout: JSON.stringify({ valid: true }), stderr: "" };
        if (command === "openclaw" && args[0] === "--version") return { code: 0, stdout: "1.2.3", stderr: "" };
        if (command === "npm") return { code: 1, stdout: "", stderr: "install failed" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const result = await adapter.control!.upgrade(
      { instanceId: "openclaw-main", rootPath: root },
      { version: "2.0.0" },
      { idempotencyKey: "upgrade-no-snapshot", skipSnapshot: true },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("未创建升级前快照");
    expect(result.error?.message).not.toContain("已自动回滚");
    expect(calls.filter((call) => call.command === "npm")).toHaveLength(1);
  });

  it("自动回滚的旧包恢复失败：返回 E204 并提示人工介入", async () => {
    const root = fixture();
    const adapter = createOpenClawAdapter({
      snapshotsDir: path.join(root, "snapshots"),
      exec: async (command, args) => {
        if (command === "openclaw" && args[0] === "config") return { code: 0, stdout: JSON.stringify({ valid: true }), stderr: "" };
        if (command === "openclaw" && args[0] === "--version") return { code: 0, stdout: "1.2.3", stderr: "" };
        if (command === "npm" && args.at(-1) === "openclaw@2.0.0") return { code: 1, stdout: "", stderr: "target install failed" };
        if (command === "npm" && args.at(-1) === "openclaw@1.2.3") return { code: 1, stdout: "", stderr: "rollback install failed" };
        return { code: 0, stdout: JSON.stringify({ valid: true }), stderr: "" };
      },
    });
    const result = await adapter.control!.upgrade(
      { instanceId: "openclaw-main", rootPath: root },
      { version: "2.0.0" },
      { idempotencyKey: "upgrade-rollback-fail" },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("E204");
    expect(result.error?.message).toContain("自动回滚失败，需要人工介入");
  });
});
