/**
 * 全局急停（Trust Layer M1.3 Kill Switch）：信任的最后防线。
 *
 * engage 流程（顺序即语义）：
 * 1. 自动创建全量快照（复用备份服务；失败不阻断急停——停 agent 永远优先，
 *    快照失败如实记录并写进告警，不假装保住了数据）；
 * 2. 逐实例停止所有在服实例（走能力路由的 control.stop，不旁路）；
 * 3. killswitch_log 落库（crash-safe：重启后按未 released 的最新行恢复状态）；
 * 4. 事件中心事件 + 审计 + 网关告警三路留痕。
 *
 * engage 期间的护栏（HTTP 层执行）：拒绝 reconnect 与升级动作，
 * 状态返回 409 { error: "killswitch-engaged" }。
 *
 * release 流程：按 engage 时记录的实例清单逐个重启（单实例失败不阻断其余），
 * 补 released_at、审计、事件、告警。积压任务的逐项确认属于消息面
 * （计划书 M1.3 §4），由消息网关侧 follow-up 承接，此处如实透出快照与停机清单。
 */
import type { AuditLog, SqliteStore } from "@butler/core";
import type { AlertPoster } from "./alert-forward.js";

export interface KillSwitchDeps {
  store: SqliteStore;
  /** 全量快照（BackupService.run("full", label)）；缺省跳过快照并如实标注。 */
  createSnapshot?: (label: string) => Promise<{ id: number }>;
  /** 当前应被急停覆盖的在服实例清单。 */
  listRunningInstances: () => Array<{ instanceId: string }>;
  stopInstance: (instanceId: string) => Promise<void>;
  startInstance: (instanceId: string) => Promise<void>;
  poster?: AlertPoster;
  audit?: AuditLog;
  trustEvents?: import("./trust-events.js").TrustEventHub;
  now?: () => number;
}

export interface KillSwitchState {
  engaged: boolean;
  engagedAt: string | null;
  trigger: string | null;
  actor: string | null;
  /** engage 前自动快照的备份 id；快照失败为 null（快照失败时快照可用性=false）。 */
  snapshotId: number | null;
  snapshotTaken: boolean;
  /** engage 时被停止、release 时待恢复（或已恢复）的实例。 */
  stoppedInstanceIds: string[];
  /** release 后仍启动失败的实例（如实透出，不假装恢复成功）。 */
  failedToRestart: string[];
  releasedAt: string | null;
  /** crash 恢复：engage 后进程重启，按未 released 日志行恢复的状态。 */
  restoredFromLog: boolean;
}

export type KillSwitchEngageResult =
  | { status: "engaged"; state: KillSwitchState }
  | { status: "already-engaged"; state: KillSwitchState };

export type KillSwitchReleaseResult =
  | { status: "released"; state: KillSwitchState }
  | { status: "not-engaged"; state: KillSwitchState };

export interface KillSwitchService {
  state(): KillSwitchState;
  isEngaged(): boolean;
  engage(input: { trigger?: string; actor?: string }): Promise<KillSwitchEngageResult>;
  release(input: { actor?: string }): Promise<KillSwitchReleaseResult>;
}

/** 从 detail_json / log 行恢复运行态（crash-safe）。 */
function stateFromLog(deps: KillSwitchDeps): KillSwitchState | null {
  const latest = deps.store.latestKillswitchLog();
  if (latest === undefined || latest.releasedAt !== null) return null;
  let detail: { stoppedInstanceIds?: unknown } = {};
  try {
    detail = latest.detailJson !== null ? (JSON.parse(latest.detailJson) as typeof detail) : {};
  } catch {
    detail = {};
  }
  const stopped = Array.isArray(detail.stoppedInstanceIds)
    ? detail.stoppedInstanceIds.filter((item): item is string => typeof item === "string")
    : [];
  return {
    engaged: true,
    engagedAt: latest.engagedAt,
    trigger: latest.trigger,
    actor: latest.actor,
    snapshotId: latest.snapshotId,
    snapshotTaken: latest.snapshotId !== null,
    stoppedInstanceIds: stopped,
    failedToRestart: [],
    releasedAt: null,
    restoredFromLog: true,
  };
}

