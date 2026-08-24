/**
 * 网关限流统计与补丁参数面板服务（Task 15.1 butler-watch 侧）。
 *
 * 限流统计：FingerprintEngine 落库的 fingerprints（lastSample = 归一化模板）
 * 中命中 iLink 限流类模板的指纹 → 按 count 降序取前 20 条 + 24 小时窗口事件
 * 合计（fingerprint_windows 按 startedAt 截止）→ 三档 overall（ok / warn /
 * critical）。
 *
 * 画像建议（观察模式，只输出配置建议不自动应用）：
 * - last24h 1-3 条（warn）：wx-send-throttle 的 minSendIntervalSec 建议
 *   当前值 +15s（封顶 schema max 3600）；
 * - last24h > 3 条（critical）：间隔建议 +30s 封顶；另对 wx-silent-first-delay
 *   的 silentFirstDelaySec 建议 +10s，且不超过建议后的发送间隔（延迟 ≤ 间隔
 *   不变式）、封顶其 schema max；
 * - 建议值 == 当前值（已到顶）则跳过；永不低于 schema min（间隔 45 为 M3
 *   硬边界）；current 取已应用参数，未应用时取登记默认值。
 *
 * 补丁参数面板：PATCH_REGISTRY 逐条映射为面板视图（schema + 已应用状态）；
 * apply / reapply / detect 三个入口做实例解析（显式 instanceId 精确取，缺省
 * 取首个 rootPath 非空实例、优先 Serving），调用共享 createPatchManager，
 * 结果映射为面板 outcome（unknown-patch / invalid-params / patch-conflict /
 * no-instance）。全部动作落审计（actor "gateway"）。
 */
import {
  findPatch,
  type AppliedEntry,
  type DriftReport,
  type PatchDefinition,
  type PatchManager,
} from "@butler/adapter-hermes";
import type { ConfigValidation, InstanceRef, Result } from "@butler/contract";
import type { Core, FingerprintRow, FingerprintWindowRow, InstanceRecord } from "@butler/core";

/**
 * iLink 限流类模板识别正则：归一化模板中数值已变 <NUM>，故 ret=-<NUM> 只匹配
 * "ret=-" 前缀；同时覆盖中英文常见限流表述。
 */
export const RATE_LIMIT_TEMPLATE_RE =
  /rate[ _-]?limit|ret\s*=\s*-|too many|frequen|限流|频率|频控/i;

/** 24 小时窗口（毫秒）。 */
const DAY_MS = 24 * 60 * 60 * 1000;
/** 面板 matched 列表条数上限。 */
const MATCHED_LIMIT = 20;
/** stats() 读取的指纹条数上限。 */
const FINGERPRINTS_LIMIT = 500;
/** stats() 一次性读取的窗口条数上限（再按命中签名过滤）。 */
const WINDOWS_LIMIT = 2000;
/** last24h 的 warn 上界（含）；超过即 critical。 */
const WARN_LAST24H_MAX = 3;
/** warn 档发送间隔建议步进（秒）。 */
const WARN_INTERVAL_STEP_SEC = 15;
/** critical 档发送间隔建议步进（秒）。 */
const CRITICAL_INTERVAL_STEP_SEC = 30;
/** critical 档静默首条延迟建议步进（秒）。 */
const CRITICAL_DELAY_STEP_SEC = 10;

/** 面板与建议引擎引用的补丁 id / 参数名（登记表约定）。 */
const THROTTLE_PATCH_ID = "wx-send-throttle";
const THROTTLE_PARAM = "minSendIntervalSec";
const SILENT_PATCH_ID = "wx-silent-first-delay";
const SILENT_PARAM = "silentFirstDelaySec";

/** 网关面板审计 actor / action 常量。 */
export const GATEWAY_ACTOR = "gateway";
export const PATCH_APPLY_ACTION = "patch-apply";
export const PATCH_REAPPLY_ACTION = "patch-reapply";
export const PATCH_DETECT_ACTION = "patch-detect";

