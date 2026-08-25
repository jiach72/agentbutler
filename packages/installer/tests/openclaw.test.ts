import { describe, expect, it } from "vitest";
import { installHostForm, isOpenClawNodeSatisfied } from "../src/install.js";
import { parseArgs } from "../src/main.js";
import { fakeExec, fakePlan } from "./helpers.js";

describe("OpenClaw 一键安装路径", () => {
  it("dry-run 生成官方 npm/setup/validate/doctor 步骤", async () => {
    const { exec, calls } = fakeExec();
    const result = await installHostForm(fakePlan({ platform: { nodeVersion: "24.15.0" } }), {
      framework: "openclaw",
      exec,
      dryRun: true,
      repoDir: "/repo",
    });
    expect(result.framework).toBe("openclaw");
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(0);
    expect(result.steps.map((step) => step.id)).toEqual([
      "node-check",
      "openclaw-install",
      "openclaw-setup",
      "openclaw-config-validate",
      "openclaw-doctor",
      "openclaw-status",
      "pip-mirror",
      "corepack-enable",
      "repo-install",
      "repo-build",
      "services-guide",
    ]);
  });

  it("Node 版本门禁拒绝 OpenClaw 不支持的版本", async () => {
    const { exec } = fakeExec();
    const result = await installHostForm(fakePlan({ platform: { nodeVersion: "24.14.1" } }), {
      framework: "openclaw",
      exec,
    });
    expect(result.success).toBe(false);
    expect(result.steps[0]?.detail).toContain("OpenClaw");
    expect(isOpenClawNodeSatisfied("22.22.3")).toBe(true);
    expect(isOpenClawNodeSatisfied("25.8.0")).toBe(false);
  });

  it("CLI 接受 OpenClaw 的替代 Web 端口并拒绝非法端口", () => {
    expect(parseArgs(["--framework", "openclaw", "--form", "docker", "--web-port", "17531"])).toMatchObject({
      framework: "openclaw",
      form: "docker",
      webHostPort: 17531,
    });
    expect(parseArgs(["--web-port=0"]).error).toContain("1-65535");
  });
});
