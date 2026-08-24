/**
 * 实例生命周期状态机（PRD 图 2）：
 *
 *   Registered → Discovering → Confirmed → Negotiating → Serving ⇄ Degraded → Offline
 *                     └→ Rejected（终态）                      └──────────────→ Offline
 *   Offline → Negotiating（重新接入）
 *
 * - discover confidence ≥ 0.6 可自动确认（auto），否则等待人工确认（human）；
 * - Rejected 为终态，不再接受任何迁移；
 * - 每次成功迁移持久化到 instances 表并广播 instance-state-changed 事件；
 * - 非法迁移返回 E002 语义失败（不抛异常），实例不存在返回 E101。
 */
import { CAPABILITIES, fail, ok, type Capability, type CapabilityReport, type CapabilityStatus, type Level, type Result } from "@butler/contract";
import type { EventBus } from "./events.js";
import type { InstanceRow, SqliteStore } from "./store.js";

export type InstanceState =
  | "Registered"
  | "Discovering"
  | "Confirmed"
  | "Negotiating"
  | "Serving"
  | "Degraded"
  | "Offline"
  | "Rejected";

/** 自动确认的置信度门槛（detect confidence ≥ 0.6 走 auto）。 */
export const AUTO_CONFIRM_CONFIDENCE_THRESHOLD = 0.6;

/** 图 2 允许的状态迁移表。 */
export const INSTANCE_TRANSITIONS: Readonly<Record<InstanceState, readonly InstanceState[]>> = {
  Registered: ["Discovering"],
  Discovering: ["Confirmed", "Rejected"],
  Confirmed: ["Negotiating"],
  Negotiating: ["Serving"],
  Serving: ["Degraded", "Offline"],
  Degraded: ["Serving", "Offline"],
  Offline: ["Negotiating"],
  Rejected: [],
};

export interface InstanceDetail {
  evidence?: string[];
  reason?: string;
  confirmedBy?: "auto" | "human";
}

export interface InstanceRecord {
  instanceId: string;
  frameworkId: string;
  state: InstanceState;
  runtime: "docker" | "process" | "unknown";
  rootPath: string;
  version: string | null;
  confidence: number;
  capability: CapabilityReport | null;
  detail: InstanceDetail;
  createdAt: string;
  updatedAt: string;
}

export interface CreateInstanceInput {
  instanceId: string;
  frameworkId: string;
  runtime?: "docker" | "process" | "unknown";
  rootPath?: string;
  version?: string | null;
  confidence?: number;
  evidence?: string[];
}

