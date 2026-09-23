import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile as execFileCallback, exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  closeSync,
} from "node:fs";
import { basename, delimiter, dirname, extname, join } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";

const execFile = promisify(execFileCallback);
const exec = promisify(execCallback);

type CommandResult = { ok: boolean; stdout: string; error: string };
type JobStatus = "running" | "done" | "failed" | "rolled-back";
type Job = {
  jobId: string;
  kind: "upgrade" | "rollback";
  status: JobStatus;
  phase: string;
  target: string;
  from: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  snapshotId: string | null;
};

const sourceDir = process.env["BUTLER_UPDATER_SOURCE"]?.trim() || "/workspace";
const homeDir = process.env["BUTLER_HOME"]?.trim() || "/home/butler";
const host = process.env["BUTLER_UPDATER_HOST"]?.trim() || "0.0.0.0";
const port = Number(process.env["BUTLER_UPDATER_PORT"] ?? 7540) || 7540;
const stateDir = join(homeDir, "self-upgrade");
const stateFile = join(stateDir, "state.json");
const statusFile = join(stateDir, "updater-status.json");
const lockFile = join(stateDir, "updater.lock");
const repositoryUrl = process.env["BUTLER_REPOSITORY_URL"]?.trim().replace(/\.git$/, "") || null;
const composeProjectDir = process.env["BUTLER_COMPOSE_PROJECT_DIR"]?.trim() || sourceDir;
const composeFile = process.env["BUTLER_COMPOSE_FILE"]?.trim() || "docker-compose.yml";
const composeBinary = process.env["BUTLER_COMPOSE_BIN"]?.trim() || "docker";
const corepackBinary = process.env["BUTLER_UPDATER_COREPACK_BIN"]?.trim() || "corepack";
const services = (process.env["BUTLER_UPDATER_SERVICES"] ?? "butler-gateway butler-watch butler-web")
  .split(/\s+/)
  .map((value) => value.trim())
  .filter(Boolean);
const healthUrls = (process.env["BUTLER_UPDATER_HEALTH_URLS"]
  ?? "http://butler-web:7531/api/health,http://butler-watch:7533/healthz,http://butler-gateway:7532/healthz")
  .split(/[\s,]+/)
  .map((value) => value.trim())
  .filter((value) => value !== "");

/**
 * 访问口令：updater 会执行 git checkout、重建镜像、重启服务，是这个项目里破坏性最强的组件。
 * 没有口令时必须拒绝一切请求，否则容器网络内任何人都能触发它。
 */
// 优先使用独立口令 BUTLER_UPDATER_ACCESS_TOKEN，实现与面板口令的分层与轮换隔离；
// 其次回退内部调用口令 BUTLER_INTERNAL_TOKEN，最后回退共享的 BUTLER_ACCESS_TOKEN。
const accessToken = (
  process.env["BUTLER_UPDATER_ACCESS_TOKEN"] ??
  process.env["BUTLER_INTERNAL_TOKEN"] ??
  process.env["BUTLER_ACCESS_TOKEN"] ??
  ""
).trim();

function extractToken(request: IncomingMessage): string {
  const auth = request.headers["authorization"];
  if (typeof auth === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1]) return match[1].trim();
  }
  const header = request.headers["x-butler-token"];
  if (typeof header === "string" && header !== "") return header.trim();
  const internal = request.headers["x-butler-internal-token"];
  if (typeof internal === "string" && internal !== "") return internal.trim();
  return "";
}

function tokensMatch(expected: string, received: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const receivedBytes = Buffer.from(received, "utf8");
  return expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes);
}

let active = false;

function now(): string {
  return new Date().toISOString();
}

/**
 * 允许作为 git 检出目标的版本标识。
 * 只放行字母数字与 . _ / - ，且不允许以 - 开头 —— 否则 target 会被 git 当成命令行开关。
 */
const SAFE_TARGET = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function validateTarget(raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  const value = raw.trim();
  if (value === "") return { ok: false, reason: "missing-target" };
  if (value.length > 200) return { ok: false, reason: "target-too-long" };
  if (!SAFE_TARGET.test(value)) return { ok: false, reason: "invalid-target" };
  return { ok: true, value };
}

