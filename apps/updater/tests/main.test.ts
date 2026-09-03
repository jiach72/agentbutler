import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  writeFileSync(
    join(binDir, "corepack.cmd"),
    [
      "@echo off",
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
  writeFileSync(join(binDir, "docker-compose.cmd"), composeShim, "utf8");
  writeFileSync(join(binDir, "docker.cmd"), composeShim, "utf8");
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

async function waitFor(check: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("timed out waiting for updater state");
}

async function startUpdater(options: { failBuildOnce?: boolean; composeBinary?: string } = {}): Promise<RunningUpdater> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const probeAddress = probe.address();
  probe.close();
  if (probeAddress === null || typeof probeAddress === "string") throw new Error("updater probe did not bind a TCP port");
  const port = probeAddress.port;
  const failureFile = join(root, "fail-build-once");
  const child = spawn(process.execPath, [updaterEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env["PATH"] ?? ""}`,
      BUTLER_HOME: homeDir,
      BUTLER_UPDATER_SOURCE: sourceDir,
      BUTLER_COMPOSE_PROJECT_DIR: sourceDir,
      BUTLER_COMPOSE_FILE: "docker-compose.yml",
      BUTLER_COMPOSE_BIN: options.composeBinary ?? join(binDir, "docker-compose.cmd"),
      BUTLER_UPDATER_COREPACK_BIN: join(binDir, "corepack.cmd"),
      BUTLER_UPDATER_SERVICES: "butler-web",
      BUTLER_UPDATER_HOST: "127.0.0.1",
      BUTLER_UPDATER_PORT: String(port),
      BUTLER_UPDATER_HEALTH_URLS: healthUrl,
      BUTLER_ACCESS_TOKEN: TOKEN,
      BUTLER_UPDATER_TEST_COMPOSE_ARGS_FILE: composeArgsFile,
      ...(options.failBuildOnce ? { BUTLER_UPDATER_TEST_BUILD_FAILURE_FILE: failureFile } : {}),
    },
    stdio: "ignore",
    windowsHide: true,
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
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

  it("checks out the requested version, rebuilds, restarts, and verifies health", async () => {
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
  }, 15_000);

  it("uses the Docker Compose v2 subcommand when configured with docker", async () => {
    updater = await startUpdater({ composeBinary: join(binDir, "docker.cmd") });
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
});
