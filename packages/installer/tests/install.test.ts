import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildComposeOverride, buildHostServiceUnits, buildOpenClawComposeOverride, installDockerForm, installHostForm, resolveCorepackCommand, runInstaller, runMaintenance } from "../src/install.js";
import { fakeExec, fakePlan, fakeProbeFetch, makeTempDir, rmTempDir } from "./helpers.js";

describe("installHostForm 宿主形态", () => {
  it("优先使用 Node 同目录的 Corepack，避免 macOS 后台 shell 丢失 PATH", () => {
    const tmp = makeTempDir();
    try {
      const nodePath = path.join(tmp, process.platform === "win32" ? "node.exe" : "node");
      const corepackPath = path.join(tmp, process.platform === "win32" ? "corepack.cmd" : "corepack");
      fs.writeFileSync(corepackPath, "");
      expect(resolveCorepackCommand(nodePath)).toBe(corepackPath);
    } finally {
      rmTempDir(tmp);
    }
  });

  it("dry-run：步骤序列完整、零命令执行", async () => {
    const { exec, calls } = fakeExec();
    const result = await installHostForm(fakePlan({}), { exec, dryRun: true, repoDir: "/repo" });
    expect(result.steps.map((s) => s.id)).toEqual([
      "node-check",
      "hermes-install",
      "pip-mirror",
      "corepack-enable",
      "repo-install",
      "repo-build",
      "services-guide",
    ]);
    expect(calls).toHaveLength(0);
    expect(result.steps.find((s) => s.id === "hermes-install")!.status).toBe("dry-run");
    expect(result.success).toBe(true);
  });

  it("hermes-install 封装官方脚本管道命令", async () => {
    const { exec } = fakeExec();
    const result = await installHostForm(fakePlan({}), {
      exec,
      dryRun: true,
      repoDir: "/repo",
      hermesInstallUrl: "https://example.com/hermes/install.sh",
    });
    const step = result.steps.find((s) => s.id === "hermes-install")!;
    expect(step.command).toEqual(["bash", "-lc", "curl -fsSL https://example.com/hermes/install.sh | bash"]);
    expect(step.detail).toContain("curl -fsSL https://example.com/hermes/install.sh | bash");
  });

  it("pypi 探测切镜像 → 注入 pip index-url", async () => {
    const { exec, calls } = fakeExec();
    const plan = fakePlan({ pypi: { officialReachable: false, mirrorUsed: true, chosen: "aliyun", chosenUrl: "https://mirrors.aliyun.com/pypi/simple/" } });
    const result = await installHostForm(plan, { exec, repoDir: "/repo" });
    const pipCall = calls.find((c) => c.command === "pip");
    expect(pipCall?.args).toEqual(["config", "set", "global.index-url", "https://mirrors.aliyun.com/pypi/simple/"]);
    expect(result.steps.find((s) => s.id === "pip-mirror")!.status).toBe("ok");
    expect(result.success).toBe(true);
  });

  it("pypi 官方可达 → pip-mirror skipped 且不执行 pip", async () => {
    const { exec, calls } = fakeExec();
    const result = await installHostForm(fakePlan({}), { exec, repoDir: "/repo" });
    const step = result.steps.find((s) => s.id === "pip-mirror")!;
    expect(step.status).toBe("skipped");
    expect(calls.some((c) => c.command === "pip")).toBe(false);
  });

  it("pypi 全部不可达 → 失败中断（含代理建议），后续步骤不执行", async () => {
    const { exec, calls } = fakeExec();
    const plan = fakePlan({
      pypi: { officialReachable: false, mirrorUsed: false, allFailed: true, chosen: null, chosenUrl: null, guidance: "建议设置 HTTPS_PROXY 或手动配置镜像" },
    });
    const result = await installHostForm(plan, { exec, repoDir: "/repo" });
    const ids = result.steps.map((s) => s.id);
    expect(ids).toEqual(["node-check", "hermes-install", "pip-mirror"]);
    expect(result.steps[2]!.status).toBe("failed");
    expect(result.steps[2]!.detail).toContain("HTTPS_PROXY");
    expect(result.success).toBe(false);
    expect(calls.some((c) => c.command === "corepack")).toBe(false);
  });

  it("Node 版本不足 → 首步失败即停、零命令执行", async () => {
    const { exec, calls } = fakeExec();
    const plan = fakePlan({ platform: { nodeSatisfied: false, nodeVersion: "18.17.0" } });
    const result = await installHostForm(plan, { exec, repoDir: "/repo" });
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ id: "node-check", status: "failed" });
    expect(result.steps[0]!.detail).toContain("18.17.0");
    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("真实执行：成功路径执行 pnpm install/build（带 cwd）并给出三服务指引", async () => {
    const { exec, calls } = fakeExec();
    const result = await installHostForm(fakePlan({}), { exec, repoDir: "/repo" });
    expect(result.success).toBe(true);
    expect(calls.find((c) => c.args.join(" ") === "pnpm install")?.opts?.cwd).toBe("/repo");
    expect(calls.find((c) => c.args.join(" ") === "pnpm run build")?.opts?.cwd).toBe("/repo");
    const guide = result.steps.find((s) => s.id === "services-guide")!;
    expect(guide.status).toBe("ok");
    for (const service of ["butler-watch", "butler-web", "butler-gateway"]) {
      expect(guide.detail).toContain(service);
    }
  });

  it("真实执行：命令失败即停（hermes 失败 → 不跑 pnpm install）", async () => {
    const { exec, calls } = fakeExec((command) =>
      command === "bash" ? { code: 1, stdout: "", stderr: "curl: (7) Failed to connect" } : { code: 0, stdout: "", stderr: "" },
    );
    const result = await installHostForm(fakePlan({}), { exec, repoDir: "/repo" });
    expect(result.steps.map((s) => s.id)).toEqual(["node-check", "hermes-install"]);
    expect(result.steps[1]!.status).toBe("failed");
    expect(result.steps[1]!.detail).toContain("curl: (7)");
    expect(result.success).toBe(false);
    expect(calls.some((c) => c.command === "corepack")).toBe(false);
  });

  it("宿主 user-systemd：生成三项 unit、刷新并启用服务", async () => {
    const tmp = makeTempDir();
    try {
      const { exec, calls } = fakeExec();
      const result = await installHostForm(fakePlan({}), {
        exec,
        repoDir: "/repo with space",
        hostServices: { manager: "systemd-user", serviceDir: tmp, nodePath: "/usr/bin/node" },
      });
      expect(result.success).toBe(true);
      expect(result.steps.map((step) => step.id).slice(-4)).toEqual([
        "services-health-butler-watch",
        "services-health-butler-gateway",
        "services-health-butler-web",
        "services-guide",
      ]);
      for (const service of ["butler-watch", "butler-web", "butler-gateway"]) {
        const unit = fs.readFileSync(path.join(tmp, service + ".service"), "utf8");
        expect(unit).toContain("EnvironmentFile=-%h/.agent-butler/env");
        expect(unit).toContain("/repo with space");
        expect(unit).toContain("/usr/bin/node");
      }
      expect(calls.filter((call) => call.command === "systemctl").map((call) => call.args)).toEqual([
        ["--user", "show-environment"],
        ["--user", "daemon-reload"],
        ["--user", "enable", "--now", "butler-watch.service", "butler-web.service", "butler-gateway.service"],
        ["--user", "is-active", "--quiet", "butler-watch.service"],
        ["--user", "is-active", "--quiet", "butler-web.service"],
        ["--user", "is-active", "--quiet", "butler-gateway.service"],
      ]);
      expect(calls.filter((call) => call.command === "/usr/bin/node").map((call) => call.args[0])).toEqual(["-e", "-e", "-e"]);
    } finally {
      rmTempDir(tmp);
    }
  });

  it("宿主 unit dry-run：打印 unit 计划但不写文件、不执行 systemctl", async () => {
    const tmp = makeTempDir();
    try {
      const { exec, calls } = fakeExec();
      const result = await installHostForm(fakePlan({}), {
        exec,
        dryRun: true,
        repoDir: "/repo",
        hostServices: { manager: "systemd-user", serviceDir: tmp, nodePath: "/usr/bin/node" },
      });
      expect(result.steps.find((step) => step.id === "services-install")).toMatchObject({ status: "dry-run" });
      expect(result.steps.find((step) => step.id === "services-start")).toMatchObject({ status: "dry-run" });
      expect(fs.readdirSync(tmp)).toEqual([]);
      expect(calls).toHaveLength(0);
    } finally {
      rmTempDir(tmp);
    }
  });

  it("宿主服务健康失败：停止已启动服务并返回失败", async () => {
    const tmp = makeTempDir();
    try {
      const { exec, calls } = fakeExec((command, args) =>
        command === "/usr/bin/node" && args[0] === "-e"
          ? { code: 1, stdout: "", stderr: "health endpoint unavailable" }
          : { code: 0, stdout: "", stderr: "" },
      );
      const result = await installHostForm(fakePlan({}), {
        exec,
        repoDir: "/repo",
        hostServices: { manager: "systemd-user", serviceDir: tmp, nodePath: "/usr/bin/node" },
      });
      expect(result.success).toBe(false);
      expect(result.steps.find((step) => step.id === "services-health-butler-watch")).toMatchObject({ status: "failed" });
      expect(result.steps.find((step) => step.id === "services-rollback")).toMatchObject({ status: "ok" });
      expect(calls.some((call) => call.command === "systemctl" && call.args[1] === "stop")).toBe(true);
    } finally {
      rmTempDir(tmp);
    }
  });

  it("宿主端口被外部进程占用：写 unit 前 fail-closed", async () => {
    const tmp = makeTempDir();
    try {
      const { exec, calls } = fakeExec((command, args) =>
        command === "systemctl" && args[1] === "is-active"
          ? { code: 3, stdout: "inactive", stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
      );
      const result = await installHostForm(fakePlan({}), {
        exec,
        repoDir: "/repo",
        portProbe: async (port) => port !== 7532,
        hostServices: { manager: "systemd-user", serviceDir: tmp, nodePath: "/usr/bin/node" },
      });
      expect(result.success).toBe(false);
      expect(result.steps.at(-1)).toMatchObject({ id: "services-port-check", status: "failed" });
      expect(result.steps.at(-1)?.detail).toContain("butler-gateway=127.0.0.1:7532");
      expect(fs.readdirSync(tmp)).toEqual([]);
      expect(calls.some((call) => call.command === "systemctl" && call.args[1] === "daemon-reload")).toBe(false);
      expect(calls.some((call) => call.command === "systemctl" && call.args[1] === "enable")).toBe(false);
    } finally {
      rmTempDir(tmp);
    }
  });

  it("宿主重跑：已由 Butler unit 托管的占用端口允许继续", async () => {
    const tmp = makeTempDir();
    try {
      const { exec, calls } = fakeExec((command, args) =>
        command === "systemctl" && args[1] === "is-active"
          ? { code: 0, stdout: "active", stderr: "" }
          : command === "systemctl" && args[1] === "show"
            ? { code: 0, stdout: args[2] === "butler-watch.service" ? "101\n" : args[2] === "butler-gateway.service" ? "102\n" : "103\n", stderr: "" }
            : command === "ss"
              ? {
                  code: 0,
                  stdout: [
                    "LISTEN 0 128 127.0.0.1:7533 0.0.0.0:* users:((\"node\",pid=101,fd=1))",
                    "LISTEN 0 128 127.0.0.1:7532 0.0.0.0:* users:((\"node\",pid=102,fd=1))",
                    "LISTEN 0 128 127.0.0.1:7531 0.0.0.0:* users:((\"node\",pid=103,fd=1))",
                  ].join("\n"),
                  stderr: "",
                }
              : { code: 0, stdout: "", stderr: "" },
      );
      const result = await installHostForm(fakePlan({}), {
        exec,
        repoDir: "/repo",
        portProbe: async () => false,
        hostServices: { manager: "systemd-user", serviceDir: tmp, nodePath: "/usr/bin/node" },
      });
      expect(result.success).toBe(true);
      expect(result.steps.find((step) => step.id === "services-port-check")).toMatchObject({ status: "ok" });
      expect(calls.some((call) => call.command === "systemctl" && call.args[1] === "enable")).toBe(true);
    } finally {
      rmTempDir(tmp);
    }
  });

  it("宿主重跑：active unit 但端口由其它 PID 监听时仍 fail-closed", async () => {
    const tmp = makeTempDir();
    try {
      const { exec, calls } = fakeExec((command, args) =>
        command === "systemctl" && args[1] === "is-active"
          ? { code: 0, stdout: "active", stderr: "" }
          : command === "systemctl" && args[1] === "show"
            ? { code: 0, stdout: "101\n", stderr: "" }
            : command === "ss"
              ? { code: 0, stdout: "LISTEN 0 128 127.0.0.1:7532 0.0.0.0:* users:((\"other\",pid=999,fd=1))\n", stderr: "" }
              : { code: 0, stdout: "", stderr: "" },
      );
      const result = await installHostForm(fakePlan({}), {
        exec,
        repoDir: "/repo",
        portProbe: async (port) => port !== 7532,
        hostServices: { manager: "systemd-user", serviceDir: tmp, nodePath: "/usr/bin/node" },
      });
      expect(result.success).toBe(false);
      expect(result.steps.find((step) => step.id === "services-port-check")).toMatchObject({ status: "failed" });
      expect(result.steps.find((step) => step.id === "services-port-check")?.detail).toContain("butler-gateway=127.0.0.1:7532");
      expect(fs.readdirSync(tmp)).toEqual([]);
      expect(calls.some((call) => call.command === "systemctl" && call.args[1] === "daemon-reload")).toBe(false);
    } finally {
      rmTempDir(tmp);
    }
  });

  it("非 Linux 平台强制 systemd → 安全失败且不写文件", async () => {
    const tmp = makeTempDir();
    try {
      const { exec, calls } = fakeExec();
      const result = await installHostForm(fakePlan({ platform: { os: "win32", isWsl: false } }), {
        exec,
        repoDir: "/repo",
        hostServices: { manager: "systemd-user", serviceDir: tmp },
      });
      expect(result.success).toBe(false);
      expect(result.steps.at(-1)).toMatchObject({ id: "services-install", status: "failed" });
      expect(fs.readdirSync(tmp)).toEqual([]);
      expect(calls.some((call) => call.command === "systemctl")).toBe(false);
    } finally {
      rmTempDir(tmp);
    }
  });
});

describe("runMaintenance reset/uninstall", () => {
  it("未确认时只展示计划，不删除状态", async () => {
    const root = makeTempDir();
    try {
      const home = path.join(root, "butler-home");
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, "state.json"), "keep");
      const result = await runMaintenance({ command: "reset", homeDir: home, repoDir: path.join(root, "repo") });
      expect(result.success).toBe(true);
      expect(fs.readFileSync(path.join(home, "state.json"), "utf8")).toBe("keep");
      expect(result.steps.some((step) => step.id === "confirmation" && step.status === "skipped")).toBe(true);
    } finally {
      rmTempDir(root);
    }
  });

  it("reset --yes 清空 Butler 状态但保留目录", async () => {
    const root = makeTempDir();
    try {
      const home = path.join(root, "butler-home");
      fs.mkdirSync(path.join(home, "nested"), { recursive: true });
      fs.writeFileSync(path.join(home, "nested", "state.json"), "remove");
      const result = await runMaintenance({ command: "reset", confirmed: true, homeDir: home, repoDir: path.join(root, "repo") });
      expect(result.success).toBe(true);
      expect(fs.existsSync(home)).toBe(true);
      expect(fs.readdirSync(home)).toEqual([]);
    } finally {
      rmTempDir(root);
    }
  });

  it("uninstall --yes 删除独立 Butler 状态目录", async () => {
    const root = makeTempDir();
    try {
      const home = path.join(root, "butler-home");
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, "state.json"), "remove");
      const result = await runMaintenance({ command: "uninstall", confirmed: true, homeDir: home, repoDir: path.join(root, "repo") });
      expect(result.success).toBe(true);
      expect(fs.existsSync(home)).toBe(false);
    } finally {
      rmTempDir(root);
    }
  });
});