/**
 * 所有子进程调用都是异步的：checkout/install-build/restart 阶段可能长达数十分钟，
 * 事件循环一旦被同步进程调用占住，/healthz 与 /api/status 会一起失联，
 * 面板会把"正在升级"误判为"管家挂了"。异步是升级期可观测性的前提。
 */
async function run(command: string, args: string[], cwd = sourceDir, timeout = 120_000): Promise<CommandResult> {
  const options = {
    cwd,
    encoding: "utf8" as const,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  };
  try {
    const { stdout } = isWindowsBatchCommand(command)
      ? await exec(windowsCommandLine(command, args), options)
      : await execFile(command, args, options);
    return { ok: true, stdout: stdout.trim(), error: "" };
  } catch (error) {
    const detail = error as { stderr?: Buffer | string; message?: string; killed?: boolean };
    const message = detail.killed === true
      ? `命令超时被终止（>${Math.round(timeout / 1000)}s）`
      : detail.stderr !== undefined && String(detail.stderr).trim() !== ""
        ? String(detail.stderr).trim()
        : detail.message ?? String(error);
    return { ok: false, stdout: "", error: message };
  }
}

/**
 * Node cannot execute .cmd/.bat files through execFile on Windows. corepack and
 * configured Compose executables can be command scripts there, so invoke only those through cmd.exe.
 * All updater-controlled arguments are validated before reaching this boundary.
 */
function isWindowsBatchCommand(command: string): boolean {
  if (process.platform !== "win32") return false;
  if (/\.(?:cmd|bat)$/i.test(extname(command))) return true;
  const pathEntries = (process.env["PATH"] ?? "").split(delimiter).filter(Boolean);
  return pathEntries.some((entry) =>
    [".cmd", ".bat"].some((extension) => existsSync(join(entry, command + extension))),
  );
}

function windowsCommandLine(command: string, args: string[]): string {
  return ["call", quoteWindowsArgument(command), ...args.map(quoteWindowsArgument)].join(" ");
}

function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function packageVersion(): string {
  const pkg = readJson<{ version?: string }>(join(sourceDir, "package.json"), {});
  return typeof pkg.version === "string" && pkg.version.trim() !== "" ? pkg.version.trim() : "0.0.0-dev";
}

function git(args: string[], timeout = 20_000): Promise<CommandResult> {
  return run("git", args, sourceDir, timeout);
}

function isLegacyTag(tag: string): boolean {
  // 历史遗留 tag（切换到 0.1-beta.YYMMDD 体系前的 1.0.0-beta.1 ~ 31，SemVer 会误判为高于 0.1.x）
  return /^v?1\.0\.0-beta\.\d+$/.test(tag);
}

function semanticVersion(value: string): boolean {
  if (isLegacyTag(value)) return false;
  return /^(?:v)?\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

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

const PRERELEASE_ORDER: Record<string, number> = {
  dev: 10,
  alpha: 20,
  beta: 30,
  rc: 40,
};

function compareIdentifier(a: string, b: string): number {
  const aRank = PRERELEASE_ORDER[a.toLowerCase()];
  const bRank = PRERELEASE_ORDER[b.toLowerCase()];
  if (aRank !== undefined && bRank !== undefined) {
    return aRank - bRank;
  }
  return a.localeCompare(b);
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
    return compareIdentifier(leftPart, rightPart);
  }
  return 0;
}

function channelOf(version: string): "stable" | "beta" {
  return version.includes("-") ? "beta" : "stable";
}

async function updates(): Promise<Array<{ version: string; channel: "stable" | "beta"; commit: string | null; tag: string }>> {
  const result = await git(["tag", "--list"]);
  if (!result.ok) return [];
  const tags = result.stdout
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "" && semanticVersion(tag));
  if (tags.length === 0) return [];
  // 一次 rev-parse 解析全部 tag，避免每个 tag 一个子进程的 N+1 调用。
  const revs = await git(["rev-parse", "--short", ...tags]);
  const revList = revs.ok ? revs.stdout.split("\n").map((line) => line.trim()) : [];
  return tags
    .map((tag, index) => {
      const version = tag.replace(/^v/i, "");
      return { version, channel: channelOf(version), commit: revList[index] ?? null, tag };
    })
    .sort((left, right) => compareVersion(right.version, left.version));
}

