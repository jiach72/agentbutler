import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { delimiter, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const updaterEntry = join(repoRoot, "apps", "updater", "dist", "main.js");
const TOKEN = "updater-integration-token";

type RunningUpdater = {
  child: ChildProcess;
  baseUrl: string;
};

let root = "";
let sourceDir = "";
let binDir = "";
let homeDir = "";
let healthServer: Server | undefined;
let healthUrl = "";
let composeArgsFile = "";
let updater: RunningUpdater | undefined;
let revisions: { from: string; target: string };
let corepackBin = "";
let composeBin = "";
let dockerBin = "";

function runGit(args: string[], cwd = sourceDir): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeRepository(): { from: string; target: string } {
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, "package.json"), JSON.stringify({ version: "0.1.0" }), "utf8");
  writeFileSync(join(sourceDir, "docker-compose.yml"), "services: {}\n", "utf8");
  writeFileSync(join(sourceDir, ".gitignore"), ".env\n", "utf8");
  runGit(["init"]);
  runGit(["config", "user.email", "updater-test@example.invalid"]);
  runGit(["config", "user.name", "Updater Test"]);
  runGit(["add", "."]);
  runGit(["commit", "-m", "version 0.1.0"]);
  const from = runGit(["rev-parse", "--short", "HEAD"]);
  runGit(["tag", "v0.1.0"]);

  writeFileSync(join(sourceDir, "package.json"), JSON.stringify({ version: "0.2.0" }), "utf8");
  runGit(["add", "package.json"]);
  runGit(["commit", "-m", "version 0.2.0"]);
  const target = runGit(["rev-parse", "--short", "HEAD"]);
  runGit(["tag", "v0.2.0"]);
  runGit(["checkout", from]);
  return { from, target };
}