describe("buildHostServiceUnits", () => {
  it("三项入口、环境文件、回环端口和依赖关系完整", () => {
    const units = buildHostServiceUnits("/repo with space", "openclaw", 17531, "/usr/bin/node");
    expect(units["butler-watch"]).toContain("ExecStart=\"/usr/bin/node\" \"/repo with space/apps/watch/dist/main.js\"");
    expect(units["butler-watch"]).toContain("BUTLER_OPENCLAW_ROOT=%h/.openclaw");
    expect(units["butler-web"]).toContain("BUTLER_WEB_PORT=17531");
    expect(units["butler-web"]).toContain("After=butler-gateway.service butler-watch.service");
    expect(units["butler-gateway"]).toContain("BUTLER_GATEWAY_PORT=7532");
    expect(units["butler-gateway"]).toContain("BUTLER_ENABLE_HERMES_MESSAGE_RUNTIME=auto");
    expect(units["butler-gateway"]).toContain("BUTLER_HERMES_BRIDGE_URL=http://127.0.0.1:8754");
    expect(units["butler-gateway"]).toContain("BUTLER_HERMES_BRIDGE_TOKEN_FILE=%h/.hermes/agent-butler/bridge.token");
    expect(units["butler-gateway"]).toContain("BUTLER_MESSAGE_PROJECTION_DB=%h/.agent-butler/messages.sqlite");
    expect(units["butler-gateway"]).toContain("BUTLER_MESSAGE_REQUEST_TIMEOUT_MS=120000");
  });
});

