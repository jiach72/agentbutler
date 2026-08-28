/**
 * createWatchApp：butler-watch 应用组装。
 *
 * createCore → 选择 Hermes/OpenClaw 适配器（注入 store/snapshotsDir）→ registry 注册
 * → detect → 生命周期接线（Registered→Discovering→Confirmed→Negotiating→Serving）
 * → logSources 注册 LogTailer → FingerprintEngine → tail 轮询循环（interval 驱动
 * poll(handler)，handler 把每行喂 engine.ingest）→ InspectionScheduler.start()
 * → alert-forward 订阅。
 *
 * Task 6：巡检阶段含三类功能探针 + 停写检测（sqlite/fetch/env 全注入）。
 * Task 7：巡检完成后（runner 内 onInspection 回调，比订阅 bus 更直接）按
 * 自动规则触发 runbook（memory-probe fail → rb-restart；channel-probe fail →
 * rb-reconnect；process-alive fail → rb-restart；触发前查熔断 + 防抖）；
 * runbook 执行器与熔断器挂到返回值（手动入口 runRunbook 供 Task 10 面板调用）。
 *
 * 返回 { core, tailer, engine, scheduler, forwarder, runbookExecutor, breaker,
 * alertPoster, watchHttp, upgrade, gateway, evolution, skills, instances, pollTail, stop() }；stop 顺序：停循环 →
 * 关 HTTP → engine.close → core.close。
 * Task 10 前置：watchHttp 为 HTTP 控制通道（127.0.0.1:7533 可配，端点契约见 http.ts），
 * 挂 scheduler（runNow/status）与 runbook 元信息/执行判定（含熔断与 Serving 实例解析）。
 * Task 13：upgrade 为升级服务（hermes 五步流水线接线 + 审计 + 完成通知冷却合并 +
 * 熔断联动 + 快照回滚；HTTP /api/upgrade/* 与 /api/snapshots/:id/rollback）。
 * Task 15：共享 patchManager（升级流水线与网关面板同一实例），gateway 为网关
 * 限流统计 + 补丁参数面板服务（HTTP /api/gateway/*；限流指纹画像建议 + 补丁
 * apply/reapply/detect，全部动作落审计）。
 */
import { randomUUID } from "node:crypto";
import { join, posix } from "node:path";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { ControlAdapter, DiscoveryHint, InstanceRef, Result } from "@butler/contract";
import {
  createHermesAdapter,
  createPatchManager,
  type CommandExecutor,
  type PortProber,
} from "@butler/adapter-hermes";
import { createOpenClawAdapter } from "@butler/adapter-openclaw";
import {
  createCore,
  FingerprintEngine,
  LogTailer,
  toInstanceRow,
  type Core,
  type InspectionCompletedPayload,
  type InstanceRecord,
  type TailedBatch,
} from "@butler/core";
import {
  createAlertPoster,
  startAlertForwarder,
  type AlertForwarder,
  type AlertPoster,
} from "./alert-forward.js";
import { CRITICAL_PROBE_SLA_MIN, loadWatchConfig, type WatchConfig } from "./config.js";
import type { FetchLike } from "./dashboard-signal.js";
import {
  createEvolutionService,
  EVOLUTION_ACTOR,
  EVOLUTION_PREFLIGHT_ACTION,
  type EvolutionPreflightOutcome,
  type EvolutionService,
} from "./evolution.js";
import { createGatewayService, type GatewayPanelService } from "./gateway-stats.js";
import {
  startWatchHttp,
  type RunbookExecuteOutcome,
  type RunbookResetOutcome,
  type RunbookSummary,
  type WatchHttp,
  type WatchHttpDeps,
  type MemorySelfCheckOutcome,
} from "./http.js";
import { createDefaultStages, type InspectionStage, type ResourceSampler } from "./pipeline.js";
import { createMemoryProbeStage } from "./probes/memory-probe.js";
import { renderDiagnosticReport } from "./diagnostics.js";
import type { LogMtimeSampler } from "./probes/stall-write.js";
import type { SqliteOpener } from "./probes/memory-probe.js";
import { createSkillsMemoryService, type SkillsMemoryService } from "./skills.js";
import { createLogAnalyzer } from "./log-analyzer.js";
import {
  createPromptOptimizationService,
  type PromptOptimizationService,
} from "./prompt-optimization.js";
import { resolveButlerSourceDir } from "./self-upgrade.js";
import {
  createWiredBreaker,
  createBuiltinRunbooks,
  RB_RECONNECT,
  RB_RESTART,
  RunbookExecutor,
  type CircuitBreaker,
} from "./runbook/index.js";
import {
  createInspectionRunner,
  CriticalProbeScheduler,
  InspectionScheduler,
  type CriticalProbeResult,
  type TimerDriver,
  defaultTimerDriver,
} from "./scheduler.js";
import { createUpgradeService, type UpgradeService } from "./upgrade.js";
import {
  createButlerSelfUpgradeService,
  type ButlerSelfService,
} from "./self-upgrade.js";
import { createBackupService, type BackupService } from "./backup.js";
import { createSecurityService, type SecurityService } from "./invariants.js";
import { createRuntimeCommandExecutor, detectButlerRuntime, type ButlerRuntimeInfo } from "./runtime.js";

const DEFAULT_BUTLER_REPOSITORY = "https://github.com/jiach72/agentbutler";

export interface WatchAppOptions {
  /** 配置覆盖（env 之上的显式注入）。 */
  config?: Partial<WatchConfig>;
  /** home 语法糖（等价 config.home）。 */
  home?: string;
  /** 框架探测 hint（缺省按对应 root 构造）。 */
  detectHint?: DiscoveryHint;
  /** 探测注入：命令执行器 / 端口探活 / 资源采样 / fetch。 */
  exec?: CommandExecutor;
  prober?: PortProber;
  sampler?: ResourceSampler;
  fetchFn?: FetchLike;
  /** Task 6 探针注入：SQLite 打开器（memory-probe）。 */
  sqlite?: SqliteOpener;
  /** Task 6 探针注入：日志 mtime 采集器（stall-write）。 */
  logMtimeSampler?: LogMtimeSampler;
  /** Task 6 探针注入：可注入时钟（memory-probe 清理 / stall-write 静默判定）。 */
  now?: () => number;
  /** 注入式定时器（测试 fake timer）。 */
  timerDriver?: TimerDriver;
  /** 追加到内置阶段之后的额外巡检阶段。 */
  extraStages?: InspectionStage[];
  /** 是否自动启动调度与 tail 循环（默认 true；测试可关）。 */
  autoStart?: boolean;
}

export interface WatchApp {
  core: Core;
  config: WatchConfig;
  runtime: ButlerRuntimeInfo;
  tailer: LogTailer;
  engine: FingerprintEngine;
  scheduler: InspectionScheduler;
  /** M1：独立关键记忆探针调度器（默认每分钟，10 分钟 SLA deadline）。 */
  criticalScheduler: CriticalProbeScheduler;
  forwarder: AlertForwarder;
  /** Task 7：runbook 执行器（手动入口 runRunbook 供面板调用）。 */
  runbookExecutor: RunbookExecutor;
  /** Task 7：崩溃循环熔断器（recordJobFailure 供 Job 层复用）。 */
  breaker: CircuitBreaker;
  /** 公共告警 POST 器（runbook/熔断告警与指纹转发共用）。 */
  alertPoster: AlertPoster;
  /** Task 10 前置：HTTP 控制通道（runbooks 列表/执行 + 巡检触发/状态 + healthz）。 */
  watchHttp: WatchHttp;
  /** Task 13：升级服务（发起/状态/版本列表/快照回滚；HTTP /api/upgrade/* 与 /api/snapshots/:id/rollback）。 */
  upgrade: UpgradeService;
  /** Task 15：网关限流统计与补丁参数面板服务（HTTP /api/gateway/*）。 */
  gateway: GatewayPanelService;
  /** Task 16：进化预检、扩集、写入守门与 Markdown 台账服务。 */
  evolution: EvolutionService;
  /** Task 17：技能与记忆只读清单、统计、检索预览与目录降级服务。 */
  skills: SkillsMemoryService;
  /** M5 切片 1/2：提示词 Registry + 候选持久化 + 成对评估服务。 */
  promptOptimization: PromptOptimizationService;
  /** Task 18：备份服务（每日全量/记忆增量/事件触发 + 还原）。 */
  backup: BackupService;
  /** Task 18：安全基线（三条配置不变式 + 密钥权限扫描）。 */
  security: SecurityService;
  /** 本次组装时检出的实例。 */
  instances: InstanceRecord[];
  /** 手动驱动一次 tail 轮询（测试 / 即时采集）。 */
  pollTail(): Promise<void>;
  /** 优雅停止：停循环 → engine.close → core.close。 */
  stop(): void;
}