/* -------------------------------- 视图类型 -------------------------------- */

/** 单条命中限流模板的指纹视图。 */
export interface RateLimitMatchView {
  signature: string;
  /** 归一化错误模板（= fingerprints.lastSample）。 */
  template: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  status: string;
}

/** 单条参数调整建议（观察模式：只建议不自动应用）。 */
export interface PatchSuggestionView {
  patchId: string;
  param: string;
  current: number;
  suggested: number;
  level: "warn" | "critical";
  reason: string;
}

/** GET /api/gateway/stats 的响应体（stats 字段）。 */
export interface RateLimitPanelView {
  overall: "ok" | "warn" | "critical";
  /** 命中限流模板的指纹累计事件数（count 合计）。 */
  totalEvents: number;
  /** 命中签名近 24 小时窗口事件数（count 合计）。 */
  last24h: number;
  matched: RateLimitMatchView[];
  suggestions: PatchSuggestionView[];
}

/** GET /api/gateway/patches 的单条补丁面板视图。 */
export interface PatchPanelView {
  id: string;
  title: string;
  description: string;
  /** 目标文件路径（相对实例 rootPath，POSIX 风格）。 */
  target: string;
  /** 前置补丁 id（无前置时缺省）。 */
  requires?: string[];
  /** 参数 schema：键 → { default, min?, max?, integer? }。 */
  params: Record<string, { default: number; min?: number; max?: number; integer?: boolean }>;
  /** 已应用状态（null = 未应用）。 */
  applied: null | { params: Record<string, number>; appliedAt: string; targetPath: string };
  /** 源码中识别到的手工实现（只读，不代表 Butler 已纳管）。 */
  observed: null | {
    params: Record<string, number>;
    checkedAt: string;
    targetPath: string;
  };
}

/** apply / reapply 的结果（HTTP 层按 status 映射状态码）。 */
export type PatchApplyOutcome =
  | {
      status: "ok";
      result: "applied" | "already-applied";
      targetPath: string;
      params: Record<string, number>;
    }
  | { status: "unknown-patch" }
  | { status: "invalid-params"; error: string }
  | { status: "patch-conflict"; error: string }
  | { status: "config-blocked"; error: string }
  | { status: "no-instance" };

/** detect 的结果（HTTP 层按 status 映射状态码）。 */
export type PatchDetectOutcome =
  { status: "ok"; report: DriftReport } | { status: "unknown-patch" } | { status: "no-instance" };

/** 网关面板服务（HTTP /api/gateway/* 的依赖面）。 */
export interface GatewayPanelService {
  /** 限流统计 + 画像建议（applied 来自 patchManager.state()）。 */
  stats(): Promise<RateLimitPanelView>;
  /** 补丁参数面板（登记表 + 已应用状态）。 */
  patches(): Promise<PatchPanelView[]>;
  applyPatch(input: {
    patchId: string;
    params?: Record<string, number>;
    instanceId?: string;
  }): Promise<PatchApplyOutcome>;
  reapplyPatch(input: {
    patchId: string;
    params?: Record<string, number>;
    instanceId?: string;
  }): Promise<PatchApplyOutcome>;
  detectPatch(input: { patchId: string; instanceId?: string }): Promise<PatchDetectOutcome>;
}

export interface GatewayServiceDeps {
  core: Core;
  /** 共享补丁管理器（与升级服务同一实例）。 */
  patchManager: PatchManager;
  /** 生产写入口必须执行的配置不变式门禁。 */
  validateConfig?: (instance: InstanceRef) => Promise<Result<ConfigValidation>>;
  now?: () => number;
}

/* -------------------------------- 纯函数 -------------------------------- */

/**
 * 限流统计聚合：过滤 lastSample 命中限流正则的指纹，matched 按 count 降序
 * （上限 20 条）；totalEvents = 命中指纹 count 合计；last24h = 命中签名集合内
 * startedAt ≥ nowMs - 24h 的窗口 count 合计；suggestions 先置空（由
 * buildSuggestions 填充）。
 */