/** 仓库侧状态（git 探测 + 版本偏好 + 快照清单），与进行中的任务信息分开缓存。 */
type RepoView = {
  reachable: boolean;
  source: string;
  version: string;
  branch: string | null;
  commit: string | null;
  tag: string | null;
  repository: string | null;
  repositorySource: string | null;
  repositoryConfigured: boolean;
  repoClean: boolean | null;
  remoteConfigured: boolean;
  upgradeSupported: boolean;
  prefs: { channel: string; locked: boolean };
  snapshots: unknown[];
  snapshotRetention: number;
  availableUpdates: Awaited<ReturnType<typeof updates>>;
};

/**
 * 仓库视图缓存：/api/status 曾在每次被调用时同步执行 5+ 个 git 子进程，
 * 面板 2s 轮询一次等于持续拖住事件循环。这里以 10s TTL 复用计算结果。
 */
const REPO_VIEW_TTL_MS = 10_000;
let repoViewCache: { at: number; view: RepoView } | null = null;

async function computeRepoView(): Promise<RepoView> {
  const branch = await git(["branch", "--show-current"]);
  const commit = await git(["rev-parse", "--short", "HEAD"]);
  const tagResult = await git(["describe", "--tags", "--exact-match", "--always"]);
  const remote = await git(["remote", "get-url", "origin"]);
  const clean = await git(["status", "--porcelain"]);
  const tag = tagResult.ok && tagResult.stdout !== "" && !/^[0-9a-f]{7,40}$/i.test(tagResult.stdout)
    ? tagResult.stdout
    : null;
  return {
    reachable: existsSync(sourceDir),
    source: sourceDir,
    version: packageVersion(),
    branch: branch.ok && branch.stdout !== "" ? branch.stdout : null,
    commit: commit.ok && commit.stdout !== "" ? commit.stdout : null,
    tag,
    repository: remote.ok && remote.stdout !== "" ? remote.stdout.replace(/\.git$/, "") : repositoryUrl,
    repositorySource: remote.ok ? "git-origin" : repositoryUrl === null ? null : "configured-default",
    repositoryConfigured: remote.ok || repositoryUrl !== null,
    repoClean: clean.ok ? clean.stdout === "" : null,
    remoteConfigured: remote.ok,
    upgradeSupported: commit.ok,
    prefs: readJson(join(stateDir, "prefs.json"), { channel: "stable", locked: false }),
    snapshots: readJson(join(stateDir, "snapshots.json"), []),
    snapshotRetention: 3,
    availableUpdates: await updates(),
  };
}

async function repoView(): Promise<RepoView> {
  if (repoViewCache !== null && Date.now() - repoViewCache.at < REPO_VIEW_TTL_MS) {
    return repoViewCache.view;
  }
  const view = await computeRepoView();
  repoViewCache = { at: Date.now(), view };
  return view;
}

function normalizeJob(job: Job | null): Job | null {
  if (job === null) return null;
  // 如果进程当前未在执行升级/回滚（active 为 false），但任务状态却为 running，
  // 或任务启动时间超过 30 分钟，说明上一次执行被外部中断或容器重启终止。
  const started = Date.parse(job.startedAt);
  const isExpired = !Number.isNaN(started) && Date.now() - started > 30 * 60_000;
  if (job.status === "running" && (!active || isExpired)) {
    const expired: Job = {
      ...job,
      status: "failed",
      phase: "failed",
      finishedAt: job.finishedAt ?? now(),
      error: job.error ?? "升级任务被服务重启或外部中断终止",
    };
    writeJson(stateFile, expired);
    return expired;
  }
  return job;
}

/** 组装对外状态视图。升级进行中绝不触碰 git（工作树正被 checkout/构建），用缓存仓库视图 + 实时 job。 */
async function statusView(lastJob: Job | null): Promise<Record<string, unknown>> {
  const normalized = normalizeJob(lastJob);
  const view = active && repoViewCache !== null ? repoViewCache.view : await repoView();
  return { ...view, lastJob: normalized, checkedAt: now() };
}

async function persistStatus(lastJob?: Job | null): Promise<void> {
  const cachedJob = lastJob === undefined ? readJson<Job | null>(stateFile, null) : lastJob;
  writeJson(statusFile, await statusView(cachedJob));
}

