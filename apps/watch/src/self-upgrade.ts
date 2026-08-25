/**
 * 管家自身版本管理（PRD M2 V1.7 新增）。
 *
 * 管家不止管理被管智能体的版本，自己也纳入版本管理：
 * - 版本标识 = package.json version + Git commit（short sha）；
 * - 可用更新 = 远程 tag（git ls-remote）合并本地 tag，按语义版本排序；
 * - 升级 = 确认 → 全量快照（代码 ref + 配置/数据备份）→ 切 tag/commit → 安装构建 →
 *   重启服务 → 健康验收；任一步失败自动回滚到升级前 commit 并重新构建重启；
 * - 回滚 = 从快照登记（默认保留最近 3 份）手动回滚到任意历史 commit；
 * - 自举原则：升级/回滚走独立 Node 子进程（detached），即使管家服务自身被
 *   重启，流水线仍继续执行并写状态文件。
 *
 * 审计（actor "butler-self"）：self-upgrade-start / self-upgrade-done /
 * self-upgrade-failed / self-upgrade-rollback / self-rollback-start。
 */
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const BUTLER_SELF_ACTOR = "butler-self";
export const SELF_STATE_DIR = "self-upgrade";
export const SELF_REGISTRY_FILE = "snapshots.json";
export const SELF_STATE_FILE = "state.json";
export const SELF_PREFS_FILE = "prefs.json";
export const SELF_SNAPSHOT_KEEP = 3;

export interface ButlerSelfPrefs {
  channel: "stable" | "beta";
  locked: boolean;
}

export interface ButlerSelfSnapshot {
  id: string;
  at: string;
  version: string;
  commit: string;
  tag: string | null;
  channel: string;
  reason: string;
  backupId: number | null;
}

export interface ButlerSelfJobView {
  jobId: string;
  kind: "upgrade" | "rollback";
  status: "running" | "done" | "failed" | "rolled-back";
  phase: string;
  target: string;
  from: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  snapshotId: string | null;
}

export interface ButlerAvailableUpdate {
  version: string;
  channel: "stable" | "beta";
  commit: string | null;
  tag: string | null;
  notes?: string;
}

export interface ButlerSelfStatus {
  reachable: boolean;
  source: string;
  version: string;
  branch: string | null;
  commit: string | null;
  tag: string | null;
  repository: string | null;
  repoClean: boolean;
  remoteConfigured: boolean;
  prefs: ButlerSelfPrefs;
  snapshots: ButlerSelfSnapshot[];
  snapshotRetention: number;
  availableUpdates: ButlerAvailableUpdate[];
  lastJob: ButlerSelfJobView | null;
  checkedAt: string;
}

export type SelfUpgradeOutcome =
  | { status: "started"; jobId: string; snapshotId: string }
  | { status: "confirmation-required" }
  | { status: "upgrade-in-flight" }
  | { status: "backup-failed"; error: string }
  | { status: "invalid-target" }
  | { status: "no-target" }
  | { status: "no-repo" };

export type SelfRollbackOutcome =
  | { status: "started"; jobId: string }
  | { status: "confirmation-required" }
  | { status: "upgrade-in-flight" }
  | { status: "snapshot-not-found" }
  | { status: "no-repo" };

export interface CommandResult {
  ok: boolean;
  stdout: string;
  error: string;
}

export interface ButlerSelfUpgradeDeps {
  sourceDir: string;
  homeDir: string;
  now?: () => number;
  exec?: (cmd: string, args: string[], cwd?: string, timeoutMs?: number) => CommandResult;
  build?: (sourceDir: string) => CommandResult;
  restart?: (services: string[]) => CommandResult;
  verifyHealth?: (sourceDir: string, target: string) => Promise<boolean>;
  spawnDetached?: (runnerScript: string, env: NodeJS.ProcessEnv) => void;
  runInline?: boolean;
  runnerScript?: string;
  services?: string[];
  audit?: {
    append(entry: {
      actor: string;
      action: string;
      target: string;
      detail: Record<string, unknown>;
    }): void;
  };
  backup?: {
    runFull(label: string): Promise<{ id: number }>;
  };
}

function defaultExec(cmd: string, args: string[], cwd?: string, timeoutMs = 30_000): CommandResult {
  try {
    const out = execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: out.trim(), error: "" };
  } catch (error) {
    const err = error as { stderr?: Buffer | string; message?: string };
    const stderr = err.stderr !== undefined ? String(err.stderr).trim() : "";
    return { ok: false, stdout: "", error: stderr || (err.message ?? String(error)) };
  }
}

