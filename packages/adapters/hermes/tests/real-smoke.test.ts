import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detect } from "../src/detect.js";
import { createHermesAdapter } from "../src/index.js";
import { logSources } from "../src/log-sources.js";

/**
 * 真实实例冒烟：对 WSL 内 /home/jiach/.hermes（Hermes v0.20.4 宿主进程形态）实际探测。
 * 默认跳过；以 RUN_REAL_SMOKE=1 vitest run 显式启用（普通 vitest run 不含本组）。
 * 本组全部只读（detect/logSources/validateConfig），严禁对真实实例执行 start/stop/snapshot 写操作。
 */
const enabled = !!process.env["RUN_REAL_SMOKE"];
const realRoot = join(homedir(), ".hermes");

describe.skipIf(!enabled)("hermes real smoke (~/.hermes)", () => {
  it("detect 发现真实实例：confidence≥0.6、version=0.20.4、runtime=process", async () => {
    const r = await detect();
    expect(r.ok).toBe(true);
    const inst = r.data?.find((i) => i.rootPath === realRoot);
    expect(inst).toBeDefined();
    expect(inst!.confidence).toBeGreaterThanOrEqual(0.6);
    expect(inst!.version).toBe("0.20.4");
    expect(inst!.runtime).toBe("process");
    expect(inst!.evidence.length).toBeGreaterThan(0);
    expect(inst!.evidence).toContain("pyproject.toml version=0.20.4");
  });

  it("logSources 枚举真实日志（非空、id 前缀正确）", () => {
    const sources = logSources(realRoot);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((s) => s.id.startsWith("hermes:logs:") && s.format === "text")).toBe(true);
  });

  it("validateConfig 只读冒烟：返回 Result ok 且结构合法（违例与否取决于真实配置）", async () => {
    const { control } = createHermesAdapter();
    const r = await control!.validateConfig({ instanceId: "hermes-main", rootPath: realRoot });
    expect(r.ok).toBe(true);
    expect(typeof r.durationMs).toBe("number");
    const v = r.data!;
    expect(typeof v.passed).toBe("boolean");
    expect(Array.isArray(v.violations)).toBe(true);
    for (const violation of v.violations) {
      expect(typeof violation.invariant).toBe("string");
      expect(["block", "warn"]).toContain(violation.severity);
      expect(typeof violation.detail).toBe("string");
    }
    expect(v.passed).toBe(!v.violations.some((x) => x.severity === "block"));
  });
});