async function waitHealthy(): Promise<boolean> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    let healthy = true;
    for (const endpoint of healthUrls) {
      try {
        const response = await fetch(endpoint, { signal: AbortSignal.timeout(3_000) });
        if (!response.ok) healthy = false;
      } catch {
        healthy = false;
      }
    }
    if (healthy) return true;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}

async function composeUp(): Promise<CommandResult> {
  const composeArgs = ["docker-compose", "docker-compose.exe", "docker-compose.cmd", "docker-compose.bat"].includes(basename(composeBinary).toLowerCase())
    ? []
    : ["compose"];
  return run(
    composeBinary,
    [...composeArgs, "--project-directory", composeProjectDir, "-f", join(composeProjectDir, composeFile), "up", "-d", "--build", ...services],
    sourceDir,
    15 * 60_000,
  );
}

async function build(): Promise<CommandResult> {
  const install = await run(corepackBinary, ["pnpm", "install", "--frozen-lockfile"], sourceDir, 15 * 60_000);
  if (!install.ok) return install;
  return run(corepackBinary, ["pnpm", "build"], sourceDir, 15 * 60_000);
}

function tryLock(): boolean {
  mkdirSync(stateDir, { recursive: true });
  try {
    const fd = openSync(lockFile, "wx");
    closeSync(fd);
    return true;
  } catch {
    try {
      if (Date.now() - statSync(lockFile).mtimeMs > 30 * 60_000) {
        unlinkSync(lockFile);
        const fd = openSync(lockFile, "wx");
        closeSync(fd);
        return true;
      }
    } catch {
      // 并发请求或异常退出的竞态，保持互斥失败。
    }
    return false;
  }
}

function releaseLock(): void {
  try {
    unlinkSync(lockFile);
  } catch {
    // 已由异常退出清理，忽略。
  }
}

function syncGitCommitEnv(commitSha: string): void {
  try {
    const envPath = join(composeProjectDir, ".env");
    if (!existsSync(envPath) || !commitSha.trim()) return;
    const content = readFileSync(envPath, "utf8");
    const commitVal = commitSha.trim();
    const next = /(^|\r?\n)BUTLER_GIT_COMMIT=.*(?=\r?\n|$)/.test(content)
      ? content.replace(/(^|\r?\n)BUTLER_GIT_COMMIT=.*(?=\r?\n|$)/, `$1BUTLER_GIT_COMMIT=${commitVal}`)
      : content.trimEnd() + `\nBUTLER_GIT_COMMIT=${commitVal}\n`;
    writeFileSync(envPath, next, "utf8");
  } catch {
    // non-fatal
  }
}