function defaultBuild(sourceDir: string): CommandResult {
  const pnpm = join(sourceDir, "node_modules", ".bin", "pnpm");
  const manager = existsSync(pnpm) ? pnpm : "pnpm";
  const install = defaultExec(manager, ["install", "--frozen-lockfile"], sourceDir, 600_000);
  if (!install.ok) return install;
  const build = defaultExec(manager, ["build"], sourceDir, 600_000);
  if (!build.ok) return build;
  const uiDir = join(sourceDir, "ui");
  if (existsSync(join(uiDir, "package.json"))) {
    const vite = join(uiDir, "node_modules", ".bin", "vite");
    const uiBuild = defaultExec(vite, ["build", "--logLevel", "warn"], uiDir, 600_000);
    if (!uiBuild.ok) return uiBuild;
  }
  return { ok: true, stdout: "install+build ok", error: "" };
}

function defaultRestart(services: string[]): CommandResult {
  if (services.length === 0) return { ok: true, stdout: "no services to restart", error: "" };
  const args = ["--user", "restart", ...services.map((name) => name + ".service")];
  return defaultExec("systemctl", args, undefined, 120_000);
}

async function defaultVerifyHealth(_sourceDir: string, _target: string): Promise<boolean> {
  void _sourceDir;
  void _target;
  const endpoints = ["http://127.0.0.1:7531/healthz", "http://127.0.0.1:7533/healthz"];
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    let allOk = true;
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(endpoint, { signal: AbortSignal.timeout(3_000) });
        if (!res.ok) allOk = false;
      } catch {
        allOk = false;
      }
    }
    if (allOk) return true;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}

function isoNow(now: () => number): string {
  return new Date(now()).toISOString();
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  renameSync(temp, file);
}

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseVersion(version: string): ParsedVersion {
  const normalized = version.trim().replace(/^v/i, "").split("+", 1)[0] ?? "";
  const separator = normalized.indexOf("-");
  const coreText = separator === -1 ? normalized : normalized.slice(0, separator);
  const prereleaseText = separator === -1 ? undefined : normalized.slice(separator + 1);
  const parts = coreText.split(".");
  return {
    core: [0, 1, 2].map((index) => Number(parts[index]) || 0) as [number, number, number],
    prerelease: prereleaseText === undefined ? [] : prereleaseText.split("."),
  };
}