function writeCommandShims(): void {
  mkdirSync(binDir, { recursive: true });
  const isWin = process.platform === "win32";
  const ext = isWin ? ".cmd" : "";
  corepackBin = join(binDir, `corepack${ext}`);
  composeBin = join(binDir, `docker-compose${ext}`);
  dockerBin = join(binDir, `docker${ext}`);

  if (isWin) {
    writeFileSync(
      corepackBin,
      [
        "@echo off",
        "if /I \"%~2\"==\"build\" if not \"%BUTLER_UPDATER_TEST_BUILD_DELAY%\"==\"\" ping -n %BUTLER_UPDATER_TEST_BUILD_DELAY% 127.0.0.1 >nul",
        "if /I \"%~2\"==\"build\" if not \"%BUTLER_UPDATER_TEST_BUILD_FAILURE_FILE%\"==\"\" if not exist \"%BUTLER_UPDATER_TEST_BUILD_FAILURE_FILE%\" (",
        "  type nul > \"%BUTLER_UPDATER_TEST_BUILD_FAILURE_FILE%\"",
        "  exit /b 1",
        ")",
        "exit /b 0",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const composeShim = [
      "@echo off",
      "if not \"%BUTLER_UPDATER_TEST_COMPOSE_ARGS_FILE%\"==\"\" echo %*>>\"%BUTLER_UPDATER_TEST_COMPOSE_ARGS_FILE%\"",
      "exit /b 0",
      "",
    ].join("\r\n");
    writeFileSync(composeBin, composeShim, "utf8");
    writeFileSync(dockerBin, composeShim, "utf8");
    return;
  }

  const corepackShim = [
    "#!/bin/sh",
    "if [ \"$2\" = \"build\" ] && [ -n \"${BUTLER_UPDATER_TEST_BUILD_DELAY:-}\" ]; then sleep \"${BUTLER_UPDATER_TEST_BUILD_DELAY}\"; fi",
    "if [ \"$2\" = \"build\" ] && [ -n \"${BUTLER_UPDATER_TEST_BUILD_FAILURE_FILE:-}\" ] && [ ! -e \"$BUTLER_UPDATER_TEST_BUILD_FAILURE_FILE\" ]; then",
    "  : > \"$BUTLER_UPDATER_TEST_BUILD_FAILURE_FILE\"",
    "  exit 1",
    "fi",
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(corepackBin, corepackShim, "utf8");
  chmodSync(corepackBin, 0o755);
  const composeShim = [
    "#!/bin/sh",
    "if [ -n \"${BUTLER_UPDATER_TEST_COMPOSE_ARGS_FILE:-}\" ]; then printf '%s\\n' \"$*\" >> \"$BUTLER_UPDATER_TEST_COMPOSE_ARGS_FILE\"; fi",
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(composeBin, composeShim, "utf8");
  chmodSync(composeBin, 0o755);
  writeFileSync(dockerBin, composeShim, "utf8");
  chmodSync(dockerBin, 0o755);
}

async function startHealthServer(): Promise<void> {
  healthServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  healthServer.listen(0, "127.0.0.1");
  await once(healthServer, "listening");
  const address = healthServer.address();
  if (address === null || typeof address === "string") throw new Error("health server did not bind a TCP port");
  healthUrl = `http://127.0.0.1:${address.port}/healthz`;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("timed out waiting for updater state");
}

async function startUpdater(options: {
  failBuildOnce?: boolean;
  composeBinary?: string;
  slowBuild?: number;
  noAccessToken?: boolean;
  internalToken?: string;
  /** 复现 Compose 默认形态：`${BUTLER_UPDATER_ACCESS_TOKEN:-}` 会注入空字符串（#32）。 */
  emptyUpdaterToken?: boolean;
} = {}): Promise<RunningUpdater> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const probeAddress = probe.address();
  probe.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (probeAddress === null || typeof probeAddress === "string") throw new Error("updater probe did not bind a TCP port");
  const port = probeAddress.port;
  const failureFile = join(root, "fail-build-once");
  let childExitedError: Error | null = null;
  const child = spawn(process.execPath, [updaterEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env["PATH"] ?? ""}`,
      BUTLER_HOME: homeDir,
      BUTLER_UPDATER_SOURCE: sourceDir,
      BUTLER_COMPOSE_PROJECT_DIR: sourceDir,
      BUTLER_COMPOSE_FILE: "docker-compose.yml",
      BUTLER_COMPOSE_BIN: options.composeBinary ?? composeBin,
      BUTLER_UPDATER_COREPACK_BIN: corepackBin,
      BUTLER_UPDATER_SERVICES: "butler-web",
      BUTLER_UPDATER_HOST: "127.0.0.1",
      BUTLER_UPDATER_PORT: String(port),
      BUTLER_UPDATER_HEALTH_URLS: healthUrl,
      BUTLER_ACCESS_TOKEN: options.noAccessToken ? "" : TOKEN,
      // Compose 用 `${VAR:-}` 注入变量，未配置的口令在容器里是**空字符串**而不是 undefined；
      // 只有复现该形态才能覆盖 #32（空字符串短路 ?? 回退链）。
      ...(options.emptyUpdaterToken ? { BUTLER_UPDATER_ACCESS_TOKEN: "" } : {}),
      ...(options.internalToken ? { BUTLER_INTERNAL_TOKEN: options.internalToken } : {}),
      BUTLER_UPDATER_TEST_COMPOSE_ARGS_FILE: composeArgsFile,
      ...(options.failBuildOnce ? { BUTLER_UPDATER_TEST_BUILD_FAILURE_FILE: failureFile } : {}),
      ...(options.slowBuild ? { BUTLER_UPDATER_TEST_BUILD_DELAY: String(options.slowBuild) } : {}),
    },
    stdio: "ignore",
    windowsHide: true,
  });
  child.once("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      childExitedError = new Error(`Updater child process exited with code ${code} (${signal ?? "no signal"})`);
    }
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    if (childExitedError !== null) throw childExitedError;
    try {
      return (await fetch(`${baseUrl}/healthz`)).ok;
    } catch {
      return false;
    }
  });
  return { child, baseUrl };
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  if (updater === undefined) throw new Error("updater is not running");
  return fetch(`${updater.baseUrl}${path}`, init);
}

async function terminalStatus(): Promise<Record<string, unknown>> {
  let result: Record<string, unknown> = {};
  await waitFor(async () => {
    const response = await request("/api/status", { headers: { "x-butler-token": TOKEN } });
    result = (await response.json()) as Record<string, unknown>;
    const job = result["lastJob"] as Record<string, unknown> | null;
    return job !== null && ["done", "rolled-back", "failed"].includes(String(job["status"]));
  });
  return result;
}

async function stopUpdater(): Promise<void> {
  if (updater === undefined) return;
  const child = updater.child;
  updater = undefined;
  if (child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await Promise.race([exited, new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000))]);
  }
}

beforeEach(async () => {
  root = mkdtempSync(join(os.tmpdir(), "butler-updater-"));
  sourceDir = join(root, "source");
  binDir = join(root, "bin");
  homeDir = join(root, "home");
  composeArgsFile = join(root, "compose-args.txt");
  mkdirSync(homeDir, { recursive: true });
  revisions = makeRepository();
  writeCommandShims();
  await startHealthServer();
});

afterEach(async () => {
  await stopUpdater();
  if (healthServer !== undefined) {
    healthServer.close();
    await once(healthServer, "close");
    healthServer = undefined;
  }
  if (root !== "" && existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("butler-updater security and rollback", () => {
  it("rejects unauthenticated or unconfirmed destructive requests", async () => {
    updater = await startUpdater();
    const noToken = await request("/api/upgrade", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "v0.2.0", confirmed: true }),
    });
    expect(noToken.status).toBe(401);

    const unconfirmed = await request("/api/upgrade", {
      method: "POST",
      headers: { "content-type": "application/json", "x-butler-token": TOKEN },
      body: JSON.stringify({ target: "v0.2.0" }),
    });
    expect(unconfirmed.status).toBe(400);
    await expect(unconfirmed.json()).resolves.toMatchObject({ error: "confirmation-required" });

    const invalidTarget = await request("/api/upgrade", {
      method: "POST",
      headers: { "content-type": "application/json", "x-butler-token": TOKEN },
      body: JSON.stringify({ target: "v0.2.0; whoami", confirmed: true }),
    });
    expect(invalidTarget.status).toBe(400);
    await expect(invalidTarget.json()).resolves.toMatchObject({ error: "invalid-target" });
  });

  it("authenticates using BUTLER_INTERNAL_TOKEN and x-butler-internal-token", async () => {
    updater = await startUpdater({ noAccessToken: true, internalToken: "test-internal-token-12345" });
    const noToken = await request("/api/status");
    expect(noToken.status).toBe(401);
    await expect(noToken.json()).resolves.toMatchObject({ error: "unauthorized" });

    const withInternal = await request("/api/status", {
      headers: { "x-butler-internal-token": "test-internal-token-12345" },
    });
    expect(withInternal.status).toBe(200);
  });

  // #32 回归：默认部署（docker-compose.yml 未配置任何口令）下，容器里拿到的是空字符串，
  // 而不是 undefined。空字符串会短路 `??` 回退链，使 updater 判定「无口令」并 fail-closed，
  // 于是面板「一键升级 / 回滚」全部 401，而 watch 侧还把版本页显示为「可升级」。
  it("BUTLER_UPDATER_ACCESS_TOKEN 为空字符串时仍回退到 BUTLER_INTERNAL_TOKEN（#32）", async () => {
    updater = await startUpdater({
      noAccessToken: true,
      emptyUpdaterToken: true,
      internalToken: "test-internal-token-12345",
    });

    const wrongToken = await request("/api/status", { headers: { "x-butler-internal-token": "not-the-token" } });
    expect(wrongToken.status).toBe(401);
    await expect(wrongToken.json()).resolves.toMatchObject({ error: "unauthorized" });

    const withInternal = await request("/api/status", {
      headers: { "x-butler-internal-token": "test-internal-token-12345" },
    });
    expect(withInternal.status).toBe(200);
  });

  it("三个口令都是空字符串（真正未配置）时仍保持 fail-closed 401", async () => {
    updater = await startUpdater({ noAccessToken: true, emptyUpdaterToken: true });
    const status = await request("/api/status", {
      headers: { "x-butler-internal-token": "test-internal-token-12345" },
    });
    expect(status.status).toBe(401);
    await expect(status.json()).resolves.toMatchObject({
      error: "unauthorized",
      reason: expect.stringContaining("安全锁定"),
    });
  });

  it("checks out the requested version, rebuilds, restarts, and verifies health", async () => {
    writeFileSync(join(sourceDir, ".env"), "BUTLER_GIT_COMMIT=initial-sha\n", "utf8");
    updater = await startUpdater();
    const response = await request("/api/upgrade", {
      method: "POST",
      headers: { "content-type": "application/json", "x-butler-token": TOKEN },
      body: JSON.stringify({ target: "v0.2.0", confirmed: true }),
    });
    expect(response.status).toBe(202);

    const status = await terminalStatus();
    expect(status["lastJob"]).toMatchObject({ status: "done", phase: "done", target: "v0.2.0" });
    expect(runGit(["rev-parse", "--short", "HEAD"])).toBe(revisions.target);
    expect(readFileSync(join(sourceDir, ".env"), "utf8")).toContain("BUTLER_GIT_COMMIT=" + runGit(["rev-parse", "HEAD"]));
  }, 15_000);

  it("uses the Docker Compose v2 subcommand when configured with docker", async () => {
    updater = await startUpdater({ composeBinary: dockerBin });
    const response = await request("/api/upgrade", {
      method: "POST",
      headers: { "content-type": "application/json", "x-butler-token": TOKEN },
      body: JSON.stringify({ target: "v0.2.0", confirmed: true }),
    });
    expect(response.status).toBe(202);

    const status = await terminalStatus();
    expect(status["lastJob"]).toMatchObject({ status: "done", phase: "done" });
    const invocation = readFileSync(composeArgsFile, "utf8").replaceAll('"', "");
    expect(invocation).toContain(`compose --project-directory ${sourceDir} -f ${join(sourceDir, "docker-compose.yml")} up -d --build butler-web`);
  }, 15_000);

  it("automatically restores the previous commit when the target build fails", async () => {
    updater = await startUpdater({ failBuildOnce: true });
    const response = await request("/api/upgrade", {
      method: "POST",
      headers: { "content-type": "application/json", "x-butler-token": TOKEN },
      body: JSON.stringify({ target: "v0.2.0", confirmed: true }),
    });
    expect(response.status).toBe(202);

    const status = await terminalStatus();
    expect(status["lastJob"]).toMatchObject({ status: "rolled-back", phase: "done" });
    expect(runGit(["rev-parse", "--short", "HEAD"])).toBe(revisions.from);
  }, 15_000);

  it("keeps /healthz and /api/status responsive while a build is running", async () => {
    // 构建步骤休眠 6 秒；此期间健康检查与状态轮询必须照常返回，否则面板会把升级误判为失联。
    updater = await startUpdater({ slowBuild: 6 });
    const response = await request("/api/upgrade", {
      method: "POST",
      headers: { "content-type": "application/json", "x-butler-token": TOKEN },
      body: JSON.stringify({ target: "v0.2.0", confirmed: true }),
    });
    expect(response.status).toBe(202);

    await waitFor(async () => {
      const status = await request("/api/status", { headers: { "x-butler-token": TOKEN } });
      const job = (await status.json()) as Record<string, unknown>;
      return (job["lastJob"] as Record<string, unknown> | null)?.["phase"] === "install-build";
    });

    const healthDuringBuild = await fetch(`${updater.baseUrl}/healthz`, { signal: AbortSignal.timeout(1_000) });
    expect(healthDuringBuild.status).toBe(200);
    const statusDuringBuild = await fetch(`${updater.baseUrl}/api/status`, {
      headers: { "x-butler-token": TOKEN },
      signal: AbortSignal.timeout(1_000),
    });
    expect(statusDuringBuild.status).toBe(200);
    const view = (await statusDuringBuild.json()) as Record<string, unknown>;
    expect((view["lastJob"] as Record<string, unknown>)["phase"]).toBe("install-build");

    // 验证安全收敛：不再接受 URL query 中的 ?token=
    const queryTokenRejected = await fetch(`${updater.baseUrl}/api/status?token=${encodeURIComponent(TOKEN)}`, {
      signal: AbortSignal.timeout(1_000),
    });
    expect(queryTokenRejected.status).toBe(401);

    const status = await terminalStatus();
    expect(status["lastJob"]).toMatchObject({ status: "done", phase: "done" });
  }, 20_000);
});
