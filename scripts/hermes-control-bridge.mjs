#!/usr/bin/env node
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const HERMES_CONTROL_ACTIONS = new Set([
  "status",
  "start-hermes",
  "stop-hermes",
  "restart-hermes",
  "cleanup-orphan-gateways",
]);
export const ORPHAN_GATEWAY_PATTERNS = ["hermes_cli.main gateway run", "tui_gateway.entry"];
const MAX_BODY_BYTES = 8 * 1024;

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function tokenMatches(expected, supplied) {
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearerToken(value) {
  const match = /^Bearer\s+(.+)$/i.exec(value ?? "");
  return match?.[1]?.trim() ?? "";
}

function defaultSystemctl(timeoutMs) {
  return (args) =>
    new Promise((resolve) => {
      execFile("systemctl", ["--user", ...args], { timeout: timeoutMs }, (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      });
    });
}

function defaultProcess(timeoutMs) {
  return (command, args) =>
    new Promise((resolve) => {
      execFile(command, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      });
    });
}

function readRecordedGatewayPid(rootPath) {
  try {
    const value = JSON.parse(readFileSync(join(rootPath, "gateway.pid"), "utf8"));
    return Number.isInteger(value?.pid) && value.pid > 0 ? value.pid : null;
  } catch {
    return null;
  }
}

async function cleanupOrphanGateways(rootPath, runProcess) {
  const pids = new Set();
  for (const pattern of ORPHAN_GATEWAY_PATTERNS) {
    const result = await runProcess("pgrep", ["-f", pattern]);
    if (result.code !== 0) continue;
    for (const line of result.stdout.split("\n")) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
  }
  const sorted = [...pids].sort((left, right) => left - right);
  if (sorted.length === 0) return { cleanedPids: [], mainPid: null };

  const recordedPid = readRecordedGatewayPid(rootPath);
  const mainPid = recordedPid !== null && pids.has(recordedPid) ? recordedPid : sorted[0];
  const cleanedPids = [];
  for (const pid of sorted) {
    if (pid === mainPid) continue;
    const result = await runProcess("kill", [String(pid)]);
    if (result.code !== 0) throw new Error(`kill ${pid} failed`);
    cleanedPids.push(pid);
  }
  return { cleanedPids, mainPid };
}

/**
 * 创建只允许 Hermes 生命周期固定动作的宿主控制 HTTP 服务。
 * 不接受命令行、服务名、路径或其他用户可控参数。
 */
export function createHermesControlBridgeServer(options) {
  const readToken = options.readToken ?? (() => readFileSync(options.tokenFile, "utf8").trim());
  const runSystemctl = options.runSystemctl ?? defaultSystemctl(options.timeoutMs);
  const runProcess = options.runProcess ?? defaultProcess(options.timeoutMs);
  const rootPath = options.rootPath ?? `${process.env.HOME}/.hermes`;

  async function status() {
    const result = await runSystemctl(["is-active", options.unit]);
    return { active: result.code === 0 && result.stdout.trim() === "active", unit: options.unit };
  }

  async function action(name) {
    if (name === "status") return status();
    if (name === "cleanup-orphan-gateways") {
      const cleanup = await cleanupOrphanGateways(rootPath, runProcess);
      return { ...(await status()), ...cleanup };
    }
    const command = name.replace("-hermes", "");
    const result = await runSystemctl([command, options.unit]);
    if (result.code !== 0) throw new Error("systemctl failed");
    return status();
  }

  return createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/control") return json(res, 404, { error: "not_found" });

    let expected;
    try {
      expected = readToken();
    } catch {
      return json(res, 503, { error: "token_unavailable" });
    }
    const supplied = bearerToken(req.headers.authorization);
    if (!expected || !supplied || !tokenMatches(expected, supplied)) return json(res, 401, { error: "unauthorized" });

    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return json(res, 413, { error: "body_too_large" });
    }

    let name;
    try {
      name = JSON.parse(raw).action;
    } catch {
      return json(res, 400, { error: "invalid_json" });
    }
    if (typeof name !== "string" || !HERMES_CONTROL_ACTIONS.has(name)) {
      return json(res, 400, { error: "action_not_allowed" });
    }

    try {
      return json(res, 200, await action(name));
    } catch {
      return json(res, 502, { error: "control_failed" });
    }
  });
}

function startFromEnvironment() {
  const host = process.env.BUTLER_HERMES_CONTROL_HOST || "127.0.0.1";
  const port = Number(process.env.BUTLER_HERMES_CONTROL_PORT || "8756");
  const tokenFile = process.env.BUTLER_HERMES_CONTROL_TOKEN_FILE || `${process.env.HOME}/.hermes/agent-butler/control.token`;
  const unit = process.env.BUTLER_HERMES_CONTROL_UNIT || "hermes-gateway.service";
  const rootPath = process.env.BUTLER_HERMES_CONTROL_ROOT || `${process.env.HOME}/.hermes`;
  const timeoutMs = Math.max(1000, Number(process.env.BUTLER_HERMES_CONTROL_TIMEOUT_MS || "30000"));
  const server = createHermesControlBridgeServer({ tokenFile, unit, rootPath, timeoutMs });
  server.listen(port, host, () => console.log(`Hermes control bridge listening on ${host}:${port}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startFromEnvironment();
