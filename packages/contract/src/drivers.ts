import type { ChannelId, InstanceRef, Result } from "./common.js";

/** 记忆检索预览的硬上限：preview 一次最多返回 50 条。 */
export const MEMORY_PREVIEW_LIMIT = 50;

/** 驱动操作作用域：实例引用 + 驱动负责的数据根路径。 */
export interface DriverScope {
  instance: InstanceRef;
  rootPath: string;
}

/* ------------------------------- skill driver ------------------------------ */

export type SkillSource = "builtin" | "market" | "self-evolved" | "user";
export type AssetRiskStatus = "unscanned" | "clear" | "blocked";

export interface SkillRef {
  name: string;
  version?: string;
  source?: SkillSource;
}

export interface SkillParameter {
  name: string;
  type: "string" | "number" | "boolean" | "enum";
  required: boolean;
  enumValues?: string[];
  description?: string;
}

export interface SkillDefinition {
  ref: SkillRef;
  name: string;
  version: string;
  source: SkillSource;
  description?: string;
  /** 技能入口（脚本/命令/函数名，按框架语义）。 */
  entry?: string;
  parameters?: SkillParameter[];
  /** 原始定义文档（Markdown 等），供面板展示与守门员审计。 */
  raw?: string;
}

export interface SkillMeta {
  ref: SkillRef;
  name: string;
  version: string;
  source: SkillSource;
  enabled: boolean;
  /** 分类：SKILL.md frontmatter 的 category/分类，缺省按目录推断。 */
  category?: string;
  description?: string;
  /** 风险扫描状态；未执行扫描时必须明确标记为 unscanned。 */
  riskStatus?: AssetRiskStatus;
  riskDetail?: string;
  usage?: number;
  lastUsedAt?: string | null;
  successRate?: number | null;
  avgDurationMs?: number | null;
  usageCoverage?: { from: string | null; to: string | null; days: number; source: string; complete: boolean };
}

export interface ValidationIssue {
  severity: "error" | "warn";
  /** 问题定位（如参数路径 "parameters[2].name"）。 */
  path: string;
  message: string;
}

export interface ValidationReport {
  valid: boolean;
  issues: ValidationIssue[];
}

/** I-4 技能驱动：enumerate/parse/validate 只读，setEnabled/rollbackVersion 为写操作。 */
export interface SkillDriver {
  readonly id: string;
  enumerate(scope: DriverScope): Promise<Result<SkillMeta[]>>;
  parse(ref: SkillRef): Promise<Result<SkillDefinition>>;
  validate(def: SkillDefinition): Promise<Result<ValidationReport>>;
  setEnabled(ref: SkillRef, enabled: boolean): Promise<Result<void>>;
  rollbackVersion(ref: SkillRef, to: string): Promise<Result<void>>;
}

/* ------------------------------ plugin driver ----------------------------- */

export type PluginSource = "builtin" | "market" | "self-evolved" | "user";

export interface PluginRef {
  name: string;
  version?: string;
  source?: PluginSource;
}

export interface PluginMeta {
  ref: PluginRef;
  name: string;
  version: string;
  source: PluginSource;
  enabled: boolean;
  /** 分类：元数据 category/分类，缺省按目录推断。 */
  category?: string;
  description?: string;
  /** 风险扫描状态；未执行扫描时必须明确标记为 unscanned。 */
  riskStatus?: AssetRiskStatus;
  riskDetail?: string;
}

/** I-4 插件驱动：V1 只读枚举，写操作后续版本。 */
export interface PluginDriver {
  readonly id: string;
  enumerate(scope: DriverScope): Promise<Result<PluginMeta[]>>;
}

/* ------------------------------ memory driver ------------------------------ */

export interface MemoryQuery {
  keyword?: string;
  channel?: ChannelId;
  /** ISO-8601 时间过滤。 */
  since?: string;
  until?: string;
  /** 请求条数上限；驱动必须把返回条数钳制在 MEMORY_PREVIEW_LIMIT 内。 */
  limit?: number;
}

export interface MemoryEntry {
  entryId: string;
  writtenAt: string;
  content: string;
  channel?: ChannelId;
  sessionId?: string;
  sizeBytes?: number;
  /** 是否冷数据候选（长期未读）。 */
  cold?: boolean;
}

export interface MemoryStats {
  totalEntries: number;
  /** 按月聚合：month 形如 "2026-08"。 */
  byMonth: { month: string; count: number }[];
  coldCandidates: number;
  /** 最近一次写入时间（ISO-8601），库从未写入过则为 null（用于停写检测）。 */
  lastWriteAt: string | null;
  /** 已归档（冷存）条目数；无归档表或驱动不支持时为 0。 */
  archivedEntries: number;
  /** 库中残留的探针测试记忆条数（butler-probe）。 */
  probeEntries: number;
  /** 有过召回记录（retrieval_count > 0）的用户记忆条数。 */
  recalledEntries: number;
  /** 全部用户记忆的累计召回次数（SUM retrieval_count）。 */
  cumulativeRecalls: number;
  /** 管家记忆探针写入尝试/失败次数（最近 50 次窗口；无记录为 0）。 */
  probeWriteAttempts: number;
  probeWriteFailures: number;
  /** 管家记忆探针召回尝试/成功次数（最近 50 次窗口；无记录为 0）。 */
  probeRecallAttempts: number;
  probeRecallHits: number;
}

