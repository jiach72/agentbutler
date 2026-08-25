import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  fail,
  ok,
  type ConfigValidation,
  type ControlAck,
  type ControlAdapter,
  type InstanceRef,
  type Job,
  type JobStep,
  type Result,
  type SnapshotRef,
  type SnapshotScope,
  type StartOpts,
  type StopOpts,
  type UpgradeOpts,
  type VersionRef,
} from "@butler/contract";

export interface ExecResult { code: number; stdout: string; stderr: string }
export interface OpenClawExecOptions { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }
export type OpenClawExecutor = (command: string, args: string[], options?: OpenClawExecOptions) => Promise<ExecResult>;

function defaultExec(command: string, args: string[], options: OpenClawExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd: options.cwd, timeout: options.timeoutMs, env: options.env, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 127, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

export interface OpenClawControlOptions {
  exec?: OpenClawExecutor;
  snapshotsDir?: string;
  /** 将成功快照登记到宿主 Core store，供 Watch/M4 绑定本次快照。 */
  snapshotRecorder?: (input: { instanceId: string; scope: SnapshotScope; snapshotId: string }) => void;
}

function rootPath(ref: InstanceRef): string | null {
  return ref.rootPath ?? (ref.instanceId.includes("|") ? ref.instanceId.slice(ref.instanceId.indexOf("|") + 1) : null);
}

function openClawEnv(root: string): NodeJS.ProcessEnv {
  return { ...process.env, OPENCLAW_HOME: dirname(root), OPENCLAW_STATE_DIR: root };
}

function job(kind: Job["kind"], label: string, detail?: string): Job {
  const step = { id: `${kind}-done`, label, status: "passed" as const, ...(detail ? { detail } : {}) };
  return { jobId: `openclaw-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, kind, steps: [step] };
}

function commandFailure(result: ExecResult, action: string, startedAt: number): Result<never> {
  const detail = result.stderr.split(/\r?\n/)[0] || `exit ${result.code}`;
  return fail("E203", `OpenClaw ${action} failed: ${detail}`, { startedAt, userHint: `OpenClaw ${action} 失败，请查看诊断输出` });
}

interface SnapshotCapture {
  job: Job;
  snapshotId: string;
}

interface SnapshotManifestEntry {
  item: string;
  snapshotRelative: string;
  restoreRelative: string;
}

function pathInside(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function snapshotSources(root: string, item: string): string[] {
  if (item === "config") return [join(root, "openclaw.json")];
  if (item === "workspace") return [join(root, "workspace")];
  if (item === "state") return [join(root, "state")];
  if (item === "skills") {
    return [join(root, "workspace", "skills"), join(root, "skills")];
  }
  if (item === "memory") {
    return [
      join(root, "workspace", "MEMORY.md"),
      join(root, "workspace", "memory.md"),
      join(root, "workspace", "memory"),
      join(root, "memory"),
    ];
  }
  return [join(root, item)];
}

function snapshotDestination(destination: string, root: string, item: string, source: string): string {
  if (item === "memory") {
    return join(destination, "memory", relative(root, source));
  }
  if (item === "skills") return join(destination, "skills");
  if (item === "config") return join(destination, "config");
  return join(destination, item);
}

function parseVersion(output: string): string | null {
  const match = output.trim().match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/i);
  return match?.[1] ?? null;
}

export function createOpenClawControl(options: OpenClawControlOptions = {}): ControlAdapter {
  const run = options.exec ?? defaultExec;
  const jobs = new Map<string, Job>();
  const snapshotsDir = options.snapshotsDir ?? join(process.env["BUTLER_HOME"] ?? process.cwd(), "snapshots", "openclaw");

  const captureSnapshot = async (ref: InstanceRef, scope: SnapshotScope): Promise<Result<SnapshotCapture>> => {
    const startedAt = Date.now();
    const root = rootPath(ref);
    if (!root) return fail("E002", "OpenClaw instance rootPath is required", { startedAt, userHint: "缺少 OpenClaw 实例目录" });
    const snapshotId = `openclaw-${randomUUID()}`;
    const destination = join(snapshotsDir, snapshotId);
    const steps: JobStep[] = [];
    try {
      mkdirSync(destination, { recursive: true });
      const include = scope.include.length > 0 ? scope.include : ["config", "workspace", "state"];
      const manifest: SnapshotManifestEntry[] = [];
      for (const item of include) {
        const candidates = snapshotSources(root, item).filter(
          (candidate) => pathInside(candidate, root) && existsSync(candidate),
        );
        const sources = item === "memory" ? candidates : candidates.slice(0, 1);
        if (sources.length === 0) {
          steps.push({
            id: `copy-${item}`,
            label: `复制 ${item}`,
            status: "skipped",
            detail: `目标不存在：${snapshotSources(root, item).join(", ")}`,
          });
          continue;
        }
        try {
          for (const source of sources) {
            const target = snapshotDestination(destination, root, item, source);
            if (!pathInside(target, destination)) throw new Error(`snapshot target escapes destination: ${target}`);
            mkdirSync(dirname(target), { recursive: true });
            cpSync(source, target, { recursive: true });
            manifest.push({
              item,
              snapshotRelative: relative(destination, target),
              restoreRelative: relative(root, source),
            });
          }
          steps.push({ id: `copy-${item}`, label: `复制 ${item}`, status: "passed" });
        } catch (error) {
          steps.push({
            id: `copy-${item}`,
            label: `复制 ${item}`,
            status: "failed",
            detail: String(error),
          });
        }
      }
      const failed = steps.some((step) => step.status !== "passed");
      if (!failed) writeFileSync(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
      if (!failed && options.snapshotRecorder !== undefined) {
        options.snapshotRecorder({ instanceId: ref.instanceId, scope, snapshotId });
      }
      if (failed) {
        rmSync(destination, { recursive: true, force: true });
      }
      return ok(
        {
          job: {
            jobId: `openclaw-snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            kind: "snapshot",
            steps,
          },
          snapshotId,
        },
        startedAt,
      );
    } catch (error) {
      rmSync(destination, { recursive: true, force: true });
      return fail("E203", `failed to snapshot OpenClaw: ${String(error)}`, { startedAt, userHint: "OpenClaw 快照失败" });
    }
  };

  const snapshotImpl = async (ref: InstanceRef, scope: SnapshotScope): Promise<Result<Job>> => {
    const startedAt = Date.now();
    const captured = await captureSnapshot(ref, scope);
    if (!captured.ok || captured.data === undefined) {
      return fail(captured.error?.code ?? "E203", captured.error?.message ?? "OpenClaw 快照失败", {
        startedAt,
        userHint: captured.error?.userHint,
        cause: captured.error?.cause,
      });
    }
    return ok(captured.data.job, startedAt);
  };

  const validateConfigImpl = async (ref: InstanceRef): Promise<Result<ConfigValidation>> => {
    const startedAt = Date.now();
    const root = rootPath(ref);
    if (!root) return fail("E002", "OpenClaw instance rootPath is required", { startedAt, userHint: "缺少 OpenClaw 实例目录" });
    const result = await run("openclaw", ["config", "validate", "--json"], { cwd: root, timeoutMs: 120_000, env: openClawEnv(root) });
    if (result.code !== 0) return commandFailure(result, "配置校验", startedAt);
    try {
      const parsed = JSON.parse(result.stdout) as { valid?: boolean; errors?: unknown[]; warnings?: unknown[] };
      const violations = [
        ...(Array.isArray(parsed.errors) ? parsed.errors.map((detail) => ({ invariant: "openclaw-config", detail: String(detail), severity: "block" as const })) : []),
        ...(Array.isArray(parsed.warnings) ? parsed.warnings.map((detail) => ({ invariant: "openclaw-config", detail: String(detail), severity: "warn" as const })) : []),
      ];
      return ok({ passed: parsed.valid !== false && !violations.some((item) => item.severity === "block"), violations } satisfies ConfigValidation, startedAt);
    } catch (error) {
      return fail("E103", `invalid OpenClaw config validate output: ${String(error)}`, { startedAt, userHint: "OpenClaw 配置校验返回了无法识别的结果" });
    }
  };

  const readInstalledVersion = async (ref: InstanceRef, startedAt: number): Promise<Result<string>> => {
    const root = rootPath(ref);
    if (!root) return fail("E002", "OpenClaw instance rootPath is required", { startedAt, userHint: "缺少 OpenClaw 实例目录" });
    const result = await run("openclaw", ["--version"], { cwd: root, timeoutMs: 30_000, env: openClawEnv(root) });
    if (result.code !== 0) return commandFailure(result, "读取当前版本", startedAt);
    const version = parseVersion(result.stdout);
    if (!version) {
      return fail("E103", `unable to parse OpenClaw version from: ${result.stdout.trim()}`, {
        startedAt,
        userHint: "无法读取当前 OpenClaw 版本，已拒绝升级以确保失败可回滚",
      });
    }
    return ok(version, startedAt);
  };

  const restoreSnapshotFiles = async (ref: InstanceRef, snapshotId: string, startedAt: number): Promise<Result<Job>> => {
    const root = rootPath(ref);
    if (!root) return fail("E002", "OpenClaw instance rootPath is required", { startedAt, userHint: "缺少 OpenClaw 实例目录" });
    const source = join(snapshotsDir, snapshotId);
    if (!existsSync(source)) return fail("E204", `snapshot not found: ${snapshotId}`, { startedAt, userHint: "找不到指定快照" });
    try {
      const manifestPath = join(source, "manifest.json");
      let manifest: SnapshotManifestEntry[] | null = null;
      if (existsSync(manifestPath)) {
        const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
        if (!Array.isArray(parsed)) throw new Error("snapshot manifest is not an array");
        manifest = parsed.filter(
          (entry): entry is SnapshotManifestEntry =>
            entry !== null &&
            typeof entry === "object" &&
            typeof (entry as Record<string, unknown>)["item"] === "string" &&
            typeof (entry as Record<string, unknown>)["snapshotRelative"] === "string" &&
            typeof (entry as Record<string, unknown>)["restoreRelative"] === "string" &&
            (entry as Record<string, unknown>)["snapshotRelative"] !== "" &&
            (entry as Record<string, unknown>)["snapshotRelative"] !== "." &&
            (entry as Record<string, unknown>)["restoreRelative"] !== "" &&
            (entry as Record<string, unknown>)["restoreRelative"] !== ".",
        );
        if (manifest.length !== parsed.length) throw new Error("snapshot manifest contains invalid entries");
      }
      const entries =
        manifest ??
        ["config", "workspace", "state"].map((item) => ({
          item,
          snapshotRelative: item,
          restoreRelative: item === "config" ? "openclaw.json" : item,
        }));
      for (const entry of entries) {
        const from = resolve(source, entry.snapshotRelative);
        const to = resolve(root, entry.restoreRelative);
        if (!pathInside(from, source) || !pathInside(to, root) || !existsSync(from)) {
          throw new Error(`snapshot manifest path is invalid or missing: ${entry.item}`);
        }
        if (existsSync(to)) rmSync(to, { recursive: true, force: true });
        mkdirSync(dirname(to), { recursive: true });
        cpSync(from, to, { recursive: true });
      }
      return ok(job("rollback", `已回滚 OpenClaw 快照 ${snapshotId}`), startedAt);
    } catch (error) {
      return fail("E204", `failed to rollback OpenClaw files: ${String(error)}`, { startedAt, userHint: "OpenClaw 数据回滚失败" });
    }
  };

  const restorePackage = async (ref: InstanceRef, version: string, timeoutSec: number, startedAt: number): Promise<Result<Job>> => {
    const root = rootPath(ref);
    if (!root) return fail("E002", "OpenClaw instance rootPath is required", { startedAt, userHint: "缺少 OpenClaw 实例目录" });
    const result = await run("npm", ["install", "--global", `openclaw@${version}`], {
      cwd: root,
      timeoutMs: timeoutSec * 1_000,
      env: openClawEnv(root),
    });
    if (result.code !== 0) return commandFailure(result, `恢复到 ${version}`, startedAt) as Result<Job>;
    return ok(job("rollback", `已恢复 OpenClaw 包到 ${version}`), startedAt);
  };

  const rollbackUpgrade = async (
    ref: InstanceRef,
    snapshotId: string,
    previousVersion: string,
    timeoutSec: number,
    startedAt: number,
  ): Promise<{ ok: true; detail: string } | { ok: false; detail: string }> => {
    const fileRollback = await restoreSnapshotFiles(ref, snapshotId, startedAt);
    const packageRollback = await restorePackage(ref, previousVersion, timeoutSec, startedAt);
    const failures: string[] = [];
    if (!fileRollback.ok) failures.push(`数据恢复失败：${fileRollback.error?.userHint ?? fileRollback.error?.message}`);
    if (!packageRollback.ok) failures.push(`包版本恢复失败：${packageRollback.error?.userHint ?? packageRollback.error?.message}`);
    if (failures.length > 0) return { ok: false, detail: failures.join("；") };
    return { ok: true, detail: `已恢复快照 ${snapshotId} 与 OpenClaw 包 ${previousVersion}` };
  };

  const failUpgrade = async (
    ref: InstanceRef,
    reason: string,
    opts: UpgradeOpts,
    snapshotId: string | undefined,
    previousVersion: string | undefined,
    timeoutSec: number,
    startedAt: number,
  ): Promise<Result<never>> => {
    if (opts.skipSnapshot === true || snapshotId === undefined || previousVersion === undefined) {
      return fail("E203", `${reason}；未创建升级前快照，无法自动回滚，需要人工介入`, {
        startedAt,
        userHint: "OpenClaw 升级失败且未启用自动回滚，请人工检查实例状态",
      });
    }
    const rollback = await rollbackUpgrade(ref, snapshotId, previousVersion, timeoutSec, startedAt);
    if (rollback.ok) {
      return fail("E203", `${reason}；已自动回滚（${rollback.detail}）`, {
        startedAt,
        userHint: "OpenClaw 升级失败，已自动回滚到升级前状态",
      });
    }
    return fail("E204", `${reason}；自动回滚失败，需要人工介入：${rollback.detail}`, {
      startedAt,
      userHint: "OpenClaw 升级与自动回滚均失败，需要人工介入",
    });
  };

  const control = async (ref: InstanceRef, action: "start" | "stop" | "restart", args: string[], timeoutSec: number | undefined): Promise<Result<ControlAck>> => {
    const startedAt = Date.now();
    const root = rootPath(ref);
    if (!root) return fail("E002", "OpenClaw instance rootPath is required", { startedAt, userHint: "缺少 OpenClaw 实例目录" });
    if (action !== "stop") {
      const validation = await validateConfigImpl(ref);
      if (!validation.ok) {
        return fail(validation.error?.code ?? "E103", validation.error?.message ?? "OpenClaw 配置校验失败", {
          startedAt,
          userHint: validation.error?.userHint,
        });
      }
      const config = validation.data;
      if (config === undefined) {
        return fail("E103", "OpenClaw 配置校验缺少结果", { startedAt, userHint: "OpenClaw 配置校验返回空结果" });
      }
      if (!config.passed) {
        const blocked = config.violations
          .filter((violation) => violation.severity === "block")
          .map((violation) => violation.detail)
          .join("；");
        return fail("E203", `OpenClaw ${action} blocked by configuration invariants: ${blocked}`, {
          startedAt,
          userHint: `配置安全规则未通过，已拒绝${action === "restart" ? "重启" : "启动"}：${blocked}`,
        });
      }
    }
    const result = await run("openclaw", ["gateway", ...args], { cwd: root, timeoutMs: (timeoutSec ?? 60) * 1_000, env: openClawEnv(root) });
    if (result.code !== 0) return commandFailure(result, action, startedAt);
    return ok({ instanceId: ref.instanceId, action, startedAt: new Date(startedAt).toISOString() }, startedAt);
  };

  return {
    start: (ref, opts?: StartOpts) => control(ref, "start", ["start"], opts?.timeoutSec),
    stop: (ref, opts?: StopOpts) => control(ref, "stop", ["stop"], opts?.timeoutSec),
    restart: (ref) => control(ref, "restart", ["restart"], 60),
    async upgrade(ref: InstanceRef, target: VersionRef, opts: UpgradeOpts & { idempotencyKey: string }) {
      const startedAt = Date.now();
      const previous = jobs.get(opts.idempotencyKey);
      if (previous) return ok(previous, startedAt);
      const root = rootPath(ref);
      if (!root) return fail("E002", "OpenClaw instance rootPath is required", { startedAt, userHint: "缺少 OpenClaw 实例目录" });
      if (opts.dryRun === true) {
        const planned = job("upgrade", `升级 OpenClaw 到 ${target.version}`, "dry-run：未执行 npm install");
        jobs.set(opts.idempotencyKey, planned);
        return ok(planned, startedAt);
      }
      const beforeValidation = await validateConfigImpl(ref);
      if (!beforeValidation.ok || beforeValidation.data === undefined) {
        return fail(beforeValidation.error?.code ?? "E103", beforeValidation.error?.message ?? "OpenClaw 升级前配置校验失败", {
          startedAt,
          userHint: beforeValidation.error?.userHint ?? "OpenClaw 升级前配置校验失败，已拒绝升级",
          cause: beforeValidation.error?.cause,
        });
      }
      if (!beforeValidation.data.passed) {
        const blocked = beforeValidation.data.violations
          .filter((item) => item.severity === "block")
          .map((item) => item.detail)
          .join("；") || "valid=false";
        return fail("E203", `OpenClaw 升级前配置不满足安全不变式：${blocked}`, {
          startedAt,
          userHint: "OpenClaw 当前配置未通过安全校验，已拒绝升级",
        });
      }
      const previousVersion = await readInstalledVersion(ref, startedAt);
      if (!previousVersion.ok || previousVersion.data === undefined) {
        return fail(previousVersion.error?.code ?? "E103", previousVersion.error?.message ?? "无法读取 OpenClaw 当前版本", {
          startedAt,
          userHint: previousVersion.error?.userHint,
          cause: previousVersion.error?.cause,
        });
      }
      const timeoutSec = opts.timeoutSec ?? 600;
      let snapshotId: string | undefined;
      if (opts.skipSnapshot !== true) {
        const snapshot = await captureSnapshot(ref, { include: ["config", "workspace", "state"], label: "before-openclaw-upgrade" });
        if (!snapshot.ok || snapshot.data === undefined) {
          return fail(snapshot.error?.code ?? "E203", snapshot.error?.message ?? "OpenClaw 快照失败", {
            startedAt,
            userHint: snapshot.error?.userHint,
            cause: snapshot.error?.cause,
          });
        }
        const incomplete = snapshot.data.job.steps.find((step) => step.status !== "passed");
        if (incomplete !== undefined) {
          return fail("E203", `OpenClaw 升级前快照未完成：${incomplete.detail ?? incomplete.label}`, {
            startedAt,
            userHint: "OpenClaw 升级前快照未完整生成，已拒绝升级",
          });
        }
        snapshotId = snapshot.data.snapshotId;
      }
      const installed = await run("npm", ["install", "--global", `openclaw@${target.version}`], { cwd: root, timeoutMs: timeoutSec * 1_000, env: openClawEnv(root) });
      if (installed.code !== 0) {
        return failUpgrade(ref, `OpenClaw 升级失败：${installed.stderr.split(/\r?\n/)[0] || `exit ${installed.code}`}`, opts, snapshotId, previousVersion.data, timeoutSec, startedAt);
      }
      const validation = await validateConfigImpl(ref);
      if (!validation.ok) {
        return failUpgrade(ref, `OpenClaw 升级后配置校验失败：${validation.error?.userHint ?? validation.error?.message}`, opts, snapshotId, previousVersion.data, timeoutSec, startedAt);
      }
      if (validation.data === undefined || !validation.data.passed) {
        const blocked = validation.data?.violations.filter((item) => item.severity === "block").map((item) => item.detail).join("；") || "valid=false";
        return failUpgrade(ref, `OpenClaw 升级后配置不满足安全不变式：${blocked}`, opts, snapshotId, previousVersion.data, timeoutSec, startedAt);
      }
      const result = job("upgrade", `已升级 OpenClaw 到 ${target.version}`);
      jobs.set(opts.idempotencyKey, result);
      return ok(result, startedAt);
    },
    snapshot: snapshotImpl,
    async rollback(ref: InstanceRef, snapshot: SnapshotRef) {
      return restoreSnapshotFiles(ref, snapshot.snapshotId, Date.now());
    },
    validateConfig: validateConfigImpl,
  };
}
