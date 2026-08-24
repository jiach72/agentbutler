import { describe, expect, it } from "vitest";
import { detectPlatform, majorVersion } from "../src/platform.js";
import { fakeExec } from "./helpers.js";

const LINUX_PROC_VERSION = "Linux version 6.8.0 (gcc 13.2.0) #1 SMP PREEMPT_DYNAMIC";
const WSL_PROC_VERSION = "Linux version 5.15.153.1-microsoft-standard-WSL2 (root@f123) #1 SMP";

describe("detectPlatform 平台检测", () => {
  it("普通 linux：docker/compose 可用、Node 22 满足", async () => {
    const { exec } = fakeExec();
    const report = await detectPlatform(exec, {
      nodeVersion: "22.11.0",
      env: {},
      readFile: () => LINUX_PROC_VERSION,
    });
    expect(report.os).toBe(process.platform);
    expect(report.arch).toBe(process.arch);
    expect(report.isWsl).toBe(false);
    expect(report.wslEvidence).toEqual([]);
    expect(report.nodeSatisfied).toBe(true);
    expect(report.nodeRequirement).toBe(">=22");
    expect(report.dockerAvailable).toBe(true);
    expect(report.dockerComposeAvailable).toBe(true);
  });

  it("WSL 判定：/proc/version 含 microsoft", async () => {
    const { exec } = fakeExec();
    const report = await detectPlatform(exec, {
      nodeVersion: "22.11.0",
      env: {},
      readFile: (p) => (p === "/proc/version" ? WSL_PROC_VERSION : ""),
    });
    expect(report.isWsl).toBe(true);
    expect(report.wslEvidence).toContain("/proc/version 含 microsoft");
  });

  it("WSL 判定：WSL_DISTRO_NAME 环境变量（darwin 无 /proc/version）", async () => {
    const { exec } = fakeExec();
    const report = await detectPlatform(exec, {
      nodeVersion: "22.11.0",
      env: { WSL_DISTRO_NAME: "Ubuntu-24.04" },
      readFile: () => "",
    });
    expect(report.isWsl).toBe(true);
    expect(report.wslEvidence).toContain("WSL_DISTRO_NAME=Ubuntu-24.04");
  });

  it("docker version 退出码非零 → dockerAvailable false（compose 独立判定）", async () => {
    const { exec } = fakeExec((command, args) =>
      args[0] === "compose" ? { code: 0, stdout: "Docker Compose version v2.29.0", stderr: "" } : { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" },
    );
    const report = await detectPlatform(exec, { nodeVersion: "22.11.0", env: {}, readFile: () => LINUX_PROC_VERSION });
    expect(report.dockerAvailable).toBe(false);
    expect(report.dockerComposeAvailable).toBe(true);
  });

  it("docker CLI 不存在（退出码 127）→ 双双不可用", async () => {
    const { exec } = fakeExec(() => ({ code: 127, stdout: "", stderr: "docker: command not found" }));
    const report = await detectPlatform(exec, { nodeVersion: "22.11.0", env: {}, readFile: () => LINUX_PROC_VERSION });
    expect(report.dockerAvailable).toBe(false);
    expect(report.dockerComposeAvailable).toBe(false);
  });

  it("docker 探测使用短超时", async () => {
    const { exec, calls } = fakeExec();
    await detectPlatform(exec, { nodeVersion: "22.11.0", env: {}, readFile: () => LINUX_PROC_VERSION });
    expect(calls.map((c) => c.opts?.timeoutMs)).toEqual([5000, 5000]);
    expect(calls[0]).toMatchObject({ command: "docker", args: ["version"] });
    expect(calls[1]).toMatchObject({ command: "docker", args: ["compose", "version"] });
  });

  it("Node 版本不足（18.x）→ nodeSatisfied false", async () => {
    const { exec } = fakeExec();
    const report = await detectPlatform(exec, {
      nodeVersion: "18.17.0",
      env: {},
      readFile: () => LINUX_PROC_VERSION,
    });
    expect(report.nodeSatisfied).toBe(false);
    expect(report.nodeVersion).toBe("18.17.0");
  });

  it("majorVersion 解析：v 前缀与异常输入", () => {
    expect(majorVersion("v22.1.0")).toBe(22);
    expect(majorVersion("20.11.1")).toBe(20);
    expect(majorVersion("")).toBe(0);
  });
});