function compareVersion(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < left.core.length; index += 1) {
    const diff = left.core[index]! - right.core[index]!;
    if (diff !== 0) return diff;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0
        ? 1
        : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

function channelOf(version: string): "stable" | "beta" {
  return version.replace(/^v/i, "").includes("-") ? "beta" : "stable";
}

function isSemanticVersion(version: string): boolean {
  return SEMVER_PATTERN.test(version.replace(/^v/i, ""));
}

export interface ButlerSelfService {
  status(): ButlerSelfStatus;
  startUpgrade(input: {
    target?: string;
    channel?: "stable" | "beta";
    confirmed: boolean;
    trigger?: "manual" | "auto";
  }): Promise<SelfUpgradeOutcome>;
  rollback(input: { snapshotId: string; confirmed: boolean }): SelfRollbackOutcome;
  updatePrefs(input: { channel?: "stable" | "beta"; locked?: boolean }): ButlerSelfPrefs;
}

/** 升级/回滚流水线主函数（detached 子进程与内联测试共用）。 */
export async function executeSelfJob(
  deps: ButlerSelfUpgradeDeps,
  job: ButlerSelfJobView,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const exec = deps.exec ?? defaultExec;
  const build = deps.build ?? defaultBuild;
  const restart = deps.restart ?? defaultRestart;
  const verifyHealth = deps.verifyHealth ?? defaultVerifyHealth;
  const sourceDir = deps.sourceDir;
  const stateFile = join(deps.homeDir, SELF_STATE_DIR, SELF_STATE_FILE);
  const audit = deps.audit ?? { append() {} };
  const readJob = (): ButlerSelfJobView =>
    readJson<ButlerSelfJobView | null>(stateFile, null) ?? job;
  const update = (patch: Partial<ButlerSelfJobView>): void => {
    writeJsonAtomic(stateFile, { ...readJob(), ...patch });
  };
  const fail = async (message: string): Promise<void> => {
    const current = readJob();
    const rollbackJob: ButlerSelfJobView = {
      ...current,
      kind: "rollback",
      target: current.from,
      from: current.target,
      status: "running",
      phase: "rollback",
      error: message,
      finishedAt: null,
    };
    writeJsonAtomic(stateFile, rollbackJob);
    audit.append({
      actor: BUTLER_SELF_ACTOR,
      action: "self-upgrade-failed",
      target: sourceDir,
      detail: { jobId: job.jobId, target: job.target, error: message, rolledBack: true },
    });
    await rollbackSelfJob(deps, rollbackJob);
    const state = readJson<ButlerSelfJobView | null>(stateFile, null);
    if (state !== null && state.status === "done") {
      writeJsonAtomic(stateFile, {
        ...state,
        status: "rolled-back",
        error: message,
      });
    }
  };
  try {
    update({ phase: "checkout" });
    // 临时/离线仓库可能没有 origin；先探测远端，避免无意义的长时间 fetch 阻塞升级。
    const remote = exec("git", ["remote", "get-url", "origin"], sourceDir, 10_000);
    if (remote.ok) {
      exec("git", ["fetch", "--tags", "origin"], sourceDir, 60_000);
    }
    const checkout = exec("git", ["checkout", job.target], sourceDir, 120_000);
    if (!checkout.ok) {
      await fail("切到目标版本失败：" + checkout.error);
      return;
    }
    update({ phase: "install-build" });
    const built = build(sourceDir);
    if (!built.ok) {
      await fail("构建失败：" + built.error);
      return;
    }
    update({ phase: "restart" });
    const restarted = restart(deps.services ?? []);
    if (!restarted.ok) {
      await fail("重启服务失败：" + restarted.error);
      return;
    }
    update({ phase: "verify" });
    const healthy = await verifyHealth(sourceDir, job.target);
    if (!healthy) {
      await fail("健康验收未通过（服务未能恢复或版本未就位）");
      return;
    }
    update({ status: "done", phase: "done", finishedAt: isoNow(now), error: null });
    audit.append({
      actor: BUTLER_SELF_ACTOR,
      action: "self-upgrade-done",
      target: sourceDir,
      detail: { jobId: job.jobId, kind: job.kind, target: job.target },
    });
  } catch (error) {
    await fail(error instanceof Error ? error.message : String(error));
  }
}

/** 回滚流水线：切回 job.from 并重建重启（失败也写终态）。 */
export async function rollbackSelfJob(
  deps: ButlerSelfUpgradeDeps,
  job: ButlerSelfJobView,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const exec = deps.exec ?? defaultExec;
  const build = deps.build ?? defaultBuild;
  const restart = deps.restart ?? defaultRestart;
  const verifyHealth = deps.verifyHealth ?? defaultVerifyHealth;
  const sourceDir = deps.sourceDir;
  const stateFile = join(deps.homeDir, SELF_STATE_DIR, SELF_STATE_FILE);
  const audit = deps.audit ?? { append() {} };
  const readJob = (): ButlerSelfJobView =>
    readJson<ButlerSelfJobView | null>(stateFile, null) ?? job;
  const update = (patch: Partial<ButlerSelfJobView>): void => {
    writeJsonAtomic(stateFile, { ...readJob(), ...patch });
  };
  try {
    update({ phase: "rollback" });
    const checkout = exec("git", ["checkout", job.target], sourceDir, 120_000);
    if (!checkout.ok) throw new Error("回滚切到 " + job.target + " 失败：" + checkout.error);
    const built = build(sourceDir);
    if (!built.ok) throw new Error("回滚构建失败：" + built.error);
    const restarted = restart(deps.services ?? []);
    if (!restarted.ok) throw new Error("回滚重启失败：" + restarted.error);
    const healthy = await verifyHealth(sourceDir, job.target);
    if (!healthy) throw new Error("回滚后健康验收未通过");
    const automaticRollback = job.error !== null;
    update({
      status: automaticRollback ? "rolled-back" : "done",
      phase: "done",
      finishedAt: isoNow(now),
      error: automaticRollback ? job.error : null,
    });
    audit.append({
      actor: BUTLER_SELF_ACTOR,
      action: "self-upgrade-rollback",
      target: sourceDir,
      detail: { jobId: job.jobId, target: job.target, from: job.from },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    update({ status: "failed", phase: "failed", finishedAt: isoNow(now), error: message });
    audit.append({
      actor: BUTLER_SELF_ACTOR,
      action: "self-upgrade-failed",
      target: sourceDir,
      detail: { jobId: job.jobId, error: message, rolledBack: false },
    });
  }
}

export function createButlerSelfUpgradeService(
  deps: ButlerSelfUpgradeDeps,
): ButlerSelfService {
  const now = deps.now ?? Date.now;
  const exec = deps.exec ?? defaultExec;
  const sourceDir = deps.sourceDir;
  const stateDir = join(deps.homeDir, SELF_STATE_DIR);
  const registryFile = join(stateDir, SELF_REGISTRY_FILE);
  const stateFile = join(stateDir, SELF_STATE_FILE);
  const prefsFile = join(stateDir, SELF_PREFS_FILE);
  const audit = deps.audit ?? { append() {} };
  let upgradePreparing = false;

  function git(args: string[], timeoutMs = 10_000): CommandResult {
    return exec("git", args, sourceDir, timeoutMs);
  }

  function currentVersion(): string {
    try {
      const pkg = JSON.parse(readFileSync(join(sourceDir, "package.json"), "utf8")) as {
        version?: string;
      };
      if (typeof pkg.version === "string" && pkg.version.trim() !== "") return pkg.version.trim();
    } catch {
      // 源码目录没有 package.json 时保留 dev 版本
    }
    return "0.0.0-dev";
  }

  function repoInfo(): {
    branch: string | null;
    commit: string | null;
    tag: string | null;
    repository: string | null;
    repoClean: boolean;
  } {
    const branchResult = git(["branch", "--show-current"]);
    const commitResult = git(["rev-parse", "--short", "HEAD"]);
    const tagResult = git(["describe", "--tags", "--exact-match", "--always"]);
    const remoteResult = git(["remote", "get-url", "origin"]);
    const statusResult = git(["status", "--porcelain"]);
    const tag = tagResult.ok && tagResult.stdout !== "" && !/^[0-9a-f]{7,40}$/i.test(tagResult.stdout)
      ? tagResult.stdout
      : null;
    return {
      branch: branchResult.ok && branchResult.stdout !== "" ? branchResult.stdout : null,
      commit: commitResult.ok && commitResult.stdout !== "" ? commitResult.stdout : null,
      tag,
      repository: remoteResult.ok && remoteResult.stdout !== "" ? remoteResult.stdout : null,
      repoClean: statusResult.ok && statusResult.stdout === "",
    };
  }

  function listUpdates(): ButlerAvailableUpdate[] {
    const map = new Map<string, { tag: string; commit: string | null }>();
    const local = git(["tag", "--list"]);
    if (local.ok && local.stdout !== "") {
      for (const tag of local.stdout.split("\n")) {
        const trimmed = tag.trim();
        if (trimmed === "") continue;
        const rev = git(["rev-parse", "--short", trimmed]);
        map.set(trimmed, { tag: trimmed, commit: rev.ok ? rev.stdout : null });
      }
    }
    const remote = git(["ls-remote", "--tags", "origin"], 30_000);
    if (remote.ok && remote.stdout !== "") {
      for (const line of remote.stdout.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) continue;
        const [hash, ref] = parts;
        const tag = ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "");
        if (tag === "" || tag.endsWith(".lock")) continue;
        const peeled = ref.endsWith("^{}");
        const existing = map.get(tag);
        if (existing === undefined || peeled) {
          map.set(tag, {
            tag,
            commit: peeled ? hash.slice(0, 7) : existing?.commit ?? hash.slice(0, 7),
          });
        }
      }
    }
    return [...map.entries()]
      .filter(([tag]) => isSemanticVersion(tag))
      .map(([tag, info]) => {
        const version = tag.replace(/^v/i, "");
        return {
          version,
          channel: channelOf(version),
          commit: info.commit,
          tag: info.tag,
        } satisfies ButlerAvailableUpdate;
      })
      .sort((a, b) => compareVersion(b.version, a.version));
  }

  function resolveTarget(target: string | undefined): ButlerAvailableUpdate | null {
    const updates = listUpdates();
    if (target === undefined || target.trim() === "") return updates[0] ?? null;
    const wanted = target.trim();
    const exact = updates.find(
      (item) => item.tag === wanted || item.version === wanted || item.commit === wanted,
    );
    if (exact !== undefined) return exact;
    const rev = git(["rev-parse", "--verify", wanted + "^{commit}"]);
    if (rev.ok) {
      return { version: wanted, channel: "stable", commit: rev.stdout.slice(0, 7), tag: wanted };
    }
    return null;
  }

  function inFlight(): ButlerSelfJobView | null {
    const job = readJson<ButlerSelfJobView | null>(stateFile, null);
    return job !== null && job.status === "running" ? job : null;
  }

  function writeJob(job: ButlerSelfJobView): void {
    writeJsonAtomic(stateFile, job);
  }

  function snapshots(): ButlerSelfSnapshot[] {
    return readJson<ButlerSelfSnapshot[]>(registryFile, []);
  }

  function pushSnapshot(snapshot: ButlerSelfSnapshot): void {
    const next = [snapshot, ...snapshots()].slice(0, SELF_SNAPSHOT_KEEP);
    writeJsonAtomic(registryFile, next);
  }

  function prefs(): ButlerSelfPrefs {
    const value = readJson<Partial<ButlerSelfPrefs>>(prefsFile, {});
    return {
      channel: value.channel === "beta" ? "beta" : "stable",
      locked: value.locked === true,
    };
  }

  function spawnRunner(job: ButlerSelfJobView): void {
    const runnerScript =
      deps.runnerScript ??
      join(dirname(new URL(import.meta.url).pathname), "self-upgrade-runner.js");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BUTLER_SRC: sourceDir,
      BUTLER_HOME: deps.homeDir,
      BUTLER_SELF_JOB_ID: job.jobId,
      BUTLER_SELF_KIND: job.kind,
      BUTLER_SELF_TARGET: job.target,
      BUTLER_SELF_FROM: job.from,
      BUTLER_SELF_SNAPSHOT_ID: job.snapshotId ?? "",
      BUTLER_SELF_SERVICES: (deps.services ?? []).join(" "),
    };
    if (deps.spawnDetached !== undefined) {
      deps.spawnDetached(runnerScript, env);
      return;
    }
    const child = spawn(process.execPath, [runnerScript], {
      detached: true,
      stdio: "ignore",
      env,
      cwd: sourceDir,
    });
    child.unref();
  }

  function startJob(input: {
    kind: "upgrade" | "rollback";
    target: string;
    from: string;
    snapshotId: string | null;
    trigger?: "manual" | "auto";
    reason: string;
  }): { started: true; jobId: string } | { started: false; error: string } {
    if (inFlight() !== null) return { started: false, error: "upgrade-in-flight" };
    const jobId = randomUUID();
    const job: ButlerSelfJobView = {
      jobId,
      kind: input.kind,
      status: "running",
      phase: "snapshot",
      target: input.target,
      from: input.from,
      startedAt: isoNow(now),
      finishedAt: null,
      error: null,
      snapshotId: input.snapshotId,
    };
    writeJob(job);
    audit.append({
      actor: BUTLER_SELF_ACTOR,
      action: input.kind === "upgrade" ? "self-upgrade-start" : "self-rollback-start",
      target: sourceDir,
      detail: {
        jobId,
        target: input.target,
        from: input.from,
        trigger: input.trigger ?? "manual",
        reason: input.reason,
      },
    });
    if (deps.runInline === true) {
      void (input.kind === "rollback"
        ? rollbackSelfJob(deps, job)
        : executeSelfJob(deps, job));
    } else {
      spawnRunner(job);
    }
    return { started: true, jobId };
  }

  return {
    status(): ButlerSelfStatus {
      const info = repoInfo();
      const lastJob = readJson<ButlerSelfJobView | null>(stateFile, null);
      return {
        reachable: existsSync(sourceDir),
        source: sourceDir,
        version: currentVersion(),
        branch: info.branch,
        commit: info.commit,
        tag: info.tag,
        repository: info.repository,
        repoClean: info.repoClean,
        remoteConfigured: info.repository !== null,
        prefs: prefs(),
        snapshots: snapshots(),
        snapshotRetention: SELF_SNAPSHOT_KEEP,
        availableUpdates: listUpdates(),
        lastJob,
        checkedAt: isoNow(now),
      };
    },

    async startUpgrade(input): Promise<SelfUpgradeOutcome> {
      if (input.confirmed !== true) return { status: "confirmation-required" };
      const info = repoInfo();
      if (info.commit === null) return { status: "no-repo" };
      if (upgradePreparing || inFlight() !== null) return { status: "upgrade-in-flight" };
      if (prefs().locked) return { status: "invalid-target" };
      const target = resolveTarget(input.target);
      if (target === null) return { status: input.target === undefined ? "no-target" : "invalid-target" };
      const channel = input.channel ?? prefs().channel;
      upgradePreparing = true;
      try {
        if (deps.backup === undefined) {
          throw new Error("backup service unavailable");
        }
        const backup = await deps.backup.runFull("管家自身升级前备份（" + target.version + "）");
        if (!Number.isInteger(backup.id) || backup.id <= 0) {
          throw new Error("backup did not return a valid id");
        }
        const snapshot: ButlerSelfSnapshot = {
          id: randomUUID(),
          at: isoNow(now),
          version: currentVersion(),
          commit: info.commit,
          tag: info.tag,
          channel,
          reason: "升级到 " + target.version,
          backupId: backup.id,
        };
        pushSnapshot(snapshot);
        const started = startJob({
          kind: "upgrade",
          target: target.tag ?? target.version,
          from: info.commit,
          snapshotId: snapshot.id,
          trigger: input.trigger ?? "manual",
          reason: "升级到 " + target.version + "（" + channel + "）",
        });
        if (!started.started) return { status: "upgrade-in-flight" };
        return { status: "started", jobId: started.jobId, snapshotId: snapshot.id };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        audit.append({
          actor: BUTLER_SELF_ACTOR,
          action: "self-upgrade-backup-failed",
          target: sourceDir,
          detail: { target: target.version, error: message },
        });
        return { status: "backup-failed", error: message };
      } finally {
        upgradePreparing = false;
      }
    },

    rollback(input): SelfRollbackOutcome {
      if (input.confirmed !== true) return { status: "confirmation-required" };
      const info = repoInfo();
      if (info.commit === null) return { status: "no-repo" };
      if (upgradePreparing || inFlight() !== null) return { status: "upgrade-in-flight" };
      const snapshot = snapshots().find((item) => item.id === input.snapshotId);
      if (snapshot === undefined) return { status: "snapshot-not-found" };
      const started = startJob({
        kind: "rollback",
        target: snapshot.commit,
        from: info.commit,
        snapshotId: snapshot.id,
        reason: "回滚到 " + snapshot.version + "（" + snapshot.commit + "）",
      });
      if (!started.started) return { status: "upgrade-in-flight" };
      return { status: "started", jobId: started.jobId };
    },

    updatePrefs(input): ButlerSelfPrefs {
      const current = prefs();
      const next: ButlerSelfPrefs = {
        channel:
          input.channel === "beta" || input.channel === "stable" ? input.channel : current.channel,
        locked: input.locked ?? current.locked,
      };
      writeJsonAtomic(prefsFile, next);
      audit.append({
        actor: BUTLER_SELF_ACTOR,
        action: "self-prefs-updated",
        target: sourceDir,
        detail: { channel: next.channel, locked: next.locked },
      });
      return next;
    },
  };
}

