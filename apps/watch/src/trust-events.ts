/**
 * 事件中心（Trust Layer M2.2）：把告警、错误指纹、预算触线、急停、审计高危
 * 动作等分散的「值得注意的事」统一为一个事件对象，收敛到一处查看。
 *
 * 事件模型：{kind, severity, title, firstSeen, lastSeen, count,
 * status: active|acknowledged|resolved|regressed, evidence[], relatedIds}。
 * - 同 dedupeKey 复发合并计数（first_seen 保留最早值）；
 * - 「回归是一等公民」：resolved 事件同键复发自动转 regressed 并置顶（store 层实现）；
 * - 全确定性规则，零 LLM 调用（性能与信任红线）。
 *
 * 首版关联规则（计划书 M2.2 §2，按现有数据源可落地的子集）：
 * - R1 升级疑似回归：版本变更后 2h 内出现错误指纹 → 关联为独立事件；
 * - R4 快照/还原动作 → 自动生成「已回滚」信息事件；
 * - R5 指纹复发 → resolved → regressed 状态流转（store upsert 实现）。
 * R3（通道断连）需 Gateway 投递遥测回流，R2（死循环）依赖会话级工具调用
 * 计数——留 follow-up，不在本模块伪造。
 */
import type { AuditLog, SqliteStore, TrustEventRow } from "@butler/core";

/** 版本变更后出现错误指纹，判定为「升级疑似回归」候选的窗口。 */
export const UPGRADE_REGRESSION_WINDOW_MS = 2 * 60 * 60 * 1000;

export interface TrustEventRecordInput {
  kind: string;
  severity: TrustEventRow["severity"];
  title: string;
  evidence?: unknown[];
  relatedIds?: string[];
  dedupeKey: string;
}

export interface TrustEventHub {
  /** 记录/合并一条事件（同键复发计数 +1；resolved → regressed）。 */
  record(input: TrustEventRecordInput): TrustEventRow;
  /** 标记一次版本变更（R1 关联规则的锚点）。 */
  markVersionChange(version: string, at?: string): TrustEventRow;
  /** 记录一条错误指纹事件；若 2h 内发生过版本变更，额外生成关联事件（R1）。 */
  recordFingerprint(input: {
    signature: string;
    template: string;
    severity: "warn" | "critical";
    instanceId?: string;
  }): { event: TrustEventRow; regressionSuspect: TrustEventRow | null };
  list(filter?: {
    status?: TrustEventRow["status"];
    severity?: TrustEventRow["severity"];
    limit?: number;
  }): TrustEventRow[];
  get(id: number): TrustEventRow | undefined;
  setStatus(id: number, status: TrustEventRow["status"]): TrustEventRow | undefined;
}

export interface TrustEventHubOptions {
  store: SqliteStore;
  audit?: AuditLog;
  now?: () => number;
}

export function createTrustEventHub(options: TrustEventHubOptions): TrustEventHub {
  const now = options.now ?? (() => Date.now());
  const iso = () => new Date(now()).toISOString();
  let lastVersionChange: { version: string; at: number } | null = null;

  const hub: TrustEventHub = {
    record(input) {
      const event = options.store.upsertTrustEvent({
        kind: input.kind,
        severity: input.severity,
        title: input.title,
        evidence: input.evidence ?? [],
        relatedIds: input.relatedIds ?? [],
        dedupeKey: input.dedupeKey,
        at: iso(),
      });
      options.audit?.append({
        actor: "trust-events",
        action: "trust-event-recorded",
        target: input.dedupeKey,
        detail: { kind: input.kind, severity: input.severity, status: event.status, count: event.count },
      });
      return event;
    },

    markVersionChange(version, at) {
      const atMs = at !== undefined ? Date.parse(at) : now();
      lastVersionChange = { version, at: atMs };
      return hub.record({
        kind: "version-change",
        severity: "info",
        title: `实例版本变更：${version}`,
        dedupeKey: `version-change:${version}:${Math.floor(atMs / UPGRADE_REGRESSION_WINDOW_MS)}`,
        evidence: [{ version, at: new Date(atMs).toISOString() }],
      });
    },

    recordFingerprint(input) {
      const event = hub.record({
        kind: "fingerprint",
        severity: input.severity,
        title: input.template.slice(0, 80),
        dedupeKey: `fingerprint:${input.signature}`,
        evidence: [
          {
            signature: input.signature,
            instanceId: input.instanceId ?? null,
            at: iso(),
          },
        ],
      });
      // R1 升级疑似回归：版本变更窗口内的指纹 → 独立关联事件。
      let regressionSuspect: TrustEventRow | null = null;
      if (
        lastVersionChange !== null &&
        now() - lastVersionChange.at <= UPGRADE_REGRESSION_WINDOW_MS
      ) {
        regressionSuspect = hub.record({
          kind: "upgrade-regression-suspect",
          severity: "warn",
          title: `升级疑似回归：${lastVersionChange.version} 后出现「${input.template.slice(0, 60)}」`,
          dedupeKey: `upgrade-regression:${lastVersionChange.version}:${input.signature}`,
          evidence: [
            { version: lastVersionChange.version, changedAt: new Date(lastVersionChange.at).toISOString() },
            { signature: input.signature, seenAt: iso() },
          ],
          relatedIds: [String(event.id)],
        });
      }
      return { event, regressionSuspect };
    },

    list(filter) {
      return options.store.listTrustEvents(filter);
    },

    get(id) {
      return options.store.getTrustEvent(id);
    },

    setStatus(id, status) {
      const updated = options.store.updateTrustEventStatus(id, status);
      if (updated !== undefined) {
        options.audit?.append({
          actor: "trust-events",
          action: "trust-event-status-changed",
          target: String(id),
          detail: { status },
        });
      }
      return updated;
    },
  };
  return hub;
}