export interface IntegrityProblem {
  entryId?: string;
  /** 问题类别（如 "fts-index-missing" / "corrupt-row"）。 */
  kind: string;
  detail: string;
}

export interface IntegrityReport {
  healthy: boolean;
  checkedAt: string;
  totalChecked: number;
  problems: IntegrityProblem[];
}

export interface ArchivePolicy {
  /** 早于该时间点（ISO-8601）的条目视为冷数据候选。 */
  olderThan?: string;
  /** 只统计不落盘。 */
  dryRun?: boolean;
  /** 热数据保留窗口（月数）。 */
  keepMonths?: number;
  /** 精确指定要归档的 fact_id 列表（与时间窗口取交集）。 */
  entryIds?: string[];
}

export interface ArchiveReport {
  archived: number;
  freedBytes: number;
  dryRun: boolean;
  errors: string[];
}

export interface RestorePolicy {
  /** 精确指定要恢复的 fact_id 列表；缺省恢复全部已归档。 */
  entryIds?: string[];
  /** 只恢复归档时间早于该时间点（ISO-8601）的条目。 */
  olderThan?: string;
}

export interface RestoreReport {
  restored: number;
  errors: string[];
}

export interface PurgePolicy {
  /** 物理删除必须显式确认，false/缺省一律拒绝。 */
  confirmed: boolean;
  /** 清理范围：archived=已归档冷存（默认，需超过 30 天）；probes=过期探针测试记忆。 */
  kind?: "archived" | "probes";
  /** 精确指定要删除的 fact_id 列表（仍必须 confirmed）。 */
  entryIds?: string[];
  /** 只删除归档时间早于该时间点（ISO-8601）的条目；缺省 30 天前。 */
  archivedBefore?: string;
}

export interface PurgeReport {
  purged: number;
  freedBytes: number;
  errors: string[];
}
export interface RebuildIndexReport {
  rebuilt: boolean;
  rowsBefore: number;
  rowsAfter: number;
  errors: string[];
}

export interface MemorySignal {
  id: string;
  label: string;
  status: "ok" | "warn" | "error" | "unknown";
  detail: string;
}

export interface MemorySuggestion {
  id: string;
  kind: "archive" | "restore" | "rebuild-index" | "purge-probes" | "backup" | "notice";
  title: string;
  detail: string;
  /** 面板可一键触发的动作；无 action 表示仅提示。 */
  action?: "archive-cold" | "restore-archived" | "purge-probes" | "purge-archived" | "rebuild-index";
}

export interface MemoryHealth {
  /** 0-100，越高越健康。 */
  score: number;
  checkedAt: string;
  signals: MemorySignal[];
  suggestions: MemorySuggestion[];
}

/** I-4 记忆驱动：stats/preview/verifyIntegrity/analyze 只读，archive/restore/purge 为写操作。 */
export interface MemoryDriver {
  readonly id: string;
  stats(scope: DriverScope): Promise<Result<MemoryStats>>;
  preview(scope: DriverScope, q: MemoryQuery): Promise<Result<MemoryEntry[]>>;
  verifyIntegrity(scope: DriverScope): Promise<Result<IntegrityReport>>;
  /** 健康评分与优化建议（观察面）。 */
  analyze(scope: DriverScope): Promise<Result<MemoryHealth>>;
  /** 冷存归档：只归档不删除，30 天内可恢复。 */
  archiveCold(scope: DriverScope, policy: ArchivePolicy): Promise<Result<ArchiveReport>>;
  /** 恢复已归档条目（从归档表移除标记）。 */
  restoreCold(scope: DriverScope, policy: RestorePolicy): Promise<Result<RestoreReport>>;
  /** 物理删除：仅限已确认且超过保留期的归档条目，或过期探针测试记忆。 */
  purge(scope: DriverScope, policy: PurgePolicy): Promise<Result<PurgeReport>>;
  /** 重建 FTS 索引（探针失败后引导执行；写动作，执行前由调用方快照）。 */
  rebuildIndex(scope: DriverScope): Promise<Result<RebuildIndexReport>>;
}

/* ------------------------------ config driver ------------------------------ */

export interface Invariant {
  id: string;
  severity: "block" | "warn";
  description?: string;
}

export interface ConfigFileSnapshot {
  /** 相对驱动根路径的文件路径。 */
  path: string;
  content: string;
  hash: string;
}

export interface ConfigSnapshot {
  takenAt: string;
  files: ConfigFileSnapshot[];
}

export interface MigrationTarget {
  version: string;
  notes?: string;
}

export interface MigrationStep {
  id: string;
  label: string;
  command?: string;
  risk: "safe" | "caution" | "danger";
}

export interface MigrationPlan {
  target: MigrationTarget;
  steps: MigrationStep[];
  requiresDowntime: boolean;
}

/** I-4 配置驱动：不变式清单、配置快照与迁移计划（只读分析）。 */
export interface ConfigDriver {
  readonly id: string;
  invariants(): Invariant[];
  snapshot(scope: DriverScope): Promise<Result<ConfigSnapshot>>;
  planMigration(scope: DriverScope, to: MigrationTarget): Promise<Result<MigrationPlan>>;
}