function allNotImplemented(): Record<Capability, CapabilityStatus> {
  const caps = {} as Record<Capability, CapabilityStatus>;
  for (const c of CAPABILITIES) {
    caps[c] = "not-implemented";
  }
  return caps;
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (raw === null || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function toInstanceRecord(row: InstanceRow): InstanceRecord {
  return {
    instanceId: row.instanceId,
    frameworkId: row.frameworkId,
    state: row.state as InstanceState,
    runtime: row.runtime as InstanceRecord["runtime"],
    rootPath: row.rootPath,
    version: row.version,
    confidence: row.confidence,
    capability: safeParse<CapabilityReport | null>(row.capabilityJson, null),
    detail: safeParse<InstanceDetail>(row.detailJson, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toInstanceRow(record: InstanceRecord): InstanceRow {
  return {
    instanceId: record.instanceId,
    frameworkId: record.frameworkId,
    state: record.state,
    runtime: record.runtime,
    rootPath: record.rootPath,
    version: record.version,
    confidence: record.confidence,
    capabilityJson: record.capability === null ? null : JSON.stringify(record.capability),
    detailJson: JSON.stringify(record.detail),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export class InstanceManager {
  private store: SqliteStore;
  private bus: EventBus;

  constructor(deps: { store: SqliteStore; bus: EventBus }) {
    this.store = deps.store;
    this.bus = deps.bus;
  }

  /** 创建实例记录，初始状态 Registered（对应 manifest 注册通过后的候选）。 */
  createInstance(input: CreateInstanceInput): Result<InstanceRecord> {
    if (this.store.getInstance(input.instanceId) !== undefined) {
      return fail("E002", `instance ${input.instanceId} already exists`, {
        userHint: "实例已登记，不能重复创建",
      });
    }
    const ts = new Date().toISOString();
    const record: InstanceRecord = {
      instanceId: input.instanceId,
      frameworkId: input.frameworkId,
      state: "Registered",
      runtime: input.runtime ?? "unknown",
      rootPath: input.rootPath ?? "",
      version: input.version ?? null,
      confidence: input.confidence ?? 0,
      capability: null,
      detail: { evidence: input.evidence },
      createdAt: ts,
      updatedAt: ts,
    };
    this.store.saveInstance(toInstanceRow(record));
    return ok(record);
  }

  /** Registered → Discovering：detect() 开始。 */
  beginDiscover(instanceId: string): Result<InstanceRecord> {
    return this.move(instanceId, "Discovering");
  }

  /**
   * Discovering → Confirmed：
   * - confirmedBy="auto" 要求 confidence ≥ 0.6，否则拒绝并继续等待人工确认；
   * - confirmedBy="human" 无条件放行。
   */
  confirmInstance(instanceId: string, confirmedBy: "auto" | "human"): Result<InstanceRecord> {
    const row = this.store.getInstance(instanceId);
    if (row === undefined) {
      return fail("E101", `instance ${instanceId} not found`);
    }
    const record = toInstanceRecord(row);
    if (confirmedBy === "auto" && record.confidence < AUTO_CONFIRM_CONFIDENCE_THRESHOLD) {
      return fail(
        "E002",
        `auto confirm rejected: confidence ${record.confidence} < ${AUTO_CONFIRM_CONFIDENCE_THRESHOLD}, waiting for human confirmation`,
        { userHint: "置信度不足，等待人工确认" },
      );
    }
    return this.move(instanceId, "Confirmed", {
      apply: (r) => {
        r.detail = { ...r.detail, confirmedBy };
      },
    });
  }

  /** Discovering → Rejected（终态）：无法判定 / 多实例歧义。 */
  rejectInstance(instanceId: string, reason: string): Result<InstanceRecord> {
    return this.move(instanceId, "Rejected", { reason });
  }

  /** Confirmed → Negotiating：capabilityScan() 开始。 */
  beginNegotiate(instanceId: string): Result<InstanceRecord> {
    return this.move(instanceId, "Negotiating");
  }

  /**
   * Negotiating|Degraded → Serving：effectiveLevel 确定 / 探测恢复。
   * capability 可选，缺省时沿用已有报告仅更新 effectiveLevel。
   */
  markServing(instanceId: string, effectiveLevel: Level, capability?: CapabilityReport): Result<InstanceRecord> {
    return this.move(instanceId, "Serving", {
      apply: (r) => {
        r.capability = capability ?? r.capability ?? { effectiveLevel, capabilities: allNotImplemented(), anomalies: [] };
        r.capability = { ...r.capability, effectiveLevel };
        r.detail = { ...r.detail, reason: undefined };
      },
    });
  }

  /** Serving → Degraded：运行时能力丢失。 */
  markDegraded(instanceId: string, reason: string): Result<InstanceRecord> {
    return this.move(instanceId, "Degraded", { reason });
  }

  /** Degraded|Serving → Offline：全部能力不可用 / 实例失联。 */
  markOffline(instanceId: string, reason: string): Result<InstanceRecord> {
    return this.move(instanceId, "Offline", { reason });
  }

  /** Offline → Negotiating：重新接入。 */
  reattach(instanceId: string, reason?: string): Result<InstanceRecord> {
    return this.move(instanceId, "Negotiating", { reason });
  }

  getInstance(instanceId: string): InstanceRecord | undefined {
    const row = this.store.getInstance(instanceId);
    return row === undefined ? undefined : toInstanceRecord(row);
  }

  listInstances(): InstanceRecord[] {
    return this.store.listInstances().map(toInstanceRecord);
  }

  /* --------------------------------- internals -------------------------------- */

  private move(
    instanceId: string,
    to: InstanceState,
    opts: { reason?: string; apply?: (record: InstanceRecord) => void } = {},
  ): Result<InstanceRecord> {
    const row = this.store.getInstance(instanceId);
    if (row === undefined) {
      return fail("E101", `instance ${instanceId} not found`);
    }
    const current = toInstanceRecord(row);
    const allowed = INSTANCE_TRANSITIONS[current.state];
    if (!allowed.includes(to)) {
      return fail(
        "E002",
        `illegal instance state transition ${current.state} -> ${to} for ${instanceId} (allowed: ${allowed.join(", ") || "none"})`,
        { userHint: `实例当前处于 ${current.state} 状态，不允许迁移到 ${to}` },
      );
    }
    const next: InstanceRecord = {
      ...current,
      state: to,
      updatedAt: new Date().toISOString(),
    };
    if (opts.reason !== undefined) {
      next.detail = { ...next.detail, reason: opts.reason };
    }
    opts.apply?.(next);
    this.store.saveInstance(toInstanceRow(next));
    this.bus.emit("instance-state-changed", {
      instanceId,
      frameworkId: next.frameworkId,
      from: current.state,
      to,
      reason: opts.reason,
    });
    return ok(next);
  }
}