/** detached 子进程入口：读环境变量后执行升级/回滚流水线。 */
export async function runSelfUpgradeRunnerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const sourceDir = env["BUTLER_SRC"]?.trim() ?? "";
  const homeDir = env["BUTLER_HOME"]?.trim() ?? "";
  const jobId = env["BUTLER_SELF_JOB_ID"]?.trim() ?? "";
  const kind = env["BUTLER_SELF_KIND"] === "rollback" ? "rollback" : "upgrade";
  const target = env["BUTLER_SELF_TARGET"]?.trim() ?? "";
  const from = env["BUTLER_SELF_FROM"]?.trim() ?? "";
  const snapshotId = env["BUTLER_SELF_SNAPSHOT_ID"]?.trim() || null;
  const services = (env["BUTLER_SELF_SERVICES"] ?? "")
    .split(/\s+/)
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (sourceDir === "" || homeDir === "" || jobId === "" || target === "" || from === "") {
    throw new Error("self-upgrade runner: 缺少必要环境变量");
  }
  const deps: ButlerSelfUpgradeDeps = { sourceDir, homeDir, services };
  const job: ButlerSelfJobView = {
    jobId,
    kind,
    status: "running",
    phase: "snapshot",
    target,
    from,
    startedAt: isoNow(Date.now),
    finishedAt: null,
    error: null,
    snapshotId,
  };
  const stateFile = join(homeDir, SELF_STATE_DIR, SELF_STATE_FILE);
  writeJsonAtomic(stateFile, job);
  if (kind === "rollback") {
    await rollbackSelfJob(deps, job);
  } else {
    await executeSelfJob(deps, job);
  }
}