async function runJob(job: Job): Promise<void> {
  const oldCommit = job.from;
  const update = async (patch: Partial<Job>): Promise<void> => {
    job = { ...job, ...patch };
    writeJson(stateFile, job);
    await persistStatus(job);
  };
  try {
    await update({ phase: "checkout" });
    const remote = await git(["remote", "get-url", "origin"], 10_000);
    if (remote.ok) await git(["fetch", "--tags", "origin"], 90_000);
    const checkout = await git(["checkout", job.target], 120_000);
    if (!checkout.ok) throw new Error("切到目标版本失败：" + checkout.error);
    const newCommit = await git(["rev-parse", "HEAD"], 10_000);
    if (newCommit.ok) syncGitCommitEnv(newCommit.stdout);
    await update({ phase: "install-build" });
    const built = await build();
    if (!built.ok) throw new Error("构建失败：" + built.error);
    await update({ phase: "restart" });
    const restarted = await composeUp();
    if (!restarted.ok) throw new Error("重启服务失败：" + restarted.error);
    await update({ phase: "verify" });
    if (!(await waitHealthy())) throw new Error("健康验收未通过（服务未能恢复）");
    await update({ status: "done", phase: "done", finishedAt: now(), error: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await update({ status: "running", phase: "rollback", error: message });
    const rollback = await git(["checkout", oldCommit], 120_000);
    if (rollback.ok) syncGitCommitEnv(oldCommit);
    const rebuilt = rollback.ok ? await build() : rollback;
    const restarted = rebuilt.ok ? await composeUp() : rebuilt;
    const healthy = restarted.ok && (await waitHealthy());
    await update({
      status: healthy ? "rolled-back" : "failed",
      phase: healthy ? "done" : "failed",
      finishedAt: now(),
      error: message,
    });
  } finally {
    active = false;
    // 任务收尾后让下一次 /api/status 重新探测仓库状态（checkout 已改变 HEAD）。
    repoViewCache = null;
    releaseLock();
  }
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
    if (Buffer.concat(chunks).byteLength > 64 * 1024) throw new Error("request-too-large");
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function send(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  // 进程活性语义（liveness）：updater 无常驻状态可探测（任务状态落盘文件按需读取），
  // 能响应即代表进程存活。这不等于「git/docker 后端可用」——后者由任务执行时的 fail-closed 校验兜底。
  if (request.method === "GET" && path === "/healthz") return send(response, 200, { ok: true });

  // 必须配置访问口令；未配置时 Fail-Closed 锁定（除健康检查外拒绝一切请求）。
  // 防止在 Compose 内部网络或反向代理环境下发生未授权破坏性升级与执行。
  if (accessToken === "" || !tokensMatch(accessToken, extractToken(request))) {
    return send(response, 401, {
      error: "unauthorized",
      reason: accessToken === ""
        ? "Updater 服务未配置 BUTLER_UPDATER_ACCESS_TOKEN、BUTLER_INTERNAL_TOKEN 或 BUTLER_ACCESS_TOKEN 访问口令，已处于安全锁定状态"
        : "需要有效访问口令",
    });
  }

  if (request.method === "GET" && path === "/api/status") {
    const lastJob = readJson<Job | null>(stateFile, null);
    const view = await statusView(lastJob);
    writeJson(statusFile, view);
    return send(response, 200, view);
  }
  if (request.method !== "POST") return send(response, 405, { error: "method-not-allowed" });
  if (path !== "/api/upgrade" && path !== "/api/rollback") return send(response, 404, { error: "not-found" });
  let body: Record<string, unknown>;
  try {
    body = await readBody(request);
  } catch (error) {
    return send(response, 400, { error: error instanceof Error ? error.message : "invalid-json" });
  }
  if (body["confirmed"] !== true) {
    return send(response, 400, {
      error: "confirmation-required",
      userHint: "升级或回滚会切换代码并重启服务，必须先确认。",
    });
  }
  if (active || !tryLock()) return send(response, 409, { error: "upgrade-in-flight" });
  const checked = validateTarget(typeof body["target"] === "string" ? body["target"] : "");
  if (!checked.ok) {
    releaseLock();
    return send(response, 400, { error: checked.reason });
  }
  const target = checked.value;
  const current = await git(["rev-parse", "--short", "HEAD"]);
  if (!current.ok) {
    releaseLock();
    return send(response, 503, { error: "no-repo" });
  }
  const clean = await git(["status", "--porcelain"]);
  if (!clean.ok || clean.stdout !== "") {
    releaseLock();
    return send(response, 409, { error: "repo-dirty", userHint: "更新前请先提交或清理源码改动。" });
  }
  const job: Job = {
    jobId: randomUUID(),
    kind: path === "/api/rollback" ? "rollback" : "upgrade",
    status: "running",
    phase: "snapshot",
    target,
    from: current.stdout,
    startedAt: now(),
    finishedAt: null,
    error: null,
    snapshotId: typeof body["snapshotId"] === "string" ? body["snapshotId"] : null,
  };
  active = true;
  writeJson(stateFile, job);
  // 202 必须在任务真正开始前发出：后续 checkout/build 都是异步等待，事件循环保持空闲。
  void runJob(job).finally(() => {
    void persistStatus(readJson<Job | null>(stateFile, null));
  });
  return send(response, 202, { started: true, jobId: job.jobId });
});

void (async () => {
  mkdirSync(stateDir, { recursive: true });
  if (existsSync(lockFile)) {
    try {
      unlinkSync(lockFile);
    } catch {
      // ignore
    }
  }
  await persistStatus();
  server.listen(port, host, () => console.log(`[butler-updater] listening on ${host}:${port}`));
})();

process.once("SIGTERM", () => server.close(() => process.exit(0)));
process.once("SIGINT", () => server.close(() => process.exit(0)));
