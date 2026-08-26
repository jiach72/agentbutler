/**
 * 设置页共享类型与文案映射：安全基线 / 备份 / 审计各数据源的载荷类型，
 * 以及 invariant 状态等中文标签的唯一映射表（此前两处重复，现合并于此）。
 */
import type { FetchState } from "../../lib/api.js";

export interface SecurityBaselinePayload {
  listenHost: string;
  auth: boolean;
  warnings: string[];
}

export interface AlertsPayload {
  reachable: boolean;
}

export interface RunbookSummary {
  id: string;
  label: string;
  description: string;
  breakerTripped: boolean;
  lastRun?: { at: string; success: boolean };
}

export interface RunbooksPayload {
  reachable: boolean;
  runbooks: RunbookSummary[];
}

export interface InvariantView {
  id: string;
  title: string;
  status: "pass" | "warn" | "fail" | "unknown";
  detail: string;
  rule: string;
}

export interface SecretFileView {
  rel: string;
  path: string;
  mode: string;
  secure: boolean;
  sizeBytes: number;
  modifiedAt: string;
}

export interface SecurityPayload {
  watchReachable: boolean;
  checkedAt: string | null;
  invariants: InvariantView[];
  secrets: SecretFileView[];
  totalSecretFiles: number;
  insecureSecretFiles: number;
  message: string;
}

export interface BackupItem {
  id: number;
  kind: "full" | "memory" | "event";
  label: string | null;
  target: string;
  path: string;
  sizeBytes: number;
  status: string;
  createdAt: string;
}

export interface BackupsPayload {
  watchReachable: boolean;
  items: BackupItem[];
  status: null | {
    enabled: boolean;
    lastFullAt: string | null;
    lastMemoryAt: string | null;
    hourlyTickMs: number;
    retention?: { full: number; memory: number; event: number };
  };
}

export interface ButlerSelfPayload {
  reachable: boolean;
  snapshots: Array<{ id: string; at: string; version: string; reason: string }>;
  snapshotRetention?: number;
}

export interface AuditItem {
  id: number;
  ts: string;
  actor: string;
  action: string;
  target: string;
  detail: unknown;
}

export interface AuditPayload {
  items: AuditItem[];
  degraded?: string[];
}

export type SettingsConfirmAction =
  | { kind: "reset"; runbook: RunbookSummary }
  | { kind: "restore"; backup: BackupItem };

/** 七路数据源 → 各自载荷类型的映射。 */
export interface SourcePayloads {
  baseline: SecurityBaselinePayload;
  alerts: AlertsPayload;
  runbooks: RunbooksPayload;
  security: SecurityPayload;
  backups: BackupsPayload;
  butlerSelf: ButlerSelfPayload;
  audit: AuditPayload;
}

export type SettingsSourceKey = keyof SourcePayloads;

export type SourcesState = {
  [K in keyof SourcePayloads]: FetchState<SourcePayloads[K]>;
};

export const SOURCE_KEYS: SettingsSourceKey[] = [
  "baseline",
  "alerts",
  "runbooks",
  "security",
  "backups",
  "butlerSelf",
  "audit",
];

export function createInitialSources(): SourcesState {
  return {
    baseline: { status: "loading" },
    alerts: { status: "loading" },
    runbooks: { status: "loading" },
    security: { status: "loading" },
    backups: { status: "loading" },
    butlerSelf: { status: "loading" },
    audit: { status: "loading" },
  };
}

const DEFAULT_BACKUP_RETENTION = { full: 14, memory: 24, event: 10 };
const DEFAULT_SNAPSHOT_RETENTION = 3;

/** 单一降级文案：任何数据源 failed 时区块统一展示这句话。 */
export const DEGRADED_TEXT = "这一项暂时读不到";

export function backupRetentionOf(backups: BackupsPayload | null): {
  full: number;
  memory: number;
  event: number;
} {
  return backups?.status?.retention ?? DEFAULT_BACKUP_RETENTION;
}

export function snapshotRetentionOf(butlerSelf: ButlerSelfPayload | null): number {
  return butlerSelf?.snapshotRetention ?? DEFAULT_SNAPSHOT_RETENTION;
}

/** FetchState → 可空数据：ready 之外一律按 null 处理。 */
export function sourceData<T>(state: FetchState<T>): T | null {
  return state.status === "ready" ? state.data : null;
}

/**
 * invariant 状态 → 中文标签的唯一映射表。
 * 此前在基线明细拼接与规则详情渲染中重复两份，现合并为一张表。
 */
export const INVARIANT_STATUS_LABELS: Record<InvariantView["status"], string> = {
  pass: "通过",
  warn: "需留意",
  fail: "未通过",
  unknown: "未核验",
};

export function invariantStatusLabel(status: InvariantView["status"]): string {
  return INVARIANT_STATUS_LABELS[status] ?? "未核验";
}

export function invariantAggregate(invariants: InvariantView[]): { status: string; label: string } {
  if (invariants.length === 0) return { status: "partial", label: "建设中" };
  if (invariants.some((item) => item.status === "fail")) {
    return { status: "warn", label: "需处理" };
  }
  if (invariants.every((item) => item.status === "pass")) {
    return { status: "pass", label: "已满足" };
  }
  return { status: "partial", label: "部分核验" };
}

export function snapshotStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    created: "已创建",
    completed: "已完成",
    restored: "已还原",
    reverted: "已回滚",
    pending: "等待中",
    failed: "失败",
    expired: "已过期",
    ok: "可用",
  };
  return labels[status] ?? "已记录";
}

export function backupKindLabel(kind: BackupItem["kind"]): string {
  if (kind === "memory") return "记忆增量";
  if (kind === "event") return "操作前备份";
  return "每日全量";
}

const ACTOR_LABELS: Record<string, string> = {
  backup: "自动备份",
  runbook: "自动修复",
  upgrade: "版本更新",
  gateway: "消息设置",
  evolution: "进化守门",
  memory: "记忆管理",
  "butler-watch": "管家巡检",
  "butler-core": "管家内核",
  prompt: "提示词管理",
};

export function actorLabel(actor: string): string {
  return ACTOR_LABELS[actor] ?? "管家";
}

export function auditActionLabel(action: string): string {
  const labels: Record<string, string> = {
    "backup-full": "每日全量备份",
    "backup-memory": "记忆增量备份",
    "backup-event": "操作前自动备份",
    "backup-restore": "从备份还原",
    "runbook-start": "开始自动修复",
    "runbook-step": "修复步骤",
    "runbook-completed": "修复完成",
    "upgrade-start": "开始升级",
    "upgrade-done": "升级完成",
    "upgrade-failed": "升级失败",
    "upgrade-rollback": "升级回滚",
    "circuit-breaker-reset": "解除崩溃保护",
  };
  return labels[action] ?? action;
}