/** 进化前事件备份包装：备份失败时返回拒绝结果，不触发真实预检或快照。 */
export function withEvolutionBackup(
  evolution: EvolutionService,
  backup: BackupService,
  core: Core,
): EvolutionService {
  const backupFailureRun = (
    targetType: "skill" | "prompt" | "config",
    targetRef: string,
    instanceId: string | undefined,
    detail: string,
  ) => {
    const runId = `backup-rejected-${randomUUID()}`;
    const timestamp = new Date().toISOString();
    core.audit.append({
      actor: EVOLUTION_ACTOR,
      action: EVOLUTION_PREFLIGHT_ACTION,
      target: instanceId ?? targetRef,
      detail: { runId, status: "preflight-failed", reason: "prebackup-failed", error: detail },
    });
    return {
      runId,
      targetType,
      targetRef,
      status: "preflight-failed" as const,
      createdAt: timestamp,
      updatedAt: timestamp,
      checks: [{
        id: "snapshot" as const,
        label: "运行前快照",
        status: "fail" as const,
        detail: `进化前事件备份失败：${detail}`,
        action: "修复备份目录、权限或数据库后重试",
      }],
      blocked: true,
      detail: "备份失败，Hermes 未启动且 baseline 未修改",
      logTail: { stdout: [], stderr: [] },
    };
  };

  const takeBackup = async (): Promise<string | null> => {
    try {
      const snapshot = await backup.run("event", "进化前自动备份");
      if (!Number.isInteger(snapshot.id) || snapshot.id <= 0) {
        throw new Error("进化前备份未返回有效登记 ID");
      }
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  return {
    ...evolution,
    async preflight(input) {
      const detail = await takeBackup();
      if (detail !== null) {
        const runId = `backup-rejected-${randomUUID()}`;
        const ledgerPath = "";
        const rejected: EvolutionPreflightOutcome = {
          runId,
          status: "rejected-preflight",
          allowRun: false,
          instanceId: input.instanceId ?? null,
          checks: [
            {
              id: "snapshot",
              label: "运行前快照",
              status: "fail",
              detail: `进化前事件备份失败：${detail}`,
              action: "修复备份目录、权限或数据库后重试",
            },
          ],
          ledgerPath,
        };
        core.audit.append({
          actor: EVOLUTION_ACTOR,
          action: EVOLUTION_PREFLIGHT_ACTION,
          target: input.instanceId ?? "",
          detail: { runId, status: rejected.status, reason: "prebackup-failed", error: detail },
        });
        return rejected;
      }
      return evolution.preflight(input);
    },
    async createRun(input) {
      const detail = await takeBackup();
      return detail === null
        ? evolution.createRun(input)
        : backupFailureRun(input.targetType, input.targetRef, input.instanceId, detail);
    },
  };
}

/** detect 置信度门槛（与内核 auto confirm 阈值一致，低于则等待人工确认）。 */
const AUTO_CONFIRM_THRESHOLD = 0.6;

/** 管家自身服务日志源（journald 只读视图）。 */
const BUTLER_LOG_SERVICES = [
  { id: "butler:watch", service: "butler-watch", label: "管家守护进程" },
  { id: "butler:web", service: "butler-web", label: "管家 Web 服务" },
  { id: "butler:gateway", service: "agent-butler-gateway", label: "消息网关" },
  { id: "butler:vite", service: "butler-vite", label: "管家前端" },
] as const;

/** 读取 systemd --user 服务日志尾部；无 systemd 环境时返回错误说明。 */
function readJournalTail(
  service: string,
  limit: number,
): { lines: string[]; truncated: boolean; totalLines: number; error?: string } {
  try {
    const stdout = execFileSync(
      "journalctl",
      ["--user", "-u", service + ".service", "-n", String(limit), "--no-pager", "-o", "short-iso"],
      { encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const lines = stdout.split(/\r?\n/).filter((line) => line !== "");
    return { lines: lines.slice(-limit), truncated: false, totalLines: lines.length };
  } catch (cause) {
    return {
      lines: [],
      truncated: false,
      totalLines: 0,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/** 日志分页读取结果（文件源；pageStart 为下一页锚点 byte offset）。 */
interface LogPage {
  lines: string[];
  pageStart: number | null;
  hasOlder: boolean;
  hasNewer: boolean;
  totalLines: number;
  truncated: boolean;
  error?: string;
}

/** 单页日志最多回读的字节数（避免大文件整读）。 */
const LOG_PAGE_MAX_BYTES = 512 * 1024;

/**
 * 按 byte offset 游标读取日志文件的上一页（PRD M1：日志按时间倒序分页）。
 * before=null 表示最新页；before 为上一页 pageStart 时向前翻更早日志。
 */
function readLogFilePage(path: string, before: number | null, limit: number): LogPage {
  const result: LogPage = {
    lines: [],
    pageStart: null,
    hasOlder: false,
    hasNewer: false,
    totalLines: 0,
    truncated: false,
  };
  try {
    const fd = openSync(path, "r");
    try {
      const stat = statSync(path);
      const size = stat.size;
      const end = before !== null ? Math.min(Math.max(0, before), size) : size;
      const start = Math.max(0, end - LOG_PAGE_MAX_BYTES);
      const bytes = end - start;
      const buffer = Buffer.alloc(bytes);
      let read = 0;
      while (read < bytes) {
        const chunk = readSync(fd, buffer, read, bytes - read, start + read);
        if (chunk <= 0) break;
        read += chunk;
      }
      const text = buffer.toString("utf8");
      const rows: Array<{ start: number; text: string }> = [];
      let index = 0;
      let lineStart = 0;
      while (index < text.length) {
        const nl = text.indexOf("\n", index);
        if (nl === -1) break;
        const raw = text.slice(index, nl);
        const content = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        rows.push({ start: start + lineStart, text: content });
        index = nl + 1;
        lineStart = index;
      }
      // 读中间段时首段是不完整行（跨页切开），丢弃；末段仅在读到文件真实末尾时保留。
      if (start > 0 && rows.length > 0) rows.shift();
      if (index < text.length && end === size) {
        rows.push({ start: start + lineStart, text: text.slice(index) });
      }
      const pageRows = rows.slice(-limit);
      result.lines = pageRows.map((row) => row.text);
      result.pageStart = pageRows.length > 0 ? pageRows[0]!.start : null;
      result.hasOlder = result.pageStart !== null && result.pageStart > 0;
      result.hasNewer = before !== null;
      result.totalLines = rows.length;
      result.truncated = rows.length > limit;
    } finally {
      closeSync(fd);
    }
  } catch (cause) {
    result.error = cause instanceof Error ? cause.message : String(cause);
  }
  return result;
}

/**
 * 为 watch 下游服务提供统一的控制面门面。
 *
 * 发现阶段（detect/capabilityScan）保持只读直连；所有会触碰实例控制面
 * 的 start/stop/restart/upgrade/snapshot/rollback 调用必须先经过
 * CapabilityRouter，避免 runbook、升级流水线或进化守门员形成旁路。
 * validateConfig 属于 config-driver 能力，单独使用对应能力位。
 */
export function createRoutedControl(core: Core, control: ControlAdapter): ControlAdapter {
  const invoke = createCapabilityInvoker(core);

  return {
    start: (instance, opts) => invoke("start", instance, "control", () => control.start(instance, opts)),
    stop: (instance, opts) => invoke("stop", instance, "control", () => control.stop(instance, opts)),
    restart: (instance) => invoke("restart", instance, "control", () => control.restart(instance)),
    upgrade: (instance, target, opts) =>
      invoke("upgrade", instance, "control", () => control.upgrade(instance, target, opts)),
    snapshot: (instance, scope) =>
      invoke("snapshot", instance, "control", () => control.snapshot(instance, scope)),
    rollback: (instance, ref) =>
      invoke("rollback", instance, "control", () => control.rollback(instance, ref)),
    validateConfig: (instance) =>
      invoke("validateConfig", instance, "config-driver", () => control.validateConfig(instance)),
  };
}

function createCapabilityInvoker(core: Core) {
  return <T>(
    method: string,
    instance: InstanceRef,
    capability: "control" | "config-driver",
    fn: () => Promise<Result<T>>,
  ): Promise<Result<T>> =>
    core.invoke(fn, { method, instance: instance.instanceId, capability });
}


export async function createWatchApp(options: WatchAppOptions = {}): Promise<WatchApp> {
  const config = loadWatchConfig({
    ...options.config,
    ...(options.home !== undefined ? { home: options.home } : {}),
  });
  const core = createCore({ home: config.home });
  const runtime = detectButlerRuntime({
    sourceDir: process.env["BUTLER_SRC"]?.trim() || process.cwd(),
    butlerDataDir: config.home,
    hermesRoot: config.hermesRoot,
    openclawRoot: config.openclawRoot,
  });
  const commandExec = options.exec ?? createRuntimeCommandExecutor(runtime);

  // 控制面复用 core 的 store/snapshotsDir，避免适配器自建第二连接。
  const adapter =
    config.framework === "openclaw"
      ? createOpenClawAdapter({
          snapshotsDir: join(core.paths.snapshotsDir, "openclaw"),
          snapshotRecorder: ({ instanceId, scope, snapshotId }) => {
            core.store.insertSnapshot({
              instance: instanceId,
              scope: { ...scope, snapshotId },
              label: scope.label,
            });
          },
          prober: options.prober,
        })
      : createHermesAdapter({
          store: core.store,
          snapshotsDir: core.paths.snapshotsDir,
          exec: commandExec,
          prober: options.prober,
          controlInvoker: createCapabilityInvoker(core),
        });
  const registered = core.registry.register(adapter);
  if (!registered.ok) {
    console.warn(
      `[butler-watch] hermes 适配器注册失败（可能已注册）: ${registered.error?.message}`,
    );
  }

  // detect + 生命周期接线：Registered → Discovering → Confirmed → Negotiating → Serving。
  const detectResult = await core.invoke(
    () =>
      adapter.discovery.detect(
      options.detectHint ??
        (config.framework === "openclaw"
          ? config.openclawRoot
            ? { rootPath: config.openclawRoot }
            : undefined
          : config.hermesRoot
            ? { rootPath: config.hermesRoot }
            : undefined),
      ),
    { method: "detect" },
  );
  const detected = detectResult.ok ? (detectResult.data ?? []) : [];
  const instances: InstanceRecord[] = [];
  for (const candidate of detected) {
    const created = core.instances.createInstance({
      instanceId: candidate.instanceId,
      frameworkId: adapter.manifest.frameworkId,
      runtime: candidate.runtime,
      rootPath: candidate.rootPath,
      version: candidate.version,
      confidence: candidate.confidence,
      evidence: candidate.evidence,
    });
    let current = created.data;
    if (!created.ok) {
      // Watch 重启时实例行会保留。先用本轮 detect 证据刷新路径/版本/置信度，
      // 再从持久化状态继续生命周期，避免上次中断在 Discovering 后永久卡住。
      const existing = core.instances.getInstance(candidate.instanceId);
      if (existing === undefined) continue;
      current = {
        ...existing,
        runtime: candidate.runtime,
        rootPath: candidate.rootPath,
        version: candidate.version,
        confidence: candidate.confidence,
        detail: { ...existing.detail, evidence: candidate.evidence },
        updatedAt: new Date().toISOString(),
      };
      core.store.saveInstance(toInstanceRow(current));
    }
    if (current === undefined || current.state === "Rejected") continue;
    if (current.state === "Registered") {
      const discovering = core.instances.beginDiscover(candidate.instanceId);
      if (!discovering.ok || discovering.data === undefined) continue;
      current = discovering.data;
    }
    if (current.state === "Discovering") {
      const confirmed = core.instances.confirmInstance(candidate.instanceId, "auto");
      if (!confirmed.ok || confirmed.data === undefined) {
        console.warn(
          `[butler-watch] 实例 ${candidate.instanceId} 置信度 ${candidate.confidence} < ${AUTO_CONFIRM_THRESHOLD}，等待人工确认`,
        );
        continue;
      }
      current = confirmed.data;
    }
    if (current.state === "Confirmed") {
      const negotiating = core.instances.beginNegotiate(candidate.instanceId);
      if (!negotiating.ok || negotiating.data === undefined) continue;
      current = negotiating.data;
    } else if (current.state === "Offline") {
      const reattached = core.instances.reattach(candidate.instanceId, "watch 重启后重新探测");
      if (!reattached.ok || reattached.data === undefined) continue;
      current = reattached.data;
    }
    if (current.state === "Serving") {
      instances.push(current);
      continue;
    }
    if (current.state !== "Negotiating" && current.state !== "Degraded") {
      console.warn(
        `[butler-watch] 实例 ${candidate.instanceId} 当前状态 ${current.state} 无法继续协商`,
      );
      continue;
    }
    const ref = {
      instanceId: candidate.instanceId,
      rootPath: candidate.rootPath,
      runtime: candidate.runtime,
    };
    const scan = await core.invoke(() => adapter.discovery.capabilityScan(ref), {
      method: "capabilityScan",
      instance: candidate.instanceId,
    });
    const report = scan.ok ? scan.data : undefined;
    const serving = core.instances.markServing(
      candidate.instanceId,
      report?.effectiveLevel ?? 0,
      report,
    );
    if (serving.ok && serving.data !== undefined) instances.push(serving.data);
  }

  // LogTailer + 日志源注册（sourceId → instanceId 映射供 ingest 归属）。
  const tailer = new LogTailer({ store: core.store, bus: core.bus });
  const sourceOwners = new Map<string, string>();
  function refreshLogSources(): void {
    for (const record of core.instances.listInstances()) {
      if (record.rootPath === "") continue;
      const sources = adapter.discovery.logSources({
        instanceId: record.instanceId,
        rootPath: record.rootPath,
        runtime: record.runtime,
      });
      tailer.registerSources(sources); // 同 id 后注册者生效，幂等
      for (const source of sources) sourceOwners.set(source.id, record.instanceId);
    }
  }
  refreshLogSources();

  // FingerprintEngine：tail 出的错误行按窗口聚合。
  const engine = new FingerprintEngine({
    store: core.store,
    bus: core.bus,
    windowMs: config.fingerprintWindowMs,
  });
  async function handleTailBatch(batch: TailedBatch): Promise<void> {
    const instanceId = sourceOwners.get(batch.source.id);
    for (const line of batch.lines) {
      engine.ingest(line, instanceId); // handler 成功返回后 LogTailer 才提交位点
    }
  }
  const pollTail = (): Promise<void> => tailer.poll(handleTailBatch);

  // tail 轮询循环：interval 驱动（tick 失败只 warn，下轮重读 at-least-once）。
  const driver = options.timerDriver ?? defaultTimerDriver;
  let tailHandle: unknown;
  async function tailTick(): Promise<void> {
    try {
      await pollTail();
    } catch (error) {
      console.warn("[butler-watch] tail 轮询失败（位点未推进，下轮重读）:", error);
    }
  }

  // 按需记忆自检专用探针：召回通过后立即删除本次测试行，不污染记忆库统计。
  const memorySelfCheckStage = createMemoryProbeStage({
    open: options.sqlite,
    now: options.now,
    removeOwn: true,
  });

  // 巡检：内置七阶段（Task 6 三探针 + 停写检测，全注入）+ extraStages 插入点。
  const stages = [
    ...createDefaultStages({
      exec: commandExec,
      prober: options.prober,
      sampler: options.sampler,
      probeTimeoutMs: config.probeTimeoutMs,
      memoryWarnBytes: config.memoryWarnBytes,
      cpuWarnPercent: config.cpuWarnPercent,
      sqlite: options.sqlite,
      fetchFn: options.fetchFn,
      channelDryRun: config.channelDryRun,
      llmEnv: config.llm,
      stallWriteThresholdMs: config.stallWriteThresholdMs,
      logMtimeSampler: options.logMtimeSampler,
      now: options.now,
    }),
    ...(options.extraStages ?? []),
  ];

  // Task 7：公共告警 POST 器 + 已接线熔断器 + runbook 执行器（复用 hermes control）。
  // createHermesAdapter 恒返回 control（AdapterBundle 类型按能力位可选，此处收窄）。
  const control = adapter.control!;
  const routedControl = createRoutedControl(core, control);
  // 配置校验是适配器 config-driver 的统一入口：所有调用方都经过能力路由、纪律超时与结果记录。
  const validateConfigViaCore = (instance: InstanceRef) => routedControl.validateConfig(instance);
  const alertPoster = createAlertPoster({
    gatewayUrl: config.gatewayUrl,
    fetchFn: options.fetchFn,
    timeoutMs: config.fetchTimeoutMs,
    audit: core.audit,
  });
  const initialBreakerTrips = core.store
    .listEvents({ type: "circuit-breaker-tripped", limit: 1000 })
    .map((event) => {
      const payload = event.payload as Record<string, unknown>;
      if (
        typeof payload["key"] !== "string" ||
        typeof payload["failures"] !== "number" ||
        typeof payload["windowMs"] !== "number" ||
        typeof payload["reason"] !== "string"
      ) {
        return null;
      }
      return {
        key: payload["key"],
        failures: payload["failures"],
        windowMs: payload["windowMs"],
        reason: payload["reason"],
      };
    })
    .filter((trip): trip is {
      key: string;
      failures: number;
      windowMs: number;
      reason: string;
    } => trip !== null)
    // events 倒序返回；同一 key 只恢复最近一次跳闸事实。
    .filter((trip, index, all) => all.findIndex((item) => item.key === trip.key) === index);
  const breaker = createWiredBreaker(
    { windowMs: 10 * 60 * 1000, threshold: 5, now: options.now },
    {
      bus: core.bus,
      poster: alertPoster,
      audit: core.audit,
      now: options.now,
      initialTrips: initialBreakerTrips,
    },
  );
  const runbookExecutor = new RunbookExecutor(
    {
      core,
      control: routedControl,
      stages,
      breaker,
      poster: alertPoster,
      exec: commandExec,
      debounceMs: config.runbookDebounceMs,
      now: options.now,
    },
    createBuiltinRunbooks({ control: routedControl, exec: commandExec }),
  );

  // Task 15：共享补丁管理器（升级流水线与网关参数面板同一实例，同一 state.json）。
  const patchManager = createPatchManager({ patchesDir: join(core.paths.home, "patches") });

  // Task 13：升级服务（hermes 升级流水线接线 + 审计 + 完成通知冷却合并 +
  // 熔断联动 + 快照回滚）。复用与 runbook 同一 control 门面/熔断器/告警 POST 器。
  const upgrade = createUpgradeService({
    core,
    control: routedControl,
    stages,
    poster: alertPoster,
    breaker,
    fetchFn: options.fetchFn,
    exec: commandExec,
    now: options.now,
    patchManager,
    versionRepo: config.versionRepo,
    versionDockerImage: config.versionDockerImage,
    versionMirrorHost: config.versionMirrorHost,
    pipPackage: config.upgradePipPackage,
    dockerImage: config.versionDockerImage,
    notifyCooldownMs: config.upgradeNotifyCooldownMs,
  });

  // Task 15：网关限流统计 + 补丁参数面板服务（限流指纹画像建议与补丁
  // apply/reapply/detect 入口；HTTP /api/gateway/*）。
  const gateway = createGatewayService({
    core,
    patchManager,
    validateConfig: validateConfigViaCore,
    now: options.now,
  });

  // Task 16：只负责进化前后守门，不在 Butler 内执行优化引擎或直接写技能产物。
  const evolution = createEvolutionService({
    core,
    control: routedControl,
    exec: commandExec,
    fetchFn: options.fetchFn,
    poster: alertPoster,
    defaultEndpoint: config.llm.baseUrl,
    llm: config.llm,
    hermesRoot: runtime.hermesRoot,
    evolutionRoot: posix.join(runtime.hermesRoot, "skills", "hermes-agent-self-evolution"),
    runRoot: config.evolutionRunRoot ?? posix.join(runtime.butlerDataDir.replaceAll("\\", "/"), "evolution-runs"),
    // Windows 宿主经 wsl.exe；Docker-in-WSL 与原生 Linux 容器可直接访问挂载的 Hermes 路径。
    useWsl:
      runtime.kind === "windows-wsl" ||
      runtime.kind === "wsl" ||
      (runtime.kind === "linux" && config.hermesRoot !== undefined),
    fetchTimeoutMs: config.fetchTimeoutMs,
    now: options.now,
  });

  // Task 17：I-4 只读驱动聚合。格式不匹配由服务降级为有界目录统计，
  // 不暴露任何启停、归档、删除或写入入口。
  const skills = createSkillsMemoryService({
    core,
    skillDriver: adapter.drivers?.skill,
    pluginDriver: adapter.drivers?.plugin,
    memoryDriver: adapter.drivers?.memory,
    stallThresholdMin: Math.max(1, Math.round(config.stallWriteThresholdMs / 60_000)),
    now: options.now,
    snapshotBeforeWrite: async (label: string) => {
      // PRD M6：所有记忆写动作执行前必须完成事件备份；异常由服务层
      // fail-closed 转换为 snapshot-failed，禁止继续调用写驱动。
      await backup.run("event", label);
    },
  });

  // Task 18：备份服务（每日全量 + 每小时记忆增量 + 事件触发 + 还原）。
  // 备份/安全以实际检出的实例根目录为准（检测结果优先）。
  const managedRoot =
    core.instances
      .listInstances()
      .map((item) => item.rootPath)
      .find((item) => item !== "") ??
      (config.framework === "openclaw" ? config.openclawRoot : config.hermesRoot) ??
      "";
  const backup = createBackupService({
    core,
    hermesRoot: managedRoot,
    now: options.now,
    driver,
  });

  // Task 18：安全基线（三条配置不变式 + 密钥文件 0600 扫描）。
  const security = createSecurityService({
    hermesRoot: managedRoot,
    gateway,
    now: options.now,
    onInvariantChange: async (view) => {
      const failed = view.invariants.filter((item) => item.status === "fail");
      core.audit.append({
        actor: "security",
        action: "config-invariants-revalidated",
        target: managedRoot,
        detail: { checkedAt: view.checkedAt, invariants: view.invariants },
      });
      if (failed.length > 0) {
        await alertPoster.post({
          kind: "config-invariant",
          severity: "critical",
          title: "配置安全规则未通过",
          body: failed.map((item) => `${item.title}：${item.detail}`).join("；"),
          source: "butler-watch",
          dedupeKey: `config-invariant:${failed.map((item) => item.id).join(",")}`,
        });
      }
    },
  });

  // Task 18：升级/进化前事件备份。升级必须等待备份成功，进化预检同样 fail-closed。
  const upgradeWithBackup: UpgradeService = {
    ...upgrade,
    async startUpgrade(input) {
      try {
        const snapshot = await backup.run("event", "升级前自动备份");
        if (!Number.isInteger(snapshot.id) || snapshot.id <= 0) {
          return { status: "backup-failed", error: "升级前备份未返回有效登记 ID" };
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        core.audit.append({
          actor: "upgrade",
          action: "upgrade-prebackup-failed",
          target: "",
          detail: { error: detail },
        });
        return { status: "backup-failed", error: detail };
      }
      return await upgrade.startUpgrade(input);
    },
  };
  const evolutionWithBackup = withEvolutionBackup(evolution, backup, core);

    // M5 切片 1/2：只登记服务端已知 Hermes 提示词路径，候选/评估写入 BUTLER_HOME 本地。
  const promptOptimization = createPromptOptimizationService({
    core,
    hermesRoot: config.framework === "openclaw" ? config.openclawRoot : config.hermesRoot,
    now: options.now,
  });

  // M1 独立关键记忆探针：与整轮巡检分离，探针行即时清理，避免高频巡检污染用户记忆。
  async function runCriticalMemoryProbe(): Promise<{ status: "pass" | "warn" | "fail" | "skipped"; detail?: string }> {
    const targets = core.instances
      .listInstances()
      .filter((record) => ["Serving", "Degraded", "Offline"].includes(record.state));
    if (targets.length === 0) {
      return { status: "skipped", detail: "没有可运行关键记忆探针的实例" };
    }
    const outcomes: Array<{ instanceId: string; status: "pass" | "warn" | "fail" | "skipped"; detail: string }> = [];
    for (const record of targets) {
      let result: { status: "pass" | "warn" | "fail" | "skipped"; detail?: string };
      try {
        result = await memorySelfCheckStage.run({
          instanceId: record.instanceId,
          frameworkId: record.frameworkId,
          rootPath: record.rootPath,
          runtime: record.runtime,
          shared: {},
        });
      } catch (error) {
        result = {
          status: "fail",
          detail: error instanceof Error ? `关键探针异常: ${error.message}` : `关键探针异常: ${String(error)}`,
        };
      }
      const detail = result.detail ?? "";
      const observedAt = new Date((options.now ?? Date.now)()).toISOString();
      outcomes.push({ instanceId: record.instanceId, status: result.status, detail });
      core.audit.append({
        actor: "butler-watch",
        action: "critical-memory-probe",
        target: record.instanceId,
        detail: { status: result.status, detail, observedAt, source: "independent-sla-scheduler" },
      });
      if (result.status === "fail") {
        const alertQueuedAt = new Date((options.now ?? Date.now)()).toISOString();
        void alertPoster.post({
          kind: "critical-memory-probe",
          severity: "critical",
          title: "记忆系统关键探针失败",
          body: `实例 ${record.instanceId} 的记忆写入/召回探针失败：${detail || "无详情"}。管家将尝试自动修复。`,
          source: "butler-watch",
          dedupeKey: `critical-memory-probe:${record.instanceId}`,
        });
        core.audit.append({
          actor: "butler-watch",
          action: "critical-memory-alert-queued",
          target: record.instanceId,
          detail: { observedAt, alertQueuedAt, source: "independent-sla-scheduler" },
        });
      }
      if (result.status === "fail" && config.runbookAuto && record.rootPath !== "") {
        try {
          const remediationStartedAt = new Date((options.now ?? Date.now)()).toISOString();
          const trigger = await runbookExecutor.autoTrigger(
            RB_RESTART,
            { instanceId: record.instanceId, rootPath: record.rootPath, runtime: record.runtime },
            `关键记忆探针 fail（${detail || "无详情"}）`,
          );
          const remediationFinishedAt = new Date((options.now ?? Date.now)()).toISOString();
          core.audit.append({
            actor: "butler-watch",
            action: "critical-memory-remediation",
            target: record.instanceId,
            detail: {
              runbookId: RB_RESTART,
              triggerStatus: trigger.skipped ? `skipped:${trigger.reason}` : "started",
              remediationStartedAt,
              remediationFinishedAt,
              source: "independent-sla-scheduler",
            },
          });
        } catch (error) {
          const remediationFinishedAt = new Date((options.now ?? Date.now)()).toISOString();
          core.audit.append({
            actor: "butler-watch",
            action: "critical-memory-remediation",
            target: record.instanceId,
            detail: {
              runbookId: RB_RESTART,
              triggerStatus: "error",
              error: error instanceof Error ? error.message : String(error),
              remediationFinishedAt,
              source: "independent-sla-scheduler",
            },
          });
        }
      }
    }
    const statuses = outcomes.map((item) => item.status);
    const status = statuses.includes("fail")
      ? "fail"
      : statuses.includes("warn")
        ? "warn"
        : statuses.every((item) => item === "skipped")
          ? "skipped"
          : "pass";
    return {
      status,
      detail: outcomes.map((item) => `${item.instanceId}: ${item.status}${item.detail ? ` (${item.detail})` : ""}`).join("; "),
    };
  }

  const criticalScheduler = new CriticalProbeScheduler({
    intervalMs: config.criticalProbeIntervalMin * 60_000,
    slaMs: CRITICAL_PROBE_SLA_MIN * 60_000,
    run: runCriticalMemoryProbe,
    driver,
    now: options.now,
    onResult: (result: CriticalProbeResult) => {
      core.audit.append({
        actor: "butler-watch",
        action: "critical-probe-sla",
        target: "",
        detail: {
          status: result.status,
          detail: result.detail ?? "",
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
          deadlineAt: result.deadlineAt,
          durationMs: result.durationMs,
          withinSla: result.withinSla,
          source: "independent-sla-scheduler",
        },
      });
    },
  });

  // Task 7 自动触发规则：memory-probe fail → rb-restart；channel-probe fail →
  // rb-reconnect；process-alive fail → rb-restart（去重；熔断/防抖由 executor 判定）。
  async function handleInspectionCompleted(payload: InspectionCompletedPayload): Promise<void> {
    if (!config.runbookAuto) return;
    const record = core.instances.getInstance(payload.instanceId);
    if (record === undefined || record.rootPath === "") return;
    const ref: InstanceRef = {
      instanceId: record.instanceId,
      rootPath: record.rootPath,
      runtime: record.runtime,
    };
    const failed = (checkId: string): boolean =>
      payload.checks.some((c) => c.id === checkId && c.status === "fail");
    const targets = new Set<string>();
    if (failed("memory-probe") || failed("process-alive")) targets.add(RB_RESTART);
    if (failed("channel-probe")) targets.add(RB_RECONNECT);
    for (const runbookId of targets) {
      const trigger = [...payload.checks].find(
        (c) =>
          c.status === "fail" &&
          ((runbookId === RB_RESTART && (c.id === "memory-probe" || c.id === "process-alive")) ||
            (runbookId === RB_RECONNECT && c.id === "channel-probe")),
      );
      await runbookExecutor.autoTrigger(
        runbookId,
        ref,
        `巡检 ${trigger?.id ?? "?"} fail（${payload.overall}）`,
      );
    }
  }

  const runInspection = createInspectionRunner({
    core,
    config,
    stages,
    fetchFn: options.fetchFn,
    afterInspection: refreshLogSources,
    onInspection: handleInspectionCompleted,
  });
  const scheduler = new InspectionScheduler({
    intervalMs: config.inspectIntervalMin * 60_000,
    run: runInspection,
    driver,
    criticalStatus: () => criticalScheduler.status(),
  });

  // 告警转发订阅。
  const forwarder = startAlertForwarder({
    bus: core.bus,
    audit: core.audit,
    gatewayUrl: config.gatewayUrl,
    fetchFn: options.fetchFn,
    timeoutMs: config.fetchTimeoutMs,
  });

  // Task 10 前置：HTTP 控制通道（127.0.0.1:7533，可配）。挂 scheduler /
  // runbookExecutor / breaker / instances 状态；执行判定（实例解析 + 熔断检查）
  // 在此接线，HTTP 层只做状态码映射。
  function runbookSummaries(): RunbookSummary[] {
    const trippedKeys = breaker.trippedKeys();
    return runbookExecutor.listRunbooks().map((def) => ({
      id: def.id,
      label: def.label,
      description: def.description ?? "",
      impact: def.impact ?? "",
      steps: def.steps.map((step) => step.label),
      breakerTripped: trippedKeys.some((key) => key.startsWith(`${def.id}:`)),
      lastRun: runbookExecutor.lastRunOf(def.id),
    }));
  }

  async function executeRunbookViaHttp(
    id: string,
    instanceId?: string,
  ): Promise<RunbookExecuteOutcome> {
    if (!runbookExecutor.listRunbooks().some((def) => def.id === id)) {
      return { status: "unknown-runbook" };
    }
    const record =
      instanceId !== undefined
        ? core.instances.getInstance(instanceId)
        : core.instances.listInstances().find((r) => r.state === "Serving");
    if (record === undefined || record.state !== "Serving" || record.rootPath === "") {
      return { status: "no-servicing-instance" };
    }
    if (breaker.isTripped(`${id}:${record.instanceId}`)) {
      return { status: "circuit-breaker-tripped" };
    }
    const ref: InstanceRef = {
      instanceId: record.instanceId,
      rootPath: record.rootPath,
      runtime: record.runtime,
    };
    void runbookExecutor.runRunbook(id, {
      trigger: "manual",
      reason: "HTTP 手动触发",
      instance: ref,
    });
    return { status: "started", instanceId: record.instanceId };
  }

  async function resetRunbookBreakerViaHttp(
    id: string,
    instanceId?: string,
  ): Promise<RunbookResetOutcome> {
    if (!runbookExecutor.listRunbooks().some((def) => def.id === id)) {
      return { status: "unknown-runbook" };
    }
    const prefix = `${id}:`;
    const keys = breaker
      .trippedKeys()
      .filter((key) => key.startsWith(prefix) && (instanceId === undefined || key === `${prefix}${instanceId}`));
    if (keys.length === 0) return { status: "not-tripped" };
    for (const key of keys) {
      const trip = breaker.tripInfo(key);
      breaker.reset(key);
      core.audit.append({
        actor: "butler-watch",
        action: "circuit-breaker-reset",
        target: key,
        detail: {
          runbookId: id,
          instanceId: key.slice(prefix.length),
          previousTrip: trip ?? null,
          source: "settings",
        },
      });
    }
    return { status: "reset", keys };
  }

  function resolveInstance(instanceId?: string): InstanceRecord | undefined {
    if (instanceId !== undefined && instanceId.trim() !== "") {
      return core.instances.getInstance(instanceId.trim());
    }
    return core.instances
      .listInstances()
      .find((record) => record.state === "Serving" && record.rootPath !== "");
  }

  /**
   * 连接管理状态：与巡检结果分开保存最近一次主动探测/动作，
   * 让面板可以区分“尚未检查”“已连接但待复核”和“刚刚断开”。
   */
  type ConnectionMemory = {
    busy: boolean;
    lastCheckedAt: string | null;
    lastActionAt: string | null;
    lastAction: "check" | "connect" | "disconnect" | null;
    lastProbeOk: boolean | null;
    latencyMs: number | null;
    lastError: string | null;
    checks: Array<{ id: string; label: string; status: "pass" | "warn" | "fail"; detail: string; durationMs: number | null }>;
    capabilities: Record<string, string>;
    anomalies: string[];
  };

  const connectionMemory = new Map<string, ConnectionMemory>();
  const connectionMemoryFor = (instanceId: string): ConnectionMemory => {
    const existing = connectionMemory.get(instanceId);
    if (existing !== undefined) return existing;
    const created: ConnectionMemory = {
      busy: false,
      lastCheckedAt: null,
      lastActionAt: null,
      lastAction: null,
      lastProbeOk: null,
      latencyMs: null,
      lastError: null,
      checks: [],
      capabilities: {},
      anomalies: [],
    };
    connectionMemory.set(instanceId, created);
    return created;
  };

  const connectionCapabilityLabels: Record<string, string> = {
    probe: "服务响应",
    control: "启停控制",
    messaging: "消息通道",
    "skill-driver": "技能目录",
    "memory-driver": "记忆读写",
    "config-driver": "配置校验",
  };

  function connectionView(record: InstanceRecord): Record<string, unknown> {
    const memory = connectionMemoryFor(record.instanceId);
    const connected =
      memory.lastProbeOk === true ||
      (memory.lastProbeOk === null && (record.state === "Serving" || record.state === "Degraded"));
    const connectionState = memory.busy
      ? "checking"
      : memory.lastError !== null
        ? "error"
        : connected
          ? "connected"
          : memory.lastProbeOk === false || record.state === "Offline"
            ? "disconnected"
            : "unknown";
    return {
      instanceId: record.instanceId,
      frameworkId: record.frameworkId,
      displayName: adapter.manifest.displayName,
      state: record.state,
      connectionState,
      connected,
      runtime: record.runtime,
      rootPath: record.rootPath,
      version: record.version,
      confidence: record.confidence,
      effectiveLevel: record.capability?.effectiveLevel ?? null,
      capabilities: memory.capabilities,
      checks: memory.checks,
      anomalies: memory.anomalies,
      lastCheckedAt: memory.lastCheckedAt,
      lastActionAt: memory.lastActionAt,
      lastAction: memory.lastAction,
      latencyMs: memory.latencyMs,
      lastError: memory.lastError,
    };
  }

  function checksFromReport(report: NonNullable<InstanceRecord["capability"]>, durationMs: number) {
    const checks: ConnectionMemory["checks"] = [];
    for (const [id, value] of Object.entries(report.capabilities)) {
      const status: "pass" | "warn" | "fail" =
        value === "ok" ? "pass" : id === "probe" || value === "not-implemented" ? "fail" : "warn";
      checks.push({
        id,
        label: connectionCapabilityLabels[id] ?? id,
        status,
        detail:
          value === "ok"
            ? "可用"
            : value === "not-implemented"
              ? "当前适配器未提供"
              : value === "unavailable"
                ? "当前不可用"
                : "已降级",
        durationMs,
      });
    }
    for (const anomaly of report.anomalies) {
      checks.push({ id: `anomaly-${checks.length}`, label: "额外提示", status: "warn", detail: anomaly, durationMs: null });
    }
    return checks;
  }

  async function checkConnection(instanceId?: string, promote = false): Promise<
    | { status: "checked"; connection: Record<string, unknown> }
    | { status: "no-instance" }
    | { status: "failed"; connection: Record<string, unknown> }
  > {
    const record = resolveInstance(instanceId);
    if (record === undefined || record.rootPath === "") return { status: "no-instance" };
    const memory = connectionMemoryFor(record.instanceId);
    memory.busy = true;
    memory.lastAction = "check";
    memory.lastActionAt = new Date().toISOString();
    memory.lastError = null;
    const ref: InstanceRef = { instanceId: record.instanceId, rootPath: record.rootPath, runtime: record.runtime };
    const result = await core.invoke(() => adapter.discovery.capabilityScan(ref), {
      method: "capabilityScan",
      instance: record.instanceId,
    });
    memory.busy = false;
    memory.lastCheckedAt = new Date().toISOString();
    memory.latencyMs = result.durationMs;
    if (!result.ok || result.data === undefined) {
      memory.lastProbeOk = false;
      memory.checks = [];
      memory.capabilities = {};
      memory.anomalies = [];
      memory.lastError = result.error?.userHint ?? result.error?.message ?? "连接检查失败";
      return { status: "failed", connection: connectionView(core.instances.getInstance(record.instanceId) ?? record) };
    }
    const report = result.data;
    memory.lastProbeOk = report.capabilities["probe"] === "ok";
    memory.capabilities = report.capabilities;
    memory.anomalies = report.anomalies;
    memory.checks = checksFromReport(report, result.durationMs);
    memory.lastError = null;
    const latest = core.instances.getInstance(record.instanceId) ?? record;
    core.store.saveInstance(toInstanceRow({ ...latest, capability: report, updatedAt: new Date().toISOString() }));
    if (promote) {
      const refreshed = core.instances.getInstance(record.instanceId);
      if (refreshed?.state === "Offline") {
        core.instances.reattach(record.instanceId, "手动连接后重新接入");
      }
      const afterReattach = core.instances.getInstance(record.instanceId);
      if (afterReattach?.state === "Negotiating" || afterReattach?.state === "Degraded") {
        core.instances.markServing(record.instanceId, report.effectiveLevel, report);
      }
    }
    const viewRecord = core.instances.getInstance(record.instanceId) ?? record;
    return memory.lastProbeOk ? { status: "checked", connection: connectionView(viewRecord) } : { status: "failed", connection: connectionView(viewRecord) };
  }

  async function runConnectionAction(
    instanceId: string | undefined,
    action: "connect" | "disconnect",
  ): Promise<
    | { status: "connected" | "disconnected"; connection: Record<string, unknown> }
    | { status: "no-instance" }
    | { status: "failed"; connection: Record<string, unknown> }
  > {
    const record = resolveInstance(instanceId);
    if (record === undefined || record.rootPath === "") return { status: "no-instance" };
    if (action === "connect") {
      const checked = await checkConnection(record.instanceId);
      // 探测到端口不可达正是“连接服务”常见的前置状态；只有探测本身报错时才阻断启停。
      if (checked.status === "failed" && connectionMemoryFor(record.instanceId).lastError !== null) {
        return checked;
      }
    }
    const memory = connectionMemoryFor(record.instanceId);
    memory.busy = true;
    memory.lastAction = action;
    memory.lastActionAt = new Date().toISOString();
    memory.lastError = null;
    const ref: InstanceRef = { instanceId: record.instanceId, rootPath: record.rootPath, runtime: record.runtime };
    const result = action === "connect" ? await routedControl.start(ref) : await routedControl.stop(ref);
    memory.busy = false;
    if (!result.ok) {
      memory.lastError = result.error?.userHint ?? result.error?.message ?? `${action === "connect" ? "连接" : "断开"}失败`;
      return { status: "failed", connection: connectionView(core.instances.getInstance(record.instanceId) ?? record) };
    }
    if (action === "disconnect") {
      const current = core.instances.getInstance(record.instanceId);
      if (current?.state === "Serving" || current?.state === "Degraded") {
        core.instances.markOffline(record.instanceId, "用户手动断开");
      }
      await checkConnection(record.instanceId);
      const viewRecord = core.instances.getInstance(record.instanceId) ?? record;
      return { status: "disconnected", connection: connectionView(viewRecord) };
    }
    const checked = await checkConnection(record.instanceId, true);
    if (checked.status === "failed") return checked;
    const viewRecord = core.instances.getInstance(record.instanceId) ?? record;
    return { status: "connected", connection: connectionView(viewRecord) };
  }

  const connections: WatchHttpDeps["connections"] = {
    status: () => ({
      checkedAt: new Date().toISOString(),
      connections: core.instances.listInstances().map(connectionView),
    }),
    check: (instanceId) => checkConnection(instanceId),
    connect: (instanceId) => runConnectionAction(instanceId, "connect"),
    disconnect: (instanceId) => runConnectionAction(instanceId, "disconnect"),
  };

  type InstallStep = { id: string; label: string; status: "pending" | "running" | "passed" | "failed" | "cancelled"; detail?: string; startedAt?: string; finishedAt?: string };
  type InstallJob = { jobId: string; status: "queued" | "running" | "done" | "failed" | "cancelled"; progress: number; currentStep: string | null; steps: InstallStep[]; logTail: string[]; error: string | null; startedAt: string; finishedAt: string | null; cancelRequested?: boolean };
  const installStatePath = join(config.home, "openclaw-install.json");
  mkdirSync(config.home, { recursive: true });
  let openclawInstallJob: InstallJob | null = (() => {
    try {
      const parsed = JSON.parse(readFileSync(installStatePath, "utf8")) as InstallJob;
      return typeof parsed.jobId === "string" ? parsed : null;
    } catch {
      return null;
    }
  })();
  if (openclawInstallJob !== null && (openclawInstallJob.status === "queued" || openclawInstallJob.status === "running")) {
    openclawInstallJob.status = "failed";
    openclawInstallJob.error = "管家重启时安装任务被中断，请重新检查环境后重试";
    openclawInstallJob.finishedAt = new Date().toISOString();
    openclawInstallJob.currentStep = null;
    writeFileSync(installStatePath, JSON.stringify(openclawInstallJob, null, 2), "utf8");
  }
  let openclawInstallBusy = openclawInstallJob?.status === "queued" || openclawInstallJob?.status === "running";
  let openclawInstallState: { installed: boolean; version: string | null; rootPath: string | null; detail: string; busy: boolean } = {
    installed: false,
    version: null,
    rootPath: runtime.openclawRoot,
    detail: "尚未检测到 OpenClaw 安装目录",
    busy: openclawInstallBusy,
  };
  let openclawProbeBusy = false;
  const probeOpenClaw = async (): Promise<void> => {
    if (openclawProbeBusy) return;
    openclawProbeBusy = true;
    try {
      const npmRoot = await commandExec.exec("npm", ["root", "-g"], { timeoutMs: 10_000 });
      const resolvedNpmRoot = npmRoot.code === 0 ? npmRoot.stdout.trim() : null;
      if (resolvedNpmRoot !== null && resolvedNpmRoot !== "") runtime.npmGlobalRoot = resolvedNpmRoot;
      const versionResult = await commandExec.exec("openclaw", ["--version"], { timeoutMs: 10_000 });
      const version = versionResult.code === 0 ? versionResult.stdout.trim().split(/\s+/)[0] ?? null : null;
      const installed = version !== null && version !== "";
      openclawInstallState = {
        ...openclawInstallState,
        installed,
        version,
        rootPath: runtime.openclawRoot,
        busy: openclawInstallBusy,
        detail: openclawInstallState.installed ? "已发现 OpenClaw，可继续检查连接" : "未检测到 WSL 内 OpenClaw 命令或安装包",
      };
    } finally {
      openclawProbeBusy = false;
    }
  };
  void probeOpenClaw();
  const installStepDefs = [
    ["runtime", "检测 WSL 运行环境"],
    ["paths", "解析用户、目录和 npm 全局路径"],
    ["npm-install", "安装 OpenClaw npm 包"],
    ["setup", "初始化 OpenClaw 基线目录"],
    ["version", "读取并校验 OpenClaw 版本"],
    ["gateway-start", "启动 OpenClaw Gateway"],
    ["health", "检查 Gateway 健康状态"],
    ["verify", "重新探测连接"],
  ] as const;
  const persistInstallJob = () => {
    if (openclawInstallJob !== null) writeFileSync(installStatePath, JSON.stringify(openclawInstallJob, null, 2), "utf8");
  };
  const appendInstallLog = (line: string) => {
    if (openclawInstallJob === null) return;
    openclawInstallJob.logTail = [...openclawInstallJob.logTail, line].slice(-80);
    persistInstallJob();
  };
  const updateInstallStep = (id: string, status: InstallStep["status"], detail?: string) => {
    if (openclawInstallJob === null) return;
    const now = new Date().toISOString();
    openclawInstallJob.steps = openclawInstallJob.steps.map((step) => step.id === id ? { ...step, status, ...(detail === undefined ? {} : { detail }), ...(status === "running" ? { startedAt: now } : { finishedAt: now }) } : step);
    const passed = openclawInstallJob.steps.filter((step) => step.status === "passed").length;
    openclawInstallJob.progress = Math.round((passed / openclawInstallJob.steps.length) * 100);
    openclawInstallJob.currentStep = status === "running" ? id : openclawInstallJob.currentStep;
    persistInstallJob();
  };
  const openclawInstall: NonNullable<WatchHttpDeps["openclawInstall"]> = {
    status: () => {
      const root = runtime.openclawRoot;
      return {
        ...openclawInstallState,
        installed: openclawInstallState.installed,
        version: openclawInstallState.version,
        rootPath: root,
        busy: openclawInstallBusy,
        detail: openclawInstallState.installed ? "已发现 OpenClaw，可继续检查连接" : "未检测到 WSL 内 OpenClaw 命令或安装包",
        runtime,
        target: { dataRoot: root, npmGlobalRoot: runtime.npmGlobalRoot },
        job: openclawInstallJob,
      };
    },
    install: async () => {
      if (openclawInstallBusy) return { status: "busy" };
      const current = openclawInstall.status() as { installed: boolean; version: string | null; rootPath: string | null; detail: string; busy: boolean };
      if (current.installed) return { status: "already-installed", detail: String(current.detail) };
      const jobId = `openclaw-install-${randomUUID()}`;
      openclawInstallBusy = true;
      openclawInstallState = { installed: current.installed, version: current.version, rootPath: current.rootPath, busy: true, detail: "正在提交 OpenClaw 安装任务" };
      openclawInstallJob = { jobId, status: "queued", progress: 0, currentStep: null, steps: installStepDefs.map(([id, label]) => ({ id, label, status: "pending" })), logTail: [], error: null, startedAt: new Date().toISOString(), finishedAt: null };
      persistInstallJob();
      core.audit.append({ actor: "openclaw-installer", action: "openclaw-install-start", target: "openclaw", detail: { jobId, rootPath: current.rootPath ?? "" } });
      void (async () => {
        if (openclawInstallJob === null) return;
        openclawInstallJob.status = "running"; persistInstallJob();
        const run = async (id: string, cmd: string, args: string[], timeoutMs: number) => {
          if (openclawInstallJob?.cancelRequested) throw new Error("安装任务已取消");
          updateInstallStep(id, "running");
          const result = await commandExec.exec(cmd, args, { timeoutMs });
          appendInstallLog(`${cmd} ${args.join(" ")} → ${result.code}`);
          if (result.code !== 0) { updateInstallStep(id, "failed", result.stderr.trim() || `${cmd} 执行失败`); throw new Error(result.stderr.trim() || `${cmd} 执行失败`); }
          updateInstallStep(id, "passed", result.stdout.trim().slice(-400));
          return result;
        };
        let installedVersion: string | null = null;
        try {
          updateInstallStep("runtime", "running");
          if (runtime.kind !== "wsl" && runtime.kind !== "windows-wsl") throw new Error("当前不是可用的 WSL 运行环境");
          updateInstallStep("runtime", "passed", runtime.detail);
          await run("paths", "npm", ["root", "-g"], 30_000);
          const install = await run("npm-install", "npm", ["install", "--global", "openclaw"], 600_000);
          void install;
          await run("setup", "openclaw", ["setup", "--baseline"], 120_000);
          const versionResult = await run("version", "openclaw", ["--version"], 30_000);
          installedVersion = versionResult.stdout.trim().split(/\s+/)[0] || null;
          updateInstallStep("gateway-start", "running");
          commandExec.spawnDetached("openclaw", ["gateway", "run"]);
          appendInstallLog("openclaw gateway run → detached");
          updateInstallStep("gateway-start", "passed", "Gateway 启动命令已提交");
          updateInstallStep("health", "running");
          let healthy = false;
          let healthDetail = "Gateway 健康检查未通过";
          for (let attempt = 1; attempt <= 10; attempt += 1) {
            if (openclawInstallJob?.cancelRequested) throw new Error("安装任务已取消");
            const health = await commandExec.exec("openclaw", ["gateway", "health", "--json"], { timeoutMs: 10_000 });
            appendInstallLog(`openclaw gateway health --json（第 ${attempt} 次）→ ${health.code}`);
            if (health.code === 0) {
              healthy = true;
              healthDetail = health.stdout.trim().slice(-400);
              break;
            }
            healthDetail = health.stderr.trim() || health.stdout.trim() || healthDetail;
            await new Promise((resolve) => setTimeout(resolve, 2_000));
          }
          if (!healthy) {
            updateInstallStep("health", "failed", healthDetail);
            throw new Error(`Gateway 健康检查失败：${healthDetail}`);
          }
          updateInstallStep("health", "passed", healthDetail);
          await run("verify", "openclaw", ["gateway", "health", "--json"], 60_000);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          if (openclawInstallJob?.cancelRequested) openclawInstallJob.status = "cancelled";
          else openclawInstallJob!.status = "failed";
          openclawInstallJob!.error = detail; openclawInstallJob!.finishedAt = new Date().toISOString(); persistInstallJob();
          openclawInstallState = { ...openclawInstallState, detail, busy: false };
          openclawInstallBusy = false;
          core.audit.append({ actor: "openclaw-installer", action: "openclaw-install-failed", target: "openclaw", detail: { jobId, error: detail } });
          return;
        }
        openclawInstallState = {
          installed: true,
          version: installedVersion,
          rootPath: runtime.openclawRoot,
          detail: "OpenClaw 已安装，等待连接探测",
          busy: false,
        };
        openclawInstallJob!.status = "done"; openclawInstallJob!.progress = 100; openclawInstallJob!.currentStep = null; openclawInstallJob!.finishedAt = new Date().toISOString(); persistInstallJob();
        openclawInstallBusy = false;
        core.audit.append({ actor: "openclaw-installer", action: "openclaw-install-done", target: "openclaw", detail: { jobId, version: installedVersion } });
      })().catch((error) => {
        openclawInstallState = { ...openclawInstallState, detail: error instanceof Error ? error.message : String(error) };
        openclawInstallBusy = false;
        core.audit.append({ actor: "openclaw-installer", action: "openclaw-install-failed", target: "openclaw", detail: { jobId, step: "unknown", error: openclawInstallState.detail } });
      });
      return { status: "started", jobId };
    },
    cancel: async (jobId: string) => {
      if (openclawInstallJob === null || openclawInstallJob.jobId !== jobId) return { status: "not-found" };
      if (!openclawInstallBusy) return { status: openclawInstallJob.status };
      openclawInstallJob.cancelRequested = true; persistInstallJob();
      return { status: "cancelling", jobId };
    },
  };

  function gitLog(source: string): Array<{ hash: string; subject: string; at: string }> {
    const raw = gitDescribe([
      "-C",
      source,
      "log",
      "-10",
      "--pretty=format:%h|%s|%ad",
      "--date=short",
    ]);
    if (raw === null) return [];
    return raw.split("\n").map((line) => {
      const [hash = "", subject = "", at = ""] = line.split("|");
      return { hash, subject, at };
    });
  }

  function gitDescribe(args: string[]): string | null {
    try {
      const out = execFileSync("git", args, {
        encoding: "utf8",
        timeout: 3_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const value = out.trim();
      return value === "" ? null : value;
    } catch {
      return null;
    }
  }

  const butler = {
    version() {
      const source = resolveButlerSourceDir(process.env["BUTLER_SRC"]?.trim() || process.cwd());
      let version = "0.0.0-dev";
      try {
        const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as Record<
          string,
          unknown
        >;
        if (typeof pkg["version"] === "string" && pkg["version"].trim() !== "") {
          version = pkg["version"].trim();
        }
      } catch {
        // 源码目录没有 package.json（打包/安装形态）时保留 dev 版本
      }
      const remote = gitDescribe(["-C", source, "remote", "get-url", "origin"]);
      const configuredRepository =
        process.env["BUTLER_REPOSITORY_URL"]?.trim().replace(/\.git$/, "") ||
        DEFAULT_BUTLER_REPOSITORY;
      const repository = remote?.replace(/\.git$/, "") ?? configuredRepository;
      return {
        version,
        source,
        runtime,
        branch: gitDescribe(["-C", source, "branch", "--show-current"]),
        commit: gitDescribe(["-C", source, "rev-parse", "--short", "HEAD"]),
        tag: gitDescribe(["-C", source, "describe", "--tags", "--exact-match", "--always"]),
        repository,
        repositoryConfigured: repository !== "",
        repositorySource: remote !== null ? ("git-origin" as const) : ("configured-default" as const),
        changelog: gitLog(source),
        checkedAt: new Date().toISOString(),
      };
    },
  };

  // PRD M2 V1.7：管家自身版本管理（状态 / 一键升级 / 回滚 / 更新偏好）。
  // 升级/回滚走 detached 子进程（self-upgrade-runner.js），即使本服务被重启
  // 流水线仍继续执行；升级前全量备份复用 Task 18 备份服务。
  const butlerSelf: ButlerSelfService = createButlerSelfUpgradeService({
    sourceDir: resolveButlerSourceDir(process.env["BUTLER_SRC"]?.trim() || process.cwd()),
    homeDir: core.paths.home,
    updaterUrl: process.env["BUTLER_UPDATER_URL"]?.trim() || undefined,
    repositoryUrl:
      process.env["BUTLER_REPOSITORY_URL"]?.trim().replace(/\.git$/, "") ||
      DEFAULT_BUTLER_REPOSITORY,
    services: (process.env["BUTLER_SELF_SERVICES"] ?? "butler-watch butler-web butler-vite")
      .split(/\s+/)
      .map((name) => name.trim())
      .filter((name) => name !== ""),
    audit: core.audit,
    backup: {
      runFull: async (label: string) => {
        const row = await backup.run("full", label);
        return { id: row.id };
      },
    },
  });

  const logsService: WatchHttpDeps["logs"] = {
    listSources(instanceId?: string) {
      const record = resolveInstance(instanceId);
      const managed =
        record === undefined || record.rootPath === ""
          ? []
          : adapter.discovery.logSources({
              instanceId: record.instanceId,
              rootPath: record.rootPath,
              runtime: record.runtime,
            }).map((source) => {
              let modifiedAt: string | null = null;
              let sizeBytes = 0;
              try {
                const stat = statSync(source.path);
                modifiedAt = stat.mtime.toISOString();
                sizeBytes = stat.size;
              } catch {
                // 文件可能已被轮转删除；仍列出但标注 0
              }
              return {
                id: source.id,
                path: source.path,
                format: source.format,
                modifiedAt,
                sizeBytes,
              };
            });
      const own = BUTLER_LOG_SERVICES.map((item) => ({
        id: item.id,
        path: "journalctl --user -u " + item.service + ".service",
        format: "journald",
        modifiedAt: null,
        sizeBytes: 0,
      }));
      return [...managed, ...own];
    },
    readTail(sourceId: string, instanceId?: string, limit = 200, before: number | null = null) {
      const bounded = Math.min(Math.max(1, limit), 2_000);
      const own = BUTLER_LOG_SERVICES.find((item) => item.id === sourceId);
      if (own !== undefined) {
        const tail = readJournalTail(own.service, bounded);
        return {
          sourceId,
          path: "journalctl --user -u " + own.service + ".service",
          format: "journald",
          lines: tail.lines,
          truncated: tail.truncated,
          limit: bounded,
          totalLines: tail.totalLines,
          pageStart: null,
          hasOlder: false,
          hasNewer: false,
          ...(tail.error === undefined ? {} : { error: tail.error }),
        };
      }
      const record = resolveInstance(instanceId);
      if (record === undefined || record.rootPath === "") return null;
      const source = adapter.discovery.logSources({
        instanceId: record.instanceId,
        rootPath: record.rootPath,
        runtime: record.runtime,
      }).find((item) => item.id === sourceId);
      if (source === undefined) return null;
      const page = readLogFilePage(source.path, before, bounded);
      return {
        sourceId,
        path: source.path,
        format: source.format,
        lines: page.lines,
        truncated: page.truncated,
        limit: bounded,
        totalLines: page.totalLines,
        pageStart: page.pageStart,
        hasOlder: page.hasOlder,
        hasNewer: page.hasNewer,
        ...(page.error === undefined ? {} : { error: page.error }),
      };
    },
  };
  const logAnalyzer = createLogAnalyzer(logsService);

  // 记忆按需自检：只跑 memory-probe 单阶段（写入并召回一条测试记忆，随后清理），
  // 用于「记忆服务看似正常但实际写不进/召不回」的即时排查（PRD S5）。
  async function runMemorySelfCheck(
    instanceId?: string,
  ): Promise<MemorySelfCheckOutcome> {
    const record = resolveInstance(instanceId);
    if (record === undefined || record.rootPath === "") {
      return { ok: false, code: "no-servicing-instance", error: "no-servicing-instance" };
    }
    const result = await memorySelfCheckStage.run({
      instanceId: record.instanceId,
      frameworkId: record.frameworkId,
      rootPath: record.rootPath,
      runtime: record.runtime,
      shared: {},
    });
    core.audit.append({
      actor: "memory",
      action: "memory-self-check",
      target: record.instanceId,
      detail: { status: result.status, detail: result.detail ?? "" },
    });
    return {
      ok: true,
      instanceId: record.instanceId,
      result: { id: result.id, status: result.status, detail: result.detail ?? "" },
    };
  }

  const watchHttp = startWatchHttp(
    {
      runtime: () => runtime,
      scheduler,
    connections,
    openclawInstall,
      runbooks: runbookSummaries,
      executeRunbook: executeRunbookViaHttp,
      resetRunbookBreaker: resetRunbookBreakerViaHttp,
      logs: logsService,
      analyzeLogs: (instanceId?: string) => logAnalyzer.analyze(instanceId),
      butler,
      butlerSelf,
      upgrade: upgradeWithBackup,
      gateway,
      evolution: evolutionWithBackup,
      skills,
      memorySelfCheck: runMemorySelfCheck,
      renderDiagnostics: () =>
        renderDiagnosticReport({
          core,
          butler,
          analyzeLogs: (instanceId?: string) => logAnalyzer.analyze(instanceId),
          security,
          gateway,
          evolution,
          now: options.now,
        }),
      promptOptimization,
      backup,
      security,
    },
    { host: config.watchHttpHost, port: config.watchHttpPort },
  );
  await watchHttp.start();

  if ((options.autoStart ?? config.autoStart) !== false) {
    await criticalScheduler.start();
    await scheduler.start(); // 立即首轮巡检
    tailHandle = driver.setInterval(() => void tailTick(), config.tailPollSec * 1000);
    backup.start(); // 每小时检查：记忆增量 + 每日全量
    security.start(); // 每 30 秒复验配置不变式，捕获面板外文件修改
  }

  const stop = (): void => {
    backup.stop();
    security.stop();
    criticalScheduler.stop();
    scheduler.stop();
    if (tailHandle !== undefined) {
      driver.clearInterval(tailHandle);
      tailHandle = undefined;
    }
    forwarder.stop();
    watchHttp.close();
    engine.close();
    core.close();
  };

  return {
    core,
    config,
    runtime,
    tailer,
    engine,
    scheduler,
    criticalScheduler,
    forwarder,
    runbookExecutor,
    breaker,
    alertPoster,
    watchHttp,
    upgrade,
    gateway,
    evolution,
    skills,
    promptOptimization,
    backup,
    security,
    instances,
    pollTail,
    stop,
  };
}