export function createKillSwitchService(deps: KillSwitchDeps): KillSwitchService {
  const now = deps.now ?? (() => Date.now());
  const iso = () => new Date(now()).toISOString();
  let state: KillSwitchState | null = stateFromLog(deps);
  let logRowId: number | null = state?.restoredFromLog
    ? (deps.store.latestKillswitchLog()?.id ?? null)
    : null;

  function snapshotState(): KillSwitchState {
    return (
      state ?? {
        engaged: false,
        engagedAt: null,
        trigger: null,
        actor: null,
        snapshotId: null,
        snapshotTaken: false,
        stoppedInstanceIds: [],
        failedToRestart: [],
        releasedAt: null,
        restoredFromLog: false,
      }
    );
  }

  async function post(kind: string, severity: "warn" | "critical", title: string, body: string, dedupeKey: string): Promise<void> {
    await deps.poster
      ?.post({ kind, severity, title, body, source: "butler-watch", dedupeKey })
      .catch(() => undefined);
  }

  return {
    state: snapshotState,
    isEngaged() {
      return snapshotState().engaged;
    },

    async engage(input): Promise<KillSwitchEngageResult> {
      if (snapshotState().engaged) return { status: "already-engaged", state: snapshotState() };
      const trigger = input.trigger?.trim() || "panel";
      const actor = input.actor?.trim() || "panel";

      // 1) engage 前自动全量快照；失败不阻断急停（如实记录）。
      let snapshotId: number | null = null;
      let snapshotError: string | null = null;
      if (deps.createSnapshot !== undefined) {
        try {
          const row = await deps.createSnapshot(`急停前自动全量快照（${iso()}）`);
          snapshotId = row.id;
        } catch (error) {
          snapshotError = error instanceof Error ? error.message : String(error);
        }
      } else {
        snapshotError = "备份服务未接线";
      }

      // 2) 逐实例停止（单实例失败不阻断其余）。
      const candidates = deps.listRunningInstances();
      const stopped: string[] = [];
      const stopFailures: Array<{ instanceId: string; error: string }> = [];
      for (const instance of candidates) {
        try {
          await deps.stopInstance(instance.instanceId);
          stopped.push(instance.instanceId);
        } catch (error) {
          stopFailures.push({
            instanceId: instance.instanceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // 3) 日志落库（crash-safe：重启后按未 released 行恢复）。
      const row = deps.store.insertKillswitchLog({
        engagedAt: iso(),
        trigger,
        snapshotId,
        actor,
        detail: { stoppedInstanceIds: stopped, stopFailures, snapshotError },
      });
      logRowId = row.id;
      state = {
        engaged: true,
        engagedAt: row.engagedAt,
        trigger,
        actor,
        snapshotId,
        snapshotTaken: snapshotId !== null,
        stoppedInstanceIds: stopped,
        failedToRestart: [],
        releasedAt: null,
        restoredFromLog: false,
      };

      // 4) 三路留痕：事件中心 + 审计 + 网关告警。
      const snapshotNote =
        snapshotId !== null
          ? `已自动创建全量快照（备份 #${snapshotId}）`
          : `快照未成功（${snapshotError ?? "未知原因"}），请检查备份服务`;
      deps.trustEvents?.record({
        kind: "killswitch",
        severity: "critical",
        title: `全局急停已触发：${stopped.length} 个实例已停止`,
        dedupeKey: `killswitch:${row.id}`,
        evidence: [
          { trigger, actor, at: row.engagedAt, stoppedInstanceIds: stopped, stopFailures, snapshotId, snapshotError },
        ],
      });
      deps.audit?.append({
        actor,
        action: "killswitch-engage",
        target: stopped.join(","),
        detail: { trigger, snapshotId, snapshotError, stopFailures },
      });
      await post(
        "killswitch",
        "critical",
        "全局急停已触发",
        `已停止 ${stopped.length} 个 agent 实例，新任务与重连已被拒绝。${snapshotNote}。恢复请在面板点击「恢复」。`,
        `killswitch-engage:${row.id}`,
      );
      return { status: "engaged", state };
    },

    async release(input): Promise<KillSwitchReleaseResult> {
      const current = snapshotState();
      if (!current.engaged || logRowId === null) {
        return { status: "not-engaged", state: current };
      }
      const actor = input.actor?.trim() || "panel";
      const failedToRestart: string[] = [];
      for (const instanceId of current.stoppedInstanceIds) {
        try {
          await deps.startInstance(instanceId);
        } catch {
          failedToRestart.push(instanceId);
        }
      }
      const releasedAt = iso();
      deps.store.closeKillswitchLog(logRowId, releasedAt);
      state = {
        ...current,
        engaged: false,
        releasedAt,
        failedToRestart,
        restoredFromLog: false,
      };
      logRowId = null;
      deps.trustEvents?.record({
        kind: "killswitch-release",
        severity: "info",
        title: "全局急停已解除，实例正在恢复",
        dedupeKey: `killswitch-release:${releasedAt}`,
        evidence: [{ actor, at: releasedAt, failedToRestart, snapshotId: current.snapshotId }],
      });
      deps.audit?.append({
        actor,
        action: "killswitch-release",
        target: current.stoppedInstanceIds.join(","),
        detail: { failedToRestart },
      });
      await post(
        "killswitch",
        "warn",
        "全局急停已解除",
        `已恢复 ${current.stoppedInstanceIds.length - failedToRestart.length} 个实例。${
          failedToRestart.length > 0 ? `启动失败需手动处理：${failedToRestart.join(", ")}` : ""
        }`,
        `killswitch-release:${releasedAt}`,
      );
      return { status: "released", state };
    },
  };
}
