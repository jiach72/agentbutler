import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createButlerSelfUpgradeService,
  type ButlerSelfUpgradeDeps,
  type CommandResult,
} from "../src/self-upgrade.js";

let home: string;
let source: string;

function ok(stdout: string): CommandResult {
  return { ok: true, stdout, error: "" };
}

function fakeExec(extra?: Record<string, CommandResult>): ButlerSelfUpgradeDeps["exec"] {
  return (cmd, args) => {
    if (cmd !== "git") return extra?.[cmd + " " + args.join(" ")] ?? { ok: true, stdout: "", error: "" };
    const key = args.join(" ");
    if (key === "branch --show-current") return ok("codex/continue-agent-butler-v1");
    if (key === "rev-parse --short HEAD") return ok("fc0e992");
    if (key === "describe --tags --exact-match --always") return ok("v0.1.0");
    if (key === "remote get-url origin") return ok("https://example.com/agent-butler.git");
    if (key === "status --porcelain") return ok("");
    if (key === "tag --list") return ok("v0.1.0\nv0.2.0");
    if (key.startsWith("ls-remote --tags origin")) return ok("abc1234\trefs/tags/v0.2.0");
    if (key.startsWith("rev-parse --verify")) return ok("deadbeef");
    if (key === "fetch --tags origin") return ok("");
    if (key === "checkout v0.2.0") return ok("");
    if (key === "checkout fc0e992") return ok("");
    return extra?.[key] ?? { ok: true, stdout: "", error: "" };
  };
}

function makeDeps(overrides: Partial<ButlerSelfUpgradeDeps> = {}): ButlerSelfUpgradeDeps {
  const calls = { backups: [] as string[], restarts: [] as string[][] };
  const deps: ButlerSelfUpgradeDeps = {
    sourceDir: source,
    homeDir: home,
    exec: fakeExec(),
    build: () => ({ ok: true, stdout: "build ok", error: "" }),
    restart: (services) => {
      calls.restarts.push(services);
      return { ok: true, stdout: "restart ok", error: "" };
    },
    verifyHealth: async () => true,
    runInline: true,
    services: ["butler-watch", "butler-web"],
    audit: { append() {} },
    backup: {
      runFull: async (label) => {
        calls.backups.push(label);
        return { id: 7 };
      },
    },
    ...overrides,
  };
  return deps;
}


function runGit(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

async function waitForState(
  homeDir: string,
  accepted: string[],
  timeoutMs: number,
): Promise<{ status: string; phase: string; error: string | null }> {
  const file = join(homeDir, "self-upgrade", "state.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(readFileSync(file, "utf8")) as {
        status: string;
        phase: string;
        error: string | null;
      };
      if (accepted.includes(state.status)) return state;
    } catch {
      // 状态文件尚未写入，继续等待
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("waitForState 超时：" + file);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "butler-self-home-"));
  source = mkdtempSync(join(tmpdir(), "butler-self-src-"));
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "agent-butler", version: "0.1.0" }), "utf8");
  mkdirSync(join(home, "self-upgrade"), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
});