export function buildRateLimitStats(
  fingerprints: FingerprintRow[],
  windows: FingerprintWindowRow[],
  opts: { nowMs: number },
): RateLimitPanelView {
  const matchedRows = fingerprints.filter(
    (row) => row.lastSample !== null && RATE_LIMIT_TEMPLATE_RE.test(row.lastSample),
  );
  const matched: RateLimitMatchView[] = matchedRows
    .map((row) => ({
      signature: row.signature,
      template: row.lastSample!,
      count: row.count,
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
      status: row.status,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MATCHED_LIMIT);
  const totalEvents = matchedRows.reduce((sum, row) => sum + row.count, 0);

  const signatures = new Set(matchedRows.map((row) => row.signature));
  const cutoffMs = opts.nowMs - DAY_MS;
  const last24h = windows.reduce((sum, row) => {
    if (!signatures.has(row.signature)) return sum;
    // startedAt 为 ISO 字符串；解析失败（NaN）不计入。
    const startedAtMs = Date.parse(row.startedAt);
    return startedAtMs >= cutoffMs ? sum + row.count : sum;
  }, 0);

  const overall = last24h === 0 ? "ok" : last24h <= WARN_LAST24H_MAX ? "warn" : "critical";
  return { overall, totalEvents, last24h, matched, suggestions: [] };
}

/**
 * 画像建议（观察模式）：按 last24h 分档给出参数调整建议。
 * - 0 条 → 空数组；
 * - 1-3 条（warn）：发送间隔 +15s；
 * - >3 条（critical）：发送间隔 +30s；另静默首条延迟 +10s 且 ≤ 建议后的间隔；
 * - 建议值 == 当前值（已到顶）则跳过该条；永不低于 schema min。
 */
export function buildSuggestions(input: {
  last24h: number;
  registry: readonly PatchDefinition[];
  applied: Record<string, AppliedEntry>;
  observed?: Record<string, Record<string, number>>;
}): PatchSuggestionView[] {
  if (input.last24h <= 0) return [];
  const level: "warn" | "critical" = input.last24h > WARN_LAST24H_MAX ? "critical" : "warn";

  const suggestions: PatchSuggestionView[] = [];

  const throttle = input.registry.find((p) => p.id === THROTTLE_PATCH_ID);
  const throttleSchema = throttle?.params[THROTTLE_PARAM];
  if (throttle !== undefined && throttleSchema !== undefined) {
    const max = throttleSchema.max ?? Number.POSITIVE_INFINITY;
    const min = throttleSchema.min ?? 0;
    const current =
      input.applied[THROTTLE_PATCH_ID]?.params[THROTTLE_PARAM] ??
      input.observed?.[THROTTLE_PATCH_ID]?.[THROTTLE_PARAM] ??
      throttleSchema.default;
    const step = level === "critical" ? CRITICAL_INTERVAL_STEP_SEC : WARN_INTERVAL_STEP_SEC;
    const suggested = Math.max(min, Math.min(current + step, max));
    if (suggested > current) {
      suggestions.push({
        patchId: THROTTLE_PATCH_ID,
        param: THROTTLE_PARAM,
        current,
        suggested,
        level,
        reason: `近 24 小时限流事件 ${input.last24h} 条，建议上调发送间隔`,
      });
    }
    if (level === "critical") {
      const silent = input.registry.find((p) => p.id === SILENT_PATCH_ID);
      const silentSchema = silent?.params[SILENT_PARAM];
      if (silent !== undefined && silentSchema !== undefined) {
        const silentMax = silentSchema.max ?? Number.POSITIVE_INFINITY;
        const silentMin = silentSchema.min ?? 0;
        const silentCurrent =
          input.applied[SILENT_PATCH_ID]?.params[SILENT_PARAM] ??
          input.observed?.[SILENT_PATCH_ID]?.[SILENT_PARAM] ??
          silentSchema.default;
        // +10s，且不超过建议后的发送间隔（延迟 ≤ 间隔不变式），封顶 schema max
        const silentSuggested = Math.max(
          silentMin,
          Math.min(silentCurrent + CRITICAL_DELAY_STEP_SEC, suggested, silentMax),
        );
        if (silentSuggested > silentCurrent) {
          suggestions.push({
            patchId: SILENT_PATCH_ID,
            param: SILENT_PARAM,
            current: silentCurrent,
            suggested: silentSuggested,
            level,
            reason: `近 24 小时限流事件 ${input.last24h} 条（重度），建议同步上调静默期首条延迟（不超过发送间隔 ${suggested}s）`,
          });
        }
      }
    }
  }

  return suggestions;
}

/* -------------------------------- 服务组装 -------------------------------- */

/** 实例解析：显式 instanceId 精确取；缺省取首个 rootPath 非空实例（优先 Serving）。 */
function resolveInstance(core: Core, instanceId?: string): InstanceRecord | undefined {
  if (instanceId !== undefined) return core.instances.getInstance(instanceId);
  const withRoot = core.instances.listInstances().filter((r) => r.rootPath !== "");
  return withRoot.find((r) => r.state === "Serving") ?? withRoot[0];
}

export function createGatewayService(deps: GatewayServiceDeps): GatewayPanelService {
  const core = deps.core;
  const patchManager = deps.patchManager;
  const now = deps.now ?? Date.now;

  async function observeUnmanaged(
    applied: Record<string, AppliedEntry>,
  ): Promise<Record<string, DriftReport>> {
    const record = resolveInstance(core);
    if (record === undefined || record.rootPath === "") return {};
    const reports = await Promise.all(
      patchManager.listPatches().map(async (def) => {
        if (applied[def.id] !== undefined) return null;
        const result = await patchManager.detect(def.id, { rootPath: record.rootPath });
        if (!result.ok || result.data?.status !== "observed") return null;
        return [def.id, result.data] as const;
      }),
    );
    return Object.fromEntries(reports.filter((entry) => entry !== null));
  }

  async function stats(): Promise<RateLimitPanelView> {
    // 一次取大窗口再按命中签名过滤（比逐签名查询省事）
    const fingerprints = core.store.listFingerprints(FINGERPRINTS_LIMIT);
    const windows = core.store.listFingerprintWindows({ limit: WINDOWS_LIMIT });
    const view = buildRateLimitStats(fingerprints, windows, { nowMs: now() });
    const applied = await patchManager.state();
    const observedReports = await observeUnmanaged(applied);
    const observed = Object.fromEntries(
      Object.entries(observedReports).map(([patchId, report]) => [patchId, report.params ?? {}]),
    );
    view.suggestions = buildSuggestions({
      last24h: view.last24h,
      registry: patchManager.listPatches(),
      applied,
      observed,
    });
    return view;
  }

  async function patches(): Promise<PatchPanelView[]> {
    const applied = await patchManager.state();
    const observed = await observeUnmanaged(applied);
    return patchManager.listPatches().map((def) => {
      const entry = applied[def.id];
      const observedReport = observed[def.id];
      const view: PatchPanelView = {
        id: def.id,
        title: def.title,
        description: def.description,
        target: def.target,
        params: def.params,
        applied:
          entry === undefined
            ? null
            : { params: entry.params, appliedAt: entry.appliedAt, targetPath: entry.targetPath },
        observed:
          observedReport === undefined
            ? null
            : {
                params: observedReport.params ?? {},
                checkedAt: observedReport.checkedAt,
                targetPath: observedReport.targetPath ?? def.target,
              },
      };
      if (def.requires !== undefined) view.requires = [...def.requires];
      return view;
    });
  }

  /** apply / reapply 公共实现：实例解析 → unknown-patch 前置判定 → 调用管理器 → 结果映射 + 审计。 */
  async function runPatchAction(
    action: typeof PATCH_APPLY_ACTION | typeof PATCH_REAPPLY_ACTION,
    call: PatchManager["apply"] | PatchManager["reapply"],
    input: { patchId: string; params?: Record<string, number>; instanceId?: string },
  ): Promise<PatchApplyOutcome> {
    const record = resolveInstance(core, input.instanceId);
    let outcome: PatchApplyOutcome;
    if (record === undefined || record.rootPath === "") {
      outcome = { status: "no-instance" };
    } else if (findPatch(input.patchId) === undefined) {
      outcome = { status: "unknown-patch" };
    } else {
      const validation = await deps.validateConfig?.({
        instanceId: record.instanceId,
        rootPath: record.rootPath,
        runtime: record.runtime,
      });
      if (validation !== undefined && (!validation.ok || validation.data?.passed !== true)) {
        const detail = validation.ok
          ? (validation.data?.violations ?? [])
              .filter((violation) => violation.severity === "block")
              .map((violation) => violation.detail)
              .join("；")
          : validation.error?.userHint ?? validation.error?.message ?? "配置校验失败";
        outcome = { status: "config-blocked", error: detail || "配置不变式未通过" };
      } else {
        const preflight = await patchManager.detect(input.patchId, { rootPath: record.rootPath });
        if (preflight.ok && preflight.data?.status === "observed") {
        outcome = {
          status: "patch-conflict",
          error: "源码中已检测到同等手工实现；Butler 未纳管且不会覆盖，请保留只读观察",
        };
        } else {
          const result = await call(input.patchId, input.params ?? {}, { rootPath: record.rootPath });
          if (result.ok && result.data !== undefined) {
            outcome = {
              status: "ok",
              result: result.data.status,
              targetPath: result.data.targetPath,
              params: result.data.params,
            };
          } else if (result.ok) {
            // Result 契约声明 ok=true 必有 data；仍做运行时防御，避免异常对象越过 HTTP 边界。
            outcome = { status: "patch-conflict", error: "补丁适配器返回成功但缺少结果数据" };
          } else if (result.error?.code === "E002") {
            // 参数越界/非数值等（unknown patch 已前置拦截）
            outcome = {
              status: "invalid-params",
              error: result.error.userHint ?? result.error.message,
            };
          } else {
            // E203：锚点漂移 / 目标缺失 / 前置补丁未应用 / 白名单拒绝
            outcome = {
              status: "patch-conflict",
              error: result.error?.userHint ?? result.error?.message ?? "",
            };
          }
        }
      }
    }
    core.audit.append({
      actor: GATEWAY_ACTOR,
      action,
      target: record?.instanceId ?? input.instanceId ?? "",
      detail: { patchId: input.patchId, params: input.params ?? {}, outcome },
    });
    return outcome;
  }

  async function detectPatch(input: {
    patchId: string;
    instanceId?: string;
  }): Promise<PatchDetectOutcome> {
    const record = resolveInstance(core, input.instanceId);
    let outcome: PatchDetectOutcome;
    if (record === undefined || record.rootPath === "") {
      outcome = { status: "no-instance" };
    } else if (findPatch(input.patchId) === undefined) {
      outcome = { status: "unknown-patch" };
    } else {
      const result = await patchManager.detect(input.patchId, { rootPath: record.rootPath });
      outcome =
        result.ok && result.data !== undefined
          ? { status: "ok", report: result.data }
          : { status: "unknown-patch" };
    }
    core.audit.append({
      actor: GATEWAY_ACTOR,
      action: PATCH_DETECT_ACTION,
      target: record?.instanceId ?? input.instanceId ?? "",
      detail: { patchId: input.patchId, outcome },
    });
    return outcome;
  }

  return {
    stats,
    patches,
    applyPatch: (input) =>
      runPatchAction(PATCH_APPLY_ACTION, patchManager.apply.bind(patchManager), input),
    reapplyPatch: (input) =>
      runPatchAction(PATCH_REAPPLY_ACTION, patchManager.reapply.bind(patchManager), input),
    detectPatch,
  };
}
