import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
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
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

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
const composeBinary = process.env["BUTLER_COMPOSE_BIN"]?.trim() || "docker-compose";
const services = (process.env["BUTLER_UPDATER_SERVICES"] ?? "butler-gateway butler-watch butler-web")
  .split(/\s+/)
  .map((value) => value.trim())
  .filter(Boolean);

let active = false;

function now(): string {
  return new Date().toISOString();
}

function run(command: string, args: string[], cwd = sourceDir, timeout = 120_000): CommandResult {
  try {
    const stdout = execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: stdout.trim(), error: "" };
  } catch (error) {
    const detail = error as { stderr?: Buffer | string; message?: string };
    return {
      ok: false,
      stdout: "",
      error: detail.stderr !== undefined ? String(detail.stderr).trim() : detail.message ?? String(error),
    };
  }
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

function git(args: string[], timeout = 20_000): CommandResult {
  return run("git", args, sourceDir, timeout);
}

function semanticVersion(value: string): boolean {
  return /^(?:v)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function channelOf(version: string): "stable" | "beta" {
  return version.includes("-") ? "beta" : "stable";
}

function updates(): Array<{ version: string; channel: "stable" | "beta"; commit: string | null; tag: string }> {
  const result = git(["tag", "--list"]);
  if (!result.ok) return [];
  return result.stdout
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "" && semanticVersion(tag))
    .map((tag) => {
      const rev = git(["rev-parse", "--short", tag]);
      const version = tag.replace(/^v/i, "");
      return { version, channel: channelOf(version), commit: rev.ok ? rev.stdout : null, tag };
    })
    .sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }));
}

function status(lastJob: Job | null = readJson<Job | null>(stateFile, null)): Record<string, unknown> {
  const branch = git(["branch", "--show-current"]);
  const commit = git(["rev-parse", "--short", "HEAD"]);
  const tagResult = git(["describe", "--tags", "--exact-match", "--always"]);
  const remote = git(["remote", "get-url", "origin"]);
  const clean = git(["status", "--porcelain"]);
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
    repoClean: clean.ok && clean.stdout === "",
    remoteConfigured: remote.ok,
    upgradeSupported: commit.ok,
    prefs: readJson(join(stateDir, "prefs.json"), { channel: "stable", locked: false }),
    snapshots: readJson(join(stateDir, "snapshots.json"), []),
    snapshotRetention: 3,
    availableUpdates: updates(),
    lastJob,
    checkedAt: now(),
  };
}

function persistStatus(lastJob?: Job | null): void {
  writeJson(statusFile, status(lastJob));
}

async function waitHealthy(): Promise<boolean> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    let healthy = true;
    for (const endpoint of ["http://butler-web:7531/api/health", "http://butler-watch:7533/healthz", "http://butler-gateway:7532/healthz"]) {
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

function composeUp(): CommandResult {
  const composeArgs = composeBinary === "docker-compose" ? [] : ["compose"];
  return run(
    composeBinary,
    [...composeArgs, "--project-directory", composeProjectDir, "-f", join(composeProjectDir, composeFile), "up", "-d", "--build", ...services],
    sourceDir,
    15 * 60_000,
  );
}

function build(): CommandResult {
  const install = run("corepack", ["pnpm", "install", "--frozen-lockfile"], sourceDir, 15 * 60_000);
  if (!install.ok) return install;
  return run("corepack", ["pnpm", "build"], sourceDir, 15 * 60_000);
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

async function runJob(job: Job): Promise<void> {
  const oldCommit = job.from;
  const update = (patch: Partial<Job>): void => {
    job = { ...job, ...patch };
    writeJson(stateFile, job);
    persistStatus(job);
  };
  try {
    update({ phase: "checkout" });
    const remote = git(["remote", "get-url", "origin"], 10_000);
    if (remote.ok) git(["fetch", "--tags", "origin"], 90_000);
    const checkout = git(["checkout", job.target], 120_000);
    if (!checkout.ok) throw new Error("切到目标版本失败：" + checkout.error);
    update({ phase: "install-build" });
    const built = build();
    if (!built.ok) throw new Error("构建失败：" + built.error);
    update({ phase: "restart" });
    const restarted = composeUp();
    if (!restarted.ok) throw new Error("重启服务失败：" + restarted.error);
    update({ phase: "verify" });
    if (!(await waitHealthy())) throw new Error("健康验收未通过（服务未能恢复）");
    update({ status: "done", phase: "done", finishedAt: now(), error: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    update({ status: "running", phase: "rollback", error: message });
    const rollback = git(["checkout", oldCommit], 120_000);
    const rebuilt = rollback.ok ? build() : rollback;
    const restarted = rebuilt.ok ? composeUp() : rebuilt;
    const healthy = restarted.ok && (await waitHealthy());
    update({
      status: healthy ? "rolled-back" : "failed",
      phase: healthy ? "done" : "failed",
      finishedAt: now(),
      error: message,
    });
  } finally {
    active = false;
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
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method === "GET" && path === "/healthz") return send(response, 200, { ok: true });
  if (request.method === "GET" && path === "/api/status") {
    persistStatus();
    return send(response, 200, readJson(statusFile, status()));
  }
  if (request.method !== "POST") return send(response, 405, { error: "method-not-allowed" });
  if (path !== "/api/upgrade" && path !== "/api/rollback") return send(response, 404, { error: "not-found" });
  let body: Record<string, unknown>;
  try {
    body = await readBody(request);
  } catch (error) {
    return send(response, 400, { error: error instanceof Error ? error.message : "invalid-json" });
  }
  if (active || !tryLock()) return send(response, 409, { error: "upgrade-in-flight" });
  const target = typeof body["target"] === "string" ? body["target"].trim() : "";
  if (target === "") {
    releaseLock();
    return send(response, 400, { error: "missing-target" });
  }
  const current = git(["rev-parse", "--short", "HEAD"]);
  if (!current.ok) {
    releaseLock();
    return send(response, 503, { error: "no-repo" });
  }
  const clean = git(["status", "--porcelain"]);
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
  persistStatus(job);
  void runJob(job);
  return send(response, 202, { started: true, jobId: job.jobId });
});

mkdirSync(stateDir, { recursive: true });
persistStatus();
server.listen(port, host, () => console.log(`[butler-updater] listening on ${host}:${port}`));

process.once("SIGTERM", () => server.close(() => process.exit(0)));
process.once("SIGINT", () => server.close(() => process.exit(0)));
