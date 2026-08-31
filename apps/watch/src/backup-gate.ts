import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson, readJsonOr, type Core } from "@butler/core";
import type { BackupService } from "./backup.js";

export interface BackupGateInput {
  instanceId: string;
  framework: string;
  version?: string | null;
  rootPath?: string;
  operation: "adoption" | "upgrade" | "restore" | "runbook" | "skill" | "reset" | "markdown";
}

export interface BackupGateResult {
  allowed: boolean;
  status: "created" | "existing" | "manual-required" | "bypassed";
  fingerprint: string;
  backupId?: number;
  manualBackupAction?: {
    sourcePath: string;
    suggestedArchivePath: string;
    displayPath: string;
  };
  detail: string;
}

interface BaselineRecord {
  fingerprint: string;
  backupId: number;
  createdAt: string;
  operation: BackupGateInput["operation"];
}

interface BypassRecord {
  fingerprint: string;
  reason: string;
  createdAt: string;
  operation: BackupGateInput["operation"];
}

interface GateState {
  baselines: Record<string, BaselineRecord>;
  bypasses: Record<string, BypassRecord>;
}

export interface BackupGate {
  ensure(input: BackupGateInput): Promise<BackupGateResult>;
  bypass(input: BackupGateInput, reason: string): BackupGateResult;
  fingerprint(input: Omit<BackupGateInput, "operation">): string;
}

function configContent(input: Pick<BackupGateInput, "framework" | "rootPath">): string {
  const root = input.rootPath?.trim();
  if (!root) return "";
  const candidates = input.framework === "openclaw" ? ["openclaw.json", "VERSION", "version"] : ["config.yaml", "pyproject.toml"];
  return candidates.map((name) => {
    const path = join(root, name);
    if (!existsSync(path)) return `${name}:missing`;
    try { return `${name}:${readFileSync(path).subarray(0, 16 * 1024).toString("utf8")}`; } catch { return `${name}:unreadable`; }
  }).join("\n");
}

export function createBackupGate(options: { core: Core; backup: BackupService; stateDir?: string }): BackupGate {
  const stateFile = join(options.stateDir ?? join(options.core.paths.home, "data-guard"), "baselines.json");
  const load = (): GateState => readJsonOr<GateState>(stateFile, { baselines: {}, bypasses: {} });
  const save = (state: GateState): void => atomicWriteJson(stateFile, state, { mode: 0o600, description: "备份门禁状态" });

  function fingerprint(input: Omit<BackupGateInput, "operation">): string {
    return createHash("sha256")
      .update(`${input.instanceId}\u0000${input.framework}\u0000${input.version ?? ""}\u0000${configContent(input)}`)
      .digest("hex");
  }

  async function ensure(input: BackupGateInput): Promise<BackupGateResult> {
    const state = load();
    const fp = fingerprint(input);
    const existing = state.baselines[input.instanceId];
    if (existing?.fingerprint === fp && options.core.store.getBackup(existing.backupId) !== undefined) {
      return { allowed: true, status: "existing", fingerprint: fp, backupId: existing.backupId, detail: "已有匹配的基线备份" };
    }
    const bypass = state.bypasses[input.instanceId];
    if (bypass?.fingerprint === fp) {
      return { allowed: true, status: "bypassed", fingerprint: fp, detail: `已按记录跳过本次${input.operation}前备份：${bypass.reason}` };
    }
    try {
      const backup = await options.backup.run("event", `基线备份：${input.operation}`);
      state.baselines[input.instanceId] = { fingerprint: fp, backupId: backup.id, createdAt: new Date().toISOString(), operation: input.operation };
      delete state.bypasses[input.instanceId];
      save(state);
      return { allowed: true, status: "created", fingerprint: fp, backupId: backup.id, detail: "已创建新的基线备份" };
    } catch (error) {
      const sourcePath = input.rootPath ?? "未发现受管实例目录";
      return {
        allowed: false,
        status: "manual-required",
        fingerprint: fp,
        manualBackupAction: { sourcePath, suggestedArchivePath: join(options.core.paths.home, "manual-backup"), displayPath: sourcePath },
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  function bypass(input: BackupGateInput, reason: string): BackupGateResult {
    const state = load();
    const fp = fingerprint(input);
    state.bypasses[input.instanceId] = { fingerprint: fp, reason: reason.trim() || "用户确认承担风险", createdAt: new Date().toISOString(), operation: input.operation };
    save(state);
    return { allowed: true, status: "bypassed", fingerprint: fp, detail: `已记录跳过原因：${reason.trim() || "用户确认承担风险"}` };
  }

  return { ensure, bypass, fingerprint };
}