describe("管家自身版本管理服务", () => {
  it("status 返回版本、仓库信息、可用更新与快照/偏好", () => {
    const service = createButlerSelfUpgradeService(makeDeps());
    const status = service.status();
    expect(status.reachable).toBe(true);
    expect(status.version).toBe("0.1.0");
    expect(status.commit).toBe("fc0e992");
    expect(status.repository).toContain("example.com");
    expect(status.repoClean).toBe(true);
    expect(status.remoteConfigured).toBe(true);
    expect(status.availableUpdates[0]?.version).toBe("0.2.0");
    // 默认通道为 beta（本项目发布全部为 -beta 标签）。
    expect(status.prefs.channel).toBe("beta");
    expect(status.snapshots).toEqual([]);
    expect(status.snapshotRetention).toBe(3);
  });

  it("Docker 无 Git 元数据时保留部署仓库地址并标记不可自升级", () => {
    const service = createButlerSelfUpgradeService(
      makeDeps({
        repositoryUrl: "https://github.com/jiach72/agentbutler.git",
        exec: (cmd) =>
          cmd === "git"
            ? { ok: false, stdout: "", error: "not a git repository" }
            : { ok: true, stdout: "", error: "" },
      }),
    );

    const status = service.status();
    expect(status.repository).toBe("https://github.com/jiach72/agentbutler");
    expect(status.repositorySource).toBe("configured-default");
    expect(status.repositoryConfigured).toBe(true);
    expect(status.remoteConfigured).toBe(false);
    expect(status.upgradeSupported).toBe(false);
    expect(status.availableUpdates).toEqual([]);
  });

  it("按 SemVer 排序预发布标签，并将 dev 版本归入测试通道", () => {
    const exec: ButlerSelfUpgradeDeps["exec"] = (cmd, args) => {
      if (cmd !== "git") return ok("");
      const key = args.join(" ");
      if (key === "tag --list") {
        return ok("release-notes\nv0.1.0-dev.2\nv0.1.0-dev-build.10\nv0.1.0");
      }
      if (key.startsWith("rev-parse --short v0.1.0-dev.2")) return ok("dev0002");
      if (key.startsWith("rev-parse --short v0.1.0-dev-build.10")) return ok("dev0010");
      if (key.startsWith("rev-parse --short v0.1.0")) return ok("stable1");
      if (key === "ls-remote --tags origin") return ok("");
      return fakeExec()(cmd, args);
    };
    const status = createButlerSelfUpgradeService(makeDeps({ exec })).status();
    expect(status.availableUpdates.map((item) => item.version)).toEqual([
      "0.1.0",
      "0.1.0-dev-build.10",
      "0.1.0-dev.2",
    ]);
    expect(status.availableUpdates.map((item) => item.channel)).toEqual([
      "stable",
      "beta",
      "beta",
    ]);
  });

  it("startUpgrade 未确认拒绝；确认后创建快照并启动内联流水线", async () => {
    const service = createButlerSelfUpgradeService(makeDeps());
    const rejected = await service.startUpgrade({ confirmed: false, target: "v0.2.0" });
    expect(rejected.status).toBe("confirmation-required");

    const started = await service.startUpgrade({ confirmed: true, target: "v0.2.0" });
    expect(started.status).toBe("started");
    if (started.status !== "started") return;
    const registry = JSON.parse(
      readFileSync(join(home, "self-upgrade", "snapshots.json"), "utf8"),
    ) as Array<{ version: string; commit: string; backupId: number | null }>;
    expect(registry.length).toBe(1);
    expect(registry[0]?.version).toBe("0.1.0");
    expect(registry[0]?.commit).toBe("fc0e992");
    expect(registry[0]?.backupId).toBe(7);

    await new Promise((resolve) => setTimeout(resolve, 30));
    const state = JSON.parse(
      readFileSync(join(home, "self-upgrade", "state.json"), "utf8"),
    ) as { status: string; phase: string };
    expect(state.status).toBe("done");
    expect(state.phase).toBe("done");
  });

  it("升级失败自动回滚；版本锁定后拒绝升级", async () => {
    const service = createButlerSelfUpgradeService(
      makeDeps({
        exec: fakeExec({
          "checkout v0.2.0": { ok: false, stdout: "", error: "busy" },
        }),
      }),
    );
    await service.startUpgrade({ confirmed: true, target: "v0.2.0" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    service.updatePrefs({ locked: true });
    expect(service.status().prefs.locked).toBe(true);
    const locked = await service.startUpgrade({ confirmed: true, target: "v0.2.0" });
    expect(locked.status).toBe("invalid-target");
  });

  it("升级必须等待全量备份完成，等待期间拒绝第二个升级与回滚", async () => {
    let finishBackup: ((value: { id: number }) => void) | undefined;
    const backupPending = new Promise<{ id: number }>((resolve) => {
      finishBackup = resolve;
    });
    const service = createButlerSelfUpgradeService(
      makeDeps({ backup: { runFull: () => backupPending } }),
    );

    const pending = service.startUpgrade({ confirmed: true, target: "v0.2.0" });
    await Promise.resolve();
    expect(existsSync(join(home, "self-upgrade", "snapshots.json"))).toBe(false);
    expect(existsSync(join(home, "self-upgrade", "state.json"))).toBe(false);
    expect((await service.startUpgrade({ confirmed: true, target: "v0.2.0" })).status).toBe(
      "upgrade-in-flight",
    );
    expect(service.rollback({ snapshotId: "missing", confirmed: true }).status).toBe(
      "upgrade-in-flight",
    );

    finishBackup?.({ id: 9 });
    const started = await pending;
    expect(started.status).toBe("started");
    const registry = JSON.parse(
      readFileSync(join(home, "self-upgrade", "snapshots.json"), "utf8"),
    ) as Array<{ backupId: number | null }>;
    expect(registry[0]?.backupId).toBe(9);
  });

  it("全量备份失败时不登记快照、不创建升级 Job", async () => {
    const service = createButlerSelfUpgradeService(
      makeDeps({
        backup: {
          runFull: async () => {
            throw new Error("disk full");
          },
        },
      }),
    );

    const outcome = await service.startUpgrade({ confirmed: true, target: "v0.2.0" });
    expect(outcome).toEqual({ status: "backup-failed", error: "disk full" });
    expect(existsSync(join(home, "self-upgrade", "snapshots.json"))).toBe(false);
    expect(existsSync(join(home, "self-upgrade", "state.json"))).toBe(false);
  });

  it("rollback 未确认拒绝；未知快照返回 snapshot-not-found", () => {
    const service = createButlerSelfUpgradeService(makeDeps());
    expect(service.rollback({ snapshotId: "missing", confirmed: false }).status).toBe(
      "confirmation-required",
    );
    expect(service.rollback({ snapshotId: "missing", confirmed: true }).status).toBe(
      "snapshot-not-found",
    );
  });

  it("updatePrefs 持久化通道与锁定开关", () => {
    const service = createButlerSelfUpgradeService(makeDeps());
    const prefs = service.updatePrefs({ channel: "beta", locked: true });
    expect(prefs.channel).toBe("beta");
    expect(prefs.locked).toBe(true);
    const again = service.updatePrefs({});
    expect(again.channel).toBe("beta");
    expect(again.locked).toBe(true);
  });

  it("真实 git 仓库端到端：一键升级切到目标 tag，state 落 done", async () => {
    const repo = mkdtempSync(join(tmpdir(), "butler-self-repo-"));
    try {
      runGit(repo, ["init", "-q"]);
      runGit(repo, ["config", "user.email", "butler@test.local"]);
      runGit(repo, ["config", "user.name", "Butler Test"]);
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "agent-butler", version: "0.1.0" }), "utf8");
      runGit(repo, ["add", "."]);
      runGit(repo, ["commit", "-qm", "v1"]);
      runGit(repo, ["tag", "v0.1.0"]);
      const commitV2 = (() => {
        writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "agent-butler", version: "0.2.0" }), "utf8");
        runGit(repo, ["add", "."]);
        runGit(repo, ["commit", "-qm", "v2"]);
        return runGit(repo, ["rev-parse", "--short", "HEAD"]);
      })();
      runGit(repo, ["tag", "v0.2.0"]);
      runGit(repo, ["checkout", "-q", "v0.1.0"]);

      const service = createButlerSelfUpgradeService({
        sourceDir: repo,
        homeDir: home,
        runInline: true,
        services: [],
        build: () => ({ ok: true, stdout: "build ok", error: "" }),
        restart: () => ({ ok: true, stdout: "restart ok", error: "" }),
        verifyHealth: async () => true,
        backup: { runFull: async () => ({ id: 1 }) },
      });
      expect(service.status().availableUpdates[0]?.version).toBe("0.2.0");
      const started = await service.startUpgrade({ confirmed: true, target: "v0.2.0" });
      expect(started.status).toBe("started");

      const state = await waitForState(home, ["done", "rolled-back", "failed"], 15_000);
      expect(state.status).toBe("done");
      expect(runGit(repo, ["rev-parse", "--short", "HEAD"])).toBe(commitV2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 20_000);

  it("真实 git 仓库端到端：升级构建失败自动回滚到原 commit", async () => {
    const repo = mkdtempSync(join(tmpdir(), "butler-self-repo-"));
    try {
      runGit(repo, ["init", "-q"]);
      runGit(repo, ["config", "user.email", "butler@test.local"]);
      runGit(repo, ["config", "user.name", "Butler Test"]);
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "agent-butler", version: "0.1.0" }), "utf8");
      runGit(repo, ["add", "."]);
      runGit(repo, ["commit", "-qm", "v1"]);
      runGit(repo, ["tag", "v0.1.0"]);
      const commitV1 = runGit(repo, ["rev-parse", "--short", "HEAD"]);
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "agent-butler", version: "0.2.0" }), "utf8");
      runGit(repo, ["add", "."]);
      runGit(repo, ["commit", "-qm", "v2"]);
      runGit(repo, ["tag", "v0.2.0"]);
      runGit(repo, ["checkout", "-q", "v0.1.0"]);

      const service = createButlerSelfUpgradeService({
        sourceDir: repo,
        homeDir: home,
        runInline: true,
        services: [],
        // 切到 v0.2.0 后构建失败 → 触发自动回滚
        build: (dir) => {
          const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string };
          return pkg.version === "0.2.0"
            ? { ok: false, stdout: "", error: "simulated build failure" }
            : { ok: true, stdout: "build ok", error: "" };
        },
        restart: () => ({ ok: true, stdout: "restart ok", error: "" }),
        verifyHealth: async () => true,
        backup: { runFull: async () => ({ id: 1 }) },
      });
      const started = await service.startUpgrade({ confirmed: true, target: "v0.2.0" });
      expect(started.status).toBe("started");

      const state = await waitForState(home, ["done", "rolled-back", "failed"], 15_000);
      expect(state.status).toBe("rolled-back");
      expect(runGit(repo, ["rev-parse", "--short", "HEAD"])).toBe(commitV1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 20_000);
});