describe("installDockerForm 容器形态", () => {
  it("OpenClaw：生成持久化 Gateway 服务与 Watch 接入 override", async () => {
    const tmp = makeTempDir();
    try {
      const { exec, calls } = fakeExec();
      const overridePath = path.join(tmp, "docker-compose.override.yml");
      const result = await installDockerForm(fakePlan({}), {
        framework: "openclaw",
        exec,
        dryRun: false,
        repoDir: tmp,
        overridePath,
        composeFile: path.join(tmp, "docker-compose.yml"),
      });
      expect(result.success).toBe(true);
      const content = fs.readFileSync(overridePath, "utf8");
      expect(content).toContain("node:24.15-bookworm-slim");
      expect(content).toContain("BUTLER_FRAMEWORK=openclaw");
      expect(content).toContain("openclaw-data:/home/openclaw");
      const up = calls.find((call) => call.command === "docker" && call.args.includes("up"));
      expect(up?.args).toEqual([
        "compose",
        "-f",
        path.join(tmp, "docker-compose.yml"),
        "-f",
        overridePath,
        "up",
        "-d",
        "--build",
        "--wait",
        "--wait-timeout",
        "600",
      ]);
    } finally {
      rmTempDir(tmp);
    }
  });

  it("buildOpenClawComposeOverride：包含官方安装与 healthcheck", () => {
    const content = buildOpenClawComposeOverride("openclaw@2026.7.1-2", undefined, "test-openclaw-token", 17531);
    expect(content).toContain("npm install --global openclaw@2026.7.1-2");
    expect(content).toContain("openclaw gateway health --json");
    expect(content).toContain("OPENCLAW_GATEWAY_TOKEN=test-openclaw-token");
    expect(content).toContain("$$OPENCLAW_GATEWAY_TOKEN");
    expect(content).toContain("openclaw-data");
    expect(content).toContain("ports: !override");
    expect(content).toContain("127.0.0.1:17531:7531");
  });

  it("OpenClaw dry-run：compose 报告不回显 Gateway token", async () => {
    const tmp = makeTempDir();
    try {
      const { exec } = fakeExec();
      const result = await installDockerForm(fakePlan({}), {
        framework: "openclaw",
        exec,
        dryRun: true,
        repoDir: tmp,
        openclawGatewayToken: "secret-openclaw-token",
        overridePath: path.join(tmp, "docker-compose.override.yml"),
      });
      const detail = result.steps.find((step) => step.id === "openclaw-compose")?.detail ?? "";
      expect(detail).not.toContain("secret-openclaw-token");
      expect(detail).toContain("OPENCLAW_GATEWAY_TOKEN=<redacted>");
    } finally {
      rmTempDir(tmp);
    }
  });

  it("docker CLI 不可用 → 首步失败即停", async () => {
    const { exec, calls } = fakeExec();
    const plan = fakePlan({ platform: { dockerAvailable: false } });
    const result = await installDockerForm(plan, { exec, repoDir: "/repo" });
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ id: "docker-check", status: "failed" });
    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("docker compose 不可用 → compose-check 失败即停", async () => {
    const { exec } = fakeExec();
    const plan = fakePlan({ platform: { dockerComposeAvailable: false } });
    const result = await installDockerForm(plan, { exec, repoDir: "/repo" });
    expect(result.steps.map((s) => s.id)).toEqual(["docker-check", "compose-check"]);
    expect(result.steps[1]!.status).toBe("failed");
    expect(result.success).toBe(false);
  });

  it("Web 宿主端口被占用 → 前置失败且不写 override/启动 compose", async () => {
    const { exec, calls } = fakeExec();
    const result = await installDockerForm(fakePlan({}), {
      exec,
      repoDir: "/repo",
      portProbe: async () => false,
    });
    expect(result.steps.map((step) => step.id)).toEqual(["docker-check", "compose-check", "web-port-check"]);
    expect(result.steps[2]).toMatchObject({ status: "failed" });
    expect(result.steps[2]?.detail).toContain("--web-port");
    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("镜像注入（dry-run）：只打印 override 内容、不写文件", async () => {
    const tmp = makeTempDir();
    try {
      const { exec, calls } = fakeExec();
      const overridePath = path.join(tmp, "docker-compose.override.yml");
      const plan = fakePlan({
        dockerRegistry: { officialReachable: false, mirrorUsed: true, chosen: "daocloud", chosenUrl: "https://docker.m.daocloud.io/v2/" },
      });
      const result = await installDockerForm(plan, { exec, dryRun: true, repoDir: tmp, overridePath });
      const step = result.steps.find((s) => s.id === "registry-mirror")!;
      expect(step.status).toBe("dry-run");
      expect(step.detail).toContain("REGISTRY_MIRROR=https://docker.m.daocloud.io/v2/");
      expect(step.detail).toContain("registry-mirrors");
      expect(fs.existsSync(overridePath)).toBe(false);
      expect(result.steps.find((s) => s.id === "compose-up")!.status).toBe("dry-run");
      expect(calls).toHaveLength(0);
    } finally {
      rmTempDir(tmp);
    }
  });

  it("镜像注入（真实）：写入 override 文件并执行 docker compose up -d", async () => {
    const tmp = makeTempDir();
    try {
      const { exec, calls } = fakeExec();
      const composeFile = path.join(tmp, "docker-compose.yml");
      const overridePath = path.join(tmp, "docker-compose.override.yml");
      const plan = fakePlan({
        dockerRegistry: { officialReachable: false, mirrorUsed: true, chosen: "daocloud", chosenUrl: "https://docker.m.daocloud.io/v2/" },
      });
      const result = await installDockerForm(plan, { exec, repoDir: tmp, composeFile, overridePath });
      expect(result.success).toBe(true);
      const content = fs.readFileSync(overridePath, "utf-8");
      for (const service of ["butler-watch", "butler-web", "butler-gateway"]) {
        expect(content).toContain(`  ${service}:`);
      }
      expect(content).toContain("REGISTRY_MIRROR=https://docker.m.daocloud.io/v2/");
      expect(content).toContain("registry-mirrors");
      expect(result.steps.find((s) => s.id === "registry-mirror")!.status).toBe("ok");
      const up = calls.find((c) => c.args.includes("up"));
      expect(up?.command).toBe("docker");
      expect(up?.args).toEqual([
        "compose",
        "-f",
        composeFile,
        "-f",
        overridePath,
        "up",
        "-d",
        "--build",
        "--wait",
        "--wait-timeout",
        "600",
      ]);
      expect(up?.opts?.cwd).toBe(tmp);
    } finally {
      rmTempDir(tmp);
    }
  });

  it("官方 registry 可达 → registry-mirror skipped、预检后启动 compose", async () => {
    const { exec, calls } = fakeExec();
    const result = await installDockerForm(fakePlan({}), { exec, repoDir: "/repo" });
    expect(result.steps.find((s) => s.id === "registry-mirror")!.status).toBe("skipped");
    expect(result.steps.find((s) => s.id === "compose-up")!.status).toBe("ok");
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toEqual(["compose", "-f", path.join("/repo", "docker-compose.yml"), "config", "-q"]);
    expect(calls[1]?.args).toContain("up");
  });

  it("合并后的 Compose 配置不合法 → 不执行启动", async () => {
    const { exec, calls } = fakeExec((_command, args) =>
      args.includes("config") ? { code: 1, stdout: "", stderr: "services.openclaw.environment must be a mapping" } : { code: 0, stdout: "", stderr: "" },
    );
    const tmp = makeTempDir();
    try {
      const result = await installDockerForm(fakePlan({}), {
        framework: "openclaw",
        exec,
        repoDir: tmp,
        composeFile: path.join(tmp, "docker-compose.yml"),
        overridePath: path.join(tmp, "docker-compose.override.yml"),
      });
      expect(result.steps.at(-1)).toMatchObject({ id: "compose-config", status: "failed" });
      expect(calls.some((call) => call.args.includes("up"))).toBe(false);
      expect(result.success).toBe(false);
    } finally {
      rmTempDir(tmp);
    }
  });

  it("registry 全部不可达 → registry-mirror 失败，不执行 compose up", async () => {
    const { exec, calls } = fakeExec();
    const plan = fakePlan({
      dockerRegistry: { officialReachable: false, mirrorUsed: false, allFailed: true, chosen: null, chosenUrl: null, guidance: "建议设置 HTTPS_PROXY 或手动配置镜像" },
    });
    const result = await installDockerForm(plan, { exec, repoDir: "/repo" });
    expect(result.steps.map((s) => s.id)).toEqual(["docker-check", "compose-check", "registry-mirror"]);
    expect(result.steps[2]!.status).toBe("failed");
    expect(result.steps[2]!.detail).toContain("HTTPS_PROXY");
    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("buildComposeOverride：三服务均含镜像变量与 daemon.json 建议", () => {
    const content = buildComposeOverride("https://docker.1ms.run/v2/");
    expect(content).toContain("docker.1ms.run");
    expect(content.match(/REGISTRY_MIRROR=/g)).toHaveLength(3);
    expect(content).toContain('"registry-mirrors"');
  });

  it("指定 Web 端口时生成覆盖基础端口映射的 override", () => {
    const content = buildComposeOverride(undefined, ["butler-web"], 17531);
    expect(content).toContain("ports: !override");
    expect(content).toContain("127.0.0.1:17531:7531");
    expect(content).not.toContain("REGISTRY_MIRROR=");
  });
});

describe("runInstaller 顶层编排", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir();
  });

  afterEach(() => {
    rmTempDir(tmp);
  });

  it("docker 形态汇总报告：平台/网络/密钥/步骤/后续指引", async () => {
    const { exec } = fakeExec();
    // docker registry 官方失败、daocloud 镜像可达；其余源全失败（docker 形态不依赖）
    const fetcher = fakeProbeFetch((url) => url.includes("daocloud"));
    const report = await runInstaller({
      form: "docker",
      exec,
      fetch: fetcher,
      repoDir: tmp,
      composeFile: path.join(tmp, "docker-compose.yml"),
      overridePath: path.join(tmp, "docker-compose.override.yml"),
      env: {},
    });
    expect(report.form).toBe("docker");
    expect(report.dryRun).toBe(false);
    expect(report.platform.dockerAvailable).toBe(true);
    const registry = report.network.results.find((r) => r.id === "docker-registry")!;
    expect(registry.chosen).toBe("daocloud");
    expect(registry.mirrorUsed).toBe(true);
    expect(report.secrets.groups).toHaveLength(3);
    expect(report.secrets.allPresent).toBe(false);
    expect(report.install?.form).toBe("docker");
    expect(report.install?.success).toBe(true);
    expect(fs.existsSync(path.join(tmp, "docker-compose.override.yml"))).toBe(true);
    expect(report.success).toBe(true);
    expect(report.nextActions.some((a) => a.includes("docker compose ps"))).toBe(true);
  });

  it("模型端点全失败不阻断安装", async () => {
    const { exec } = fakeExec();
    const fetcher = fakeProbeFetch((url) => url.includes("registry-1.docker.io"));
    const report = await runInstaller({
      form: "docker",
      exec,
      fetch: fetcher,
      repoDir: tmp,
      composeFile: path.join(tmp, "docker-compose.yml"),
      overridePath: path.join(tmp, "docker-compose.override.yml"),
      env: {},
    });
    const model = report.network.results.find((r) => r.id === "model-endpoints")!;
    expect(model.allFailed).toBe(true);
    expect(report.install?.success).toBe(true);
    expect(report.success).toBe(true);
    expect(report.nextActions.some((a) => a.includes("模型端点"))).toBe(true);
  });

  it("skipNetwork → 网络结果为空且镜像步骤 skipped", async () => {
    const { exec } = fakeExec();
    const report = await runInstaller({
      form: "docker",
      exec,
      skipNetwork: true,
      repoDir: tmp,
      composeFile: path.join(tmp, "docker-compose.yml"),
      overridePath: path.join(tmp, "docker-compose.override.yml"),
      env: {},
    });
    expect(report.network.results).toEqual([]);
    expect(report.install?.steps.find((s) => s.id === "registry-mirror")!.status).toBe("skipped");
    expect(report.success).toBe(true);
  });

  it("secretsOnly → 不执行安装、success true", async () => {
    const { exec, calls } = fakeExec();
    const report = await runInstaller({ secretsOnly: true, exec, fetch: fakeProbeFetch(() => true), env: {} });
    expect(report.form).toBe("secrets-only");
    expect(report.install).toBeUndefined();
    expect(report.success).toBe(true);
    expect(report.nextActions.length).toBeGreaterThan(0);
    // 仅有平台检测的 docker 探测调用，绝无安装命令
    expect(calls.every((c) => c.command === "docker")).toBe(true);
    expect(calls.some((c) => c.args.includes("up"))).toBe(false);
  });

  it("host 形态失败传导到汇总 success=false", async () => {
    const { exec } = fakeExec((command) =>
      command === "bash" ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: "", stderr: "" },
    );
    const report = await runInstaller({ form: "host", exec, fetch: fakeProbeFetch(() => true), env: {}, repoDir: tmp });
    expect(report.form).toBe("host");
    expect(report.install?.success).toBe(false);
    expect(report.success).toBe(false);
    expect(report.nextActions.some((a) => a.includes("重新运行"))).toBe(true);
  });

  it("host 形态 dry-run：不执行安装命令", async () => {
    const { exec, calls } = fakeExec();
    const report = await runInstaller({
      form: "host",
      exec,
      fetch: fakeProbeFetch(() => true),
      dryRun: true,
      env: {},
      repoDir: tmp,
    });
    expect(report.dryRun).toBe(true);
    expect(report.success).toBe(true);
    expect(calls.every((c) => c.command === "docker")).toBe(true);
  });
});
