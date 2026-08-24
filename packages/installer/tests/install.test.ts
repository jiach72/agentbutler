import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildComposeOverride, installDockerForm, installHostForm, runInstaller } from "../src/install.js";
import { fakeExec, fakePlan, fakeProbeFetch, makeTempDir, rmTempDir } from "./helpers.js";

describe("installHostForm 宿主形态", () => {
  it("dry-run：步骤序列完整、零命令执行", async () => {
    const { exec, calls } = fakeExec();
    const result = await installHostForm(fakePlan({}), { exec, dryRun: true, repoDir: "/repo" });
    expect(result.steps.map((s) => s.id)).toEqual([
      "node-check",
      "hermes-install",
      "pip-mirror",
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
});

describe("installDockerForm 容器形态", () => {
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
      const up = calls.find((c) => c.args[0] === "compose");
      expect(up?.command).toBe("docker");
      expect(up?.args).toEqual(["compose", "-f", composeFile, "up", "-d"]);
      expect(up?.opts?.cwd).toBe(tmp);
    } finally {
      rmTempDir(tmp);
    }
  });

  it("官方 registry 可达 → registry-mirror skipped、直接 compose up", async () => {
    const { exec, calls } = fakeExec();
    const result = await installDockerForm(fakePlan({}), { exec, repoDir: "/repo" });
    expect(result.steps.find((s) => s.id === "registry-mirror")!.status).toBe("skipped");
    expect(result.steps.find((s) => s.id === "compose-up")!.status).toBe("ok");
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
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
