/**
 * butler-watch HTTP 控制通道（Task 10 前置）：node:http 原生实现。
 *
 * 端点契约（同时提供给 ui/web 代理使用，严格一致；全部 JSON 响应）：
 * - GET  /healthz                    → { ok: true }
 * - GET  /api/runbooks               → { runbooks: Array<{ id, label, description,
 *                                      breakerTripped, lastRun?: { at, success } }> }
 * - POST /api/runbooks/:id/execute   → body { instanceId? }（缺省取首个 Serving 实例）
 *                                      202 { started: true }；未知 id → 404 { error }；
 *                                      熔断跳闸 → 409 { error: "circuit-breaker-tripped" }；
 *                                      无可用实例 → 503 { error }
 * - POST /api/inspect/run            → 202 { started: true }；巡检在飞 →
 *                                      409 { error: "inspection-in-flight" }
 * - GET  /api/inspect/status         → { lastAt, nextAt, intervalMin, inFlight }
 * - POST /api/upgrade/run            → body { instanceId?, targetVersion, channel? }：
 *                                      202 { started: true, jobId, instanceId }；
 *                                      targetVersion 缺失/空/非字符串 →
 *                                      400 { error: "missing-target-version" }；
 *                                      升级在飞 → 409 { error: "upgrade-in-flight" }；
 *                                      无 Serving 实例 → 503 { error: "no-servicing-instance" }
 * - GET  /api/upgrade/status         → { job: UpgradeJobView | null }
 * - GET  /api/upgrade/versions       → { reachable: true, source, versions } 或
 *                                      { reachable: false, versions: [] }（版本源
 *                                      全败不 5xx）
 * - POST /api/snapshots/:id/rollback → body { instanceId? }（:id 数值行 id）：
 *                                      200 { job: { jobId, kind: "rollback", steps } }；
 *                                      非数值 id → 400 { error: "invalid-snapshot-id" }；
 *                                      快照不存在/不可回滚 → 404 { error: "snapshot-not-found" }；
 *                                      无可用实例 → 503 { error: "no-servicing-instance" }
 * - GET  /api/gateway/stats          → 200 { stats: RateLimitPanelView }
 *                                      （{ overall, totalEvents, last24h, matched[],
 *                                         suggestions[] }，结构见 gateway-stats.ts）
 * - GET  /api/gateway/patches        → 200 { patches: PatchPanelView[] }
 *                                      （登记表 + schema + applied 状态）
 * - POST /api/gateway/patches/:id/apply 与 /reapply
 *                                    → body { params?: Record<string, number>,
 *                                             instanceId? }（:id URL 解码）：
 *                                      200 { status: "ok", result, targetPath, params }；
 *                                      params 值非 number → 400 { error: "invalid-params",
 *                                        detail }；
 *                                      未知补丁 → 404 { error: "unknown-patch" }；
 *                                      参数越界 → 400 { error: "invalid-params", detail }；
 *                                      漂移/前置缺失 → 409 { error: "patch-conflict",
 *                                        detail }；
 *                                      无可用实例 → 503 { error: "no-instance" }
 * - POST /api/gateway/patches/:id/detect
 *                                    → body { instanceId? }：200 { report: DriftReport }；
 *                                      未知补丁 → 404 { error: "unknown-patch" }；
 *                                      无可用实例 → 503 { error: "no-instance" }
 * - GET  /api/skills                 → query { instanceId?, keyword?, limit? }；
 *                                      200 SkillsMemoryView；limit 非正整数 → 400；
 *                                      服务未接线 → 503
 * - GET  /api/logs/analyze       → query { instanceId? }；200 { issues, scannedSources,
 *                                      scannedLines, analyzedAt }；服务未接线 → 503
 * - POST /api/logs/fix             → body { action, confirmed, instanceId? }：
 *                                      202 { started: true }；confirmed 非 true → 400；
 *                                      未知 action → 400；熔断跳闸 → 409；无实例 → 503
 * - GET  /api/memory                 → query { instanceId? }；200 { instance, memory }；
 *                                      服务未接线 → 503
 * M6 写路由仅在 `m6WritesEnabled=true` 时注册语义；V1 默认以 404 隐藏：
 * - POST /api/memory/archive         → body { instanceId?, olderThan?, keepMonths?,
 *                                      dryRun?, entryIds? }；200 { ok, report }；
 *                                      E002 → 400；E403 → 409；服务未接线 → 503
 * - POST /api/memory/restore         → body { instanceId?, entryIds?, olderThan? }；
 *                                      200 { ok, report }；错误映射同上
 * - POST /api/memory/rebuild-index → body { instanceId? }；200 { ok, report }；
 * - POST /api/memory/purge           → body { instanceId?, confirmed?, kind?,
 *                                      entryIds?, archivedBefore? }；confirmed 非 true
 *                                      → 400；错误映射同上
 * - POST /api/memory/export        → body { instanceId?, passphrase }；200 application/octet-stream
 *      （AES-256-GCM 加密 .abmem；口令不足 8 位 → 400）
 * - POST /api/memory/self-check    → body { instanceId? }；200 { ok, instanceId, result }；
 *                                      无实例/未接线 → 503
 * - GET  /api/diagnostics/report → 200 text/markdown（脱敏诊断报告附件）；未接线 → 503
 * - GET  /api/prompt-optimization/targets → 200 { targets: PromptTargetView[] }；
 *                                      服务未接线 → 503（M5 切片 1/2）
 * - GET  /api/prompt-optimization/active/:targetId → 200 PromptActiveView；
 *                                      未知目标 → 404；服务未接线 → 503
 * - GET  /api/prompt-optimization/candidates → 200 { candidates: PromptCandidateView[] }；
 *      query { targetId? }；服务未接线 → 503
 * - POST /api/prompt-optimization/candidates → body { targetId, content, baseSha256,
 *      source?, description? }；201 { candidate }；400/404 按错误映射
 * - GET  /api/prompt-optimization/candidates/:id → 200 { candidate }；404
 * - GET  /api/prompt-optimization/candidates/:id/report → 200
 *      { candidate, report: PromptEvaluationReportView | null }；404
 * - POST /api/prompt-optimization/candidates/:id/evaluate → body
 *      { cases?, datasetPath?, datasetHash?, datasetSchemaVersion?, modelParams?, seed? }；
 *      201 { report }；400/404 按错误映射
 *
 * 请求体解析上限 16KB（超出 413；非法 JSON 400）。监听 127.0.0.1:7533
 * （BUTLER_WATCH_HOST / BUTLER_WATCH_PORT 可覆盖，config.ts 读入）。依赖全部
 * 注入（scheduler / runbooks 元信息 / executeRunbook / upgrade 升级服务 /
 * gateway 网关面板服务 / promptOptimization 提示词 Registry），测试经回环真实端口验证。
 */
import { createServer, type Server } from "node:http";
import type {
  EvolutionExpandInput,
  EvolutionPreflightInput,
  EvolutionResultInput,
  EvolutionService,
} from "./evolution.js";
import type { GatewayPanelService } from "./gateway-stats.js";
import type { SkillsMemoryService } from "./skills.js";
import type { UpgradeService } from "./upgrade.js";
import type { ButlerSelfService } from "./self-upgrade.js";
import type { PromptOptimizationService } from "./prompt-optimization.js";
import type { LogAnalyzeView } from "./log-analyzer.js";
import type { BackupService } from "./backup.js";
import type { SecurityService } from "./invariants.js";

/** 记忆按需自检（memory-probe 单阶段）的结论。 */
export interface MemorySelfCheckResult {
  id: string;
  status: "pass" | "warn" | "fail" | "skipped";
  detail: string;
}

/** 记忆自检端点结果（接线层判定，HTTP 层映射状态码）。 */
export type MemorySelfCheckOutcome =
  | { ok: true; instanceId: string; result: MemorySelfCheckResult }
  | { ok: false; code: "no-servicing-instance" | "memory-probe-unavailable"; error: string };

/** 请求体解析上限（字节）。 */
export const HTTP_BODY_LIMIT_BYTES = 16 * 1024;

/** runbook 执行结果（由接线层判定，HTTP 层只做状态码映射）。 */
export type RunbookExecuteOutcome =
  | { status: "started"; instanceId: string }
  | { status: "unknown-runbook" }
  | { status: "circuit-breaker-tripped" }
  | { status: "no-servicing-instance" };

/** GET /api/runbooks 的单条 runbook 元信息。 */
export interface RunbookSummary {
  id: string;
  label: string;
  description: string;
  /** 执行影响范围（面向小白用户；无则空串）。 */
  impact: string;
  /** 执行步骤预览（label 列表）。 */
  steps: string[];
  breakerTripped: boolean;
  lastRun?: { at: string; success: boolean };
}

/** HTTP 层依赖（全部可注入）。 */
export interface WatchHttpDeps {
  scheduler: {
    /** 立即巡检入口（在飞返回 false → 409）。 */
    runNow(): boolean;
    status(): {
      lastAt: string | null;
      nextAt: string | null;
      intervalMin: number;
      inFlight: boolean;
    };
  };
  /** runbook 元信息列表（含熔断态与最近执行）。 */
  runbooks(): RunbookSummary[];
  /** 执行判定（实例解析 + 熔断检查 + 异步启动），HTTP 层按 outcome 映射状态码。 */
  executeRunbook(id: string, instanceId?: string): Promise<RunbookExecuteOutcome>;
  /** Task 13：升级服务（发起/状态/版本列表/快照回滚），HTTP 层只做状态码映射。 */
  upgrade: UpgradeService;
  /** Task 15：网关限流统计与补丁参数面板服务，HTTP 层只做状态码映射。 */
  gateway: GatewayPanelService;
  /** Task 16：进化守门服务；可选以兼容尚未接线的嵌入式测试。 */
  evolution?: EvolutionService;
  /** Task 17：技能与记忆只读列表服务；可选以兼容尚未接线的嵌入式测试。 */
  skills?: SkillsMemoryService;
  /** M6 P1/P2 写操作开关；V1 默认关闭并以 404 隐藏写路由。 */
  m6WritesEnabled?: boolean;
  /** Task 6/17：按需记忆写入召回自检（只跑 memory-probe 单阶段）。 */
  memorySelfCheck?: (instanceId?: string) => Promise<MemorySelfCheckOutcome>;
  /** M7：脱敏诊断报告生成器（一键生成 Markdown）。 */
  renderDiagnostics?: () => Promise<string>;
  /** 系统日志：列表 + 尾部读取（观察面；路径只读）。 */
  logs?: {
    listSources(instanceId?: string): Array<{
      id: string;
      path: string;
      format: string;
      modifiedAt: string | null;
      sizeBytes: number;
    }>;
    readTail(
      sourceId: string,
      instanceId?: string,
      limit?: number,
      before?: number | null,
    ): {
      sourceId: string;
      path: string;
      format: string;
      lines: string[];
      truncated: boolean;
      limit: number;
      totalLines: number;
      /** 本页第一行起始 byte offset；下一页「更早」游标；journald 源为 null。 */
      pageStart: number | null;
      hasOlder: boolean;
      hasNewer: boolean;
      error?: string;
    } | null;
  };
  /** 系统日志智能体检（V1.7）：扫描日志尾部并按指纹聚合错误，给出可执行修复建议。 */
  analyzeLogs?: (instanceId?: string) => LogAnalyzeView;
  /** 管家自身版本信息（源码仓库 tag / 提交 / 分支）。 */
  butler?: {
    version(): {
      version: string;
      source: string;
      branch: string | null;
      commit: string | null;
      tag: string | null;
      repository: string | null;
      changelog?: Array<{ hash: string; subject: string; at: string }>;
      checkedAt: string;
    };
  };
  /** 管家自身版本管理（V1.7）：状态 / 一键升级 / 回滚 / 更新偏好。 */
  butlerSelf?: ButlerSelfService;
  /** M5 切片 1/2：提示词 Registry、候选与评估服务；可选以兼容尚未接线的测试。 */
  promptOptimization?: PromptOptimizationService;
  /** Task 18：备份服务（列表/手动备份/还原）。 */
  backup?: BackupService;
  /** Task 18：安全基线（配置不变式 + 密钥权限）。 */
  security?: SecurityService;
}

export interface WatchHttpOptions {
  host?: string;
  port?: number;
}

export interface WatchHttp {
  /** 开始监听（幂等）。 */
  start(): Promise<{ host: string; port: number }>;
  /** 停止监听并断开存量连接（幂等）。 */
  close(): void;
  /** 当前监听地址（未监听为 null）。 */
  address(): { host: string; port: number } | null;
}

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendMarkdown(
  res: import("node:http").ServerResponse,
  filename: string,
  markdown: string,
): void {
  res.writeHead(200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-length": Buffer.byteLength(markdown),
    "content-disposition": `attachment; filename="${filename.replace(/["\\\r\n]/g, "_")}"`,
  });
  res.end(markdown);
}
function sendBytes(
  res: import("node:http").ServerResponse,
  filename: string,
  data: Uint8Array,
): void {
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": data.byteLength,
    "content-disposition": `attachment; filename="${filename.replace(/["\\\r\n]/g, "_")}"`,
  });
  res.end(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
}



function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 读取请求体（≤16KB；空体 → {}；非法 JSON → 400；超限 → 413）。 */
async function readJsonBody(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > HTTP_BODY_LIMIT_BYTES) {
      sendJson(res, 413, { error: "payload-too-large" });
      return null;
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      sendJson(res, 400, { error: "invalid-json-body" });
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: "invalid-json-body" });
    return null;
  }
}

/** 组装并启动 HTTP 控制通道。 */
export function startWatchHttp(deps: WatchHttpDeps, options: WatchHttpOptions = {}): WatchHttp {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 7533;

  const server: Server = createServer((req, res) => {
    void handle(deps, req, res);
  });
  // 长连接（keep-alive）不阻碍关闭：close() 时统一断开。
  server.keepAliveTimeout = 5_000;

  let listening: { host: string; port: number } | null = null;
  let startPromise: Promise<{ host: string; port: number }> | undefined;

  const http: WatchHttp = {
    start(): Promise<{ host: string; port: number }> {
      if (startPromise !== undefined) return startPromise;
      startPromise = new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(requestedPort, host, () => {
          const addr = server.address();
          listening =
            addr !== null && typeof addr === "object"
              ? { host: addr.address, port: addr.port }
              : { host, port: requestedPort };
          resolve(listening);
        });
      });
      return startPromise;
    },
    close(): void {
      if (!server.listening) return;
      server.close();
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      listening = null;
    },
    address(): { host: string; port: number } | null {
      return listening;
    },
  };
  return http;
}

/** 路由分发。 */
async function handle(
  deps: WatchHttpDeps,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://butler-watch.local");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";

  try {
    if (path === "/healthz") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      return sendJson(res, 200, { ok: true });
    }

    if (path === "/api/backups") {
      if (deps.backup === undefined) return sendJson(res, 503, { error: "backup-unavailable" });
      if (method === "GET") {
        const kindParam = url.searchParams.get("kind")?.trim();
        const kind =
          kindParam === "full" || kindParam === "memory" || kindParam === "event"
            ? kindParam
            : undefined;
        return sendJson(res, 200, { items: deps.backup.list(kind), status: deps.backup.status() });
      }
      if (method === "POST") {
        const body = await readJsonBody(req, res);
        if (body === null) return;
        const kind = body["kind"];
        if (kind !== "full" && kind !== "memory" && kind !== "event") {
          return sendJson(res, 400, { error: "invalid-backup-kind" });
        }
        const label = typeof body["label"] === "string" ? body["label"].trim() : undefined;
        try {
          const backup = await deps.backup.run(kind, label || undefined);
          return sendJson(res, 201, { backup });
        } catch (error) {
          return sendJson(res, 500, {
            error: "backup-failed",
            userHint: error instanceof Error ? error.message : "备份失败，请稍后再试。",
          });
        }
      }
      return sendJson(res, 405, { error: "method-not-allowed" });
    }
    const restoreMatch = /^\/api\/backups\/([^/]+)\/restore$/.exec(path);
    if (restoreMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.backup === undefined) return sendJson(res, 503, { error: "backup-unavailable" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const id = Number(restoreMatch[1]);
      if (!Number.isInteger(id) || id <= 0) {
        return sendJson(res, 400, { error: "invalid-backup-id" });
      }
      const outcome = await deps.backup.restore(id, body["confirmed"] === true);
      if (!outcome.ok) {
        if (outcome.error === "confirmation-required") {
          return sendJson(res, 400, {
            error: "confirmation-required",
            userHint: "还原会覆盖当前记忆/配置，必须先确认。",
          });
        }
        if (outcome.error === "backup-not-found" || outcome.error === "backup-manifest-corrupt") {
          return sendJson(res, 404, { error: outcome.error });
        }
        return sendJson(res, 400, { error: outcome.error });
      }
      return sendJson(res, 200, outcome);
    }

    if (path === "/api/security") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.security === undefined) return sendJson(res, 503, { error: "security-unavailable" });
      return sendJson(res, 200, await deps.security.status());
    }

        if (path === "/api/runbooks") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      return sendJson(res, 200, { runbooks: deps.runbooks() });
    }

    const executeMatch = /^\/api\/runbooks\/([^/]+)\/execute$/.exec(path);
    if (executeMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJsonBody(req, res);
      if (body === null) return; // 已回 400/413
      const id = decodeURIComponent(executeMatch[1]!);
      const instanceId =
        typeof body["instanceId"] === "string" && body["instanceId"] !== ""
          ? body["instanceId"]
          : undefined;
      const outcome = await deps.executeRunbook(id, instanceId);
      if (outcome.status === "started") return sendJson(res, 202, { started: true });
      if (outcome.status === "unknown-runbook") {
        return sendJson(res, 404, { error: `unknown-runbook: ${id}` });
      }
      if (outcome.status === "circuit-breaker-tripped") {
        return sendJson(res, 409, { error: "circuit-breaker-tripped" });
      }
      return sendJson(res, 503, { error: "no-servicing-instance" });
    }

    if (path === "/api/inspect/run") {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const started = deps.scheduler.runNow(); // 只触发一次，复用结果映射状态码
      return sendJson(
        res,
        started ? 202 : 409,
        started ? { started: true } : { error: "inspection-in-flight" },
      );
    }

    if (path === "/api/inspect/status") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      return sendJson(res, 200, deps.scheduler.status());
    }

    if (path === "/api/skills") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.skills === undefined) return sendJson(res, 503, { error: "skills-unavailable" });
      const instanceId = url.searchParams.get("instanceId")?.trim() || undefined;
      const keyword = url.searchParams.get("keyword")?.trim() || undefined;
      const limitRaw = url.searchParams.get("limit");
      let limit: number | undefined;
      if (limitRaw !== null) {
        limit = Number(limitRaw);
        if (!Number.isInteger(limit) || limit <= 0) {
          return sendJson(res, 400, { error: "invalid-limit" });
        }
      }
      return sendJson(
        res,
        200,
        await deps.skills.status({
          ...(instanceId === undefined ? {} : { instanceId }),
          ...(keyword === undefined ? {} : { keyword }),
          ...(limit === undefined ? {} : { limit }),
        }),
      );
    }

    if (path === "/api/butler/version") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.butler === undefined) return sendJson(res, 503, { error: "butler-unavailable" });
      return sendJson(res, 200, deps.butler.version());
    }

    if (path === "/api/butler/self") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.butlerSelf === undefined) {
        return sendJson(res, 503, { error: "butler-self-unavailable" });
      }
      return sendJson(res, 200, deps.butlerSelf.status());
    }

    if (path === "/api/butler/self/upgrade") {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.butlerSelf === undefined) {
        return sendJson(res, 503, { error: "butler-self-unavailable" });
      }
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const target = typeof body["target"] === "string" && body["target"].trim() !== ""
        ? body["target"].trim()
        : undefined;
      const channel = body["channel"] === "beta" ? "beta" : body["channel"] === "stable" ? "stable" : undefined;
      const outcome = await deps.butlerSelf.startUpgrade({
        ...(target === undefined ? {} : { target }),
        ...(channel === undefined ? {} : { channel }),
        confirmed: body["confirmed"] === true,
        trigger: "manual",
      });
      if (outcome.status === "started") {
        return sendJson(res, 202, { started: true, jobId: outcome.jobId, snapshotId: outcome.snapshotId });
      }
      if (outcome.status === "confirmation-required") {
        return sendJson(res, 400, { error: "confirmation-required", userHint: "升级前会备份并重启服务，必须先确认。" });
      }
      if (outcome.status === "upgrade-in-flight") {
        return sendJson(res, 409, { error: "upgrade-in-flight" });
      }
      if (outcome.status === "backup-failed") {
        return sendJson(res, 500, {
          error: "backup-failed",
          userHint: "升级前全量备份失败，已取消升级。请检查备份目录和数据库状态后重试。",
        });
      }
      if (outcome.status === "invalid-target" || outcome.status === "no-target") {
        return sendJson(res, 400, { error: outcome.status, userHint: "没有找到可用的目标版本。" });
      }
      return sendJson(res, 503, { error: "no-repo", userHint: "源码目录还不是 Git 仓库，暂时不能自我升级。" });
    }

    if (path === "/api/butler/self/rollback") {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.butlerSelf === undefined) {
        return sendJson(res, 503, { error: "butler-self-unavailable" });
      }
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const snapshotId = typeof body["snapshotId"] === "string" ? body["snapshotId"] : "";
      const outcome = deps.butlerSelf.rollback({
        snapshotId,
        confirmed: body["confirmed"] === true,
      });
      if (outcome.status === "started") {
        return sendJson(res, 202, { started: true, jobId: outcome.jobId });
      }
      if (outcome.status === "confirmation-required") {
        return sendJson(res, 400, { error: "confirmation-required", userHint: "回滚会重建并重启服务，必须先确认。" });
      }
      if (outcome.status === "upgrade-in-flight") {
        return sendJson(res, 409, { error: "upgrade-in-flight" });
      }
      if (outcome.status === "snapshot-not-found") {
        return sendJson(res, 404, { error: "snapshot-not-found" });
      }
      return sendJson(res, 503, { error: "no-repo" });
    }

    if (path === "/api/butler/self/prefs") {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.butlerSelf === undefined) {
        return sendJson(res, 503, { error: "butler-self-unavailable" });
      }
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const channel = body["channel"] === "beta" ? "beta" : body["channel"] === "stable" ? "stable" : undefined;
      const locked = typeof body["locked"] === "boolean" ? body["locked"] : undefined;
      return sendJson(res, 200, deps.butlerSelf.updatePrefs({
        ...(channel === undefined ? {} : { channel }),
        ...(locked === undefined ? {} : { locked }),
      }));
    }

    if (path === "/api/logs/analyze") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.analyzeLogs === undefined)
        return sendJson(res, 503, { error: "log-analyzer-unavailable" });
      const instanceId = url.searchParams.get("instanceId")?.trim() || undefined;
      return sendJson(res, 200, deps.analyzeLogs(instanceId));
    }

    if (path === "/api/logs/fix") {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJsonBody(req, res);
      if (body === null) return; // 已回 400/413
      if (body["confirmed"] !== true) {
        return sendJson(res, 400, {
          error: "confirmation-required",
          userHint: "修复会重启或重连服务，必须先确认影响范围。",
        });
      }
      const action = body["action"];
      if (action !== "rb-restart" && action !== "rb-reconnect") {
        return sendJson(res, 400, { error: "unknown-action" });
      }
      const instanceId =
        typeof body["instanceId"] === "string" && body["instanceId"] !== ""
          ? body["instanceId"]
          : undefined;
      const outcome = await deps.executeRunbook(action, instanceId);
      if (outcome.status === "started") return sendJson(res, 202, { started: true });
      if (outcome.status === "unknown-runbook") {
        return sendJson(res, 404, { error: `unknown-runbook: ${action}` });
      }
      if (outcome.status === "circuit-breaker-tripped") {
        return sendJson(res, 409, { error: "circuit-breaker-tripped" });
      }
      return sendJson(res, 503, { error: "no-servicing-instance" });
    }

    if (path === "/api/logs" || path.startsWith("/api/logs/")) {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.logs === undefined) return sendJson(res, 503, { error: "logs-unavailable" });
      const instanceId = url.searchParams.get("instanceId")?.trim() || undefined;
      if (path === "/api/logs") {
        return sendJson(res, 200, {
          sources: deps.logs.listSources(instanceId),
          instanceId: instanceId ?? null,
        });
      }
      const sourceId = decodeURIComponent(path.slice("/api/logs/".length));
      if (sourceId === "") return sendJson(res, 400, { error: "invalid-source-id" });
      const limitRaw = url.searchParams.get("limit");
      let limit = 200;
      if (limitRaw !== null) {
        limit = Number(limitRaw);
        if (!Number.isInteger(limit) || limit <= 0 || limit > 2_000) {
          return sendJson(res, 400, { error: "invalid-limit" });
        }
      }
      const beforeRaw = url.searchParams.get("before");
      let before: number | null = null;
      if (beforeRaw !== null && beforeRaw !== "") {
        before = Number(beforeRaw);
        if (!Number.isInteger(before) || before < 0) {
          return sendJson(res, 400, { error: "invalid-before" });
        }
      }
      const view = deps.logs.readTail(sourceId, instanceId, limit, before);
      if (view === null) return sendJson(res, 404, { error: "log-source-not-found" });
      return sendJson(res, 200, view);
    }

    if (path === "/api/memory") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.skills === undefined) return sendJson(res, 503, { error: "skills-unavailable" });
      const instanceId = url.searchParams.get("instanceId")?.trim() || undefined;
      const view = await deps.skills.status({
        ...(instanceId === undefined ? {} : { instanceId }),
        limit: 20,
      });
      return sendJson(res, 200, { instance: view.instance, memory: view.memory });
    }

    if (
      path === "/api/memory/archive" ||
      path === "/api/memory/restore" ||
      path === "/api/memory/purge"
    ) {
      if (deps.m6WritesEnabled !== true) return sendJson(res, 404, { error: "not-found" });
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.skills === undefined) return sendJson(res, 503, { error: "skills-unavailable" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const instanceId =
        typeof body["instanceId"] === "string" && body["instanceId"] !== ""
          ? body["instanceId"]
          : undefined;
      const entryIds = isStringArray(body["entryIds"]) ? body["entryIds"] : undefined;
      const olderThan =
        typeof body["olderThan"] === "string" && body["olderThan"] !== ""
          ? body["olderThan"]
          : undefined;
      const query = instanceId === undefined ? {} : { instanceId };
      let result;
      if (path === "/api/memory/archive") {
        const dryRun = body["dryRun"] === true;
        const keepMonths =
          typeof body["keepMonths"] === "number" && Number.isFinite(body["keepMonths"])
            ? body["keepMonths"]
            : undefined;
        result = await deps.skills.archiveCold(query, {
          dryRun,
          ...(olderThan === undefined ? {} : { olderThan }),
          ...(keepMonths === undefined ? {} : { keepMonths }),
          ...(entryIds === undefined ? {} : { entryIds }),
        });
      } else if (path === "/api/memory/restore") {
        result = await deps.skills.restoreCold(query, {
          ...(entryIds === undefined ? {} : { entryIds }),
          ...(olderThan === undefined ? {} : { olderThan }),
        });
      } else {
        const confirmed = body["confirmed"] === true;
        const kind = body["kind"] === "probes" ? "probes" : body["kind"] === "archived" ? "archived" : undefined;
        const archivedBefore =
          typeof body["archivedBefore"] === "string" && body["archivedBefore"] !== ""
            ? body["archivedBefore"]
            : undefined;
        result = await deps.skills.purge(query, {
          confirmed,
          ...(kind === undefined ? {} : { kind }),
          ...(entryIds === undefined ? {} : { entryIds }),
          ...(archivedBefore === undefined ? {} : { archivedBefore }),
        });
      }
      if (result.ok) {
        return sendJson(res, 200, {
          ok: true,
          instanceId: result.instanceId,
          report: result.report,
        });
      }
      const status = result.code === "E002" ? 400 : result.code === "E403" ? 409 : 500;
      return sendJson(res, status, {
        error: result.error ?? "memory-action-failed",
        userHint: result.userHint,
      });
    }

    if (path === "/api/memory/rebuild-index") {
      if (deps.m6WritesEnabled !== true) return sendJson(res, 404, { error: "not-found" });
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.skills === undefined) return sendJson(res, 503, { error: "skills-unavailable" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const instanceId =
        typeof body["instanceId"] === "string" && body["instanceId"] !== ""
          ? body["instanceId"]
          : undefined;
      const query = instanceId === undefined ? {} : { instanceId };
      const result = await deps.skills.rebuildIndex(query);
      if (result.ok) {
        return sendJson(res, 200, {
          ok: true,
          instanceId: result.instanceId,
          report: result.report,
        });
      }
      const status = result.code === "E002" ? 400 : result.code === "E403" ? 409 : 500;
      return sendJson(res, status, {
        error: result.error ?? "memory-rebuild-index-failed",
        userHint: result.userHint,
      });
    }

    if (path === "/api/memory/export") {
      if (deps.m6WritesEnabled !== true) return sendJson(res, 404, { error: "not-found" });
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.skills === undefined) return sendJson(res, 503, { error: "skills-unavailable" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const instanceId =
        typeof body["instanceId"] === "string" && body["instanceId"] !== ""
          ? body["instanceId"]
          : undefined;
      const passphrase = typeof body["passphrase"] === "string" ? body["passphrase"] : "";
      const result = await deps.skills.exportEncrypted(
        instanceId === undefined ? {} : { instanceId },
        passphrase,
      );
      if (!result.ok) {
        const status =
          result.code === "passphrase-too-short" ||
          result.code === "memory-store-not-found" ||
          result.code === "E002"
            ? 400
            : 500;
        return sendJson(res, status, {
          error: result.error ?? "memory-export-failed",
          userHint: result.userHint,
        });
      }
      return sendBytes(res, result.filename ?? "butler-memory-export.abmem", result.data ?? new Uint8Array());
    }

    if (path === "/api/memory/self-check") {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.memorySelfCheck === undefined) {
        return sendJson(res, 503, { error: "memory-self-check-unavailable" });
      }
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const instanceId =
        typeof body["instanceId"] === "string" && body["instanceId"] !== ""
          ? body["instanceId"]
          : undefined;
      const outcome = await deps.memorySelfCheck(instanceId);
      if (!outcome.ok) {
        return sendJson(res, 503, { error: outcome.error ?? outcome.code });
      }
      return sendJson(res, 200, {
        ok: true,
        instanceId: outcome.instanceId,
        result: outcome.result,
      });
    }

        if (path === "/api/upgrade/run") {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const targetVersion = body["targetVersion"];
      if (typeof targetVersion !== "string" || targetVersion.trim() === "") {
        return sendJson(res, 400, { error: "missing-target-version" });
      }
      const instanceId =
        typeof body["instanceId"] === "string" && body["instanceId"] !== ""
          ? body["instanceId"]
          : undefined;
      const channel =
        body["channel"] === "beta" ? "beta" : body["channel"] === "stable" ? "stable" : undefined;
      const outcome = deps.upgrade.startUpgrade({ instanceId, targetVersion, channel });
      if (outcome.status === "started") {
        return sendJson(res, 202, {
          started: true,
          jobId: outcome.jobId,
          instanceId: outcome.instanceId,
        });
      }
      if (outcome.status === "upgrade-in-flight") {
        return sendJson(res, 409, { error: "upgrade-in-flight" });
      }
      if (outcome.status === "missing-target-version") {
        return sendJson(res, 400, { error: "missing-target-version" });
      }
      return sendJson(res, 503, { error: "no-servicing-instance" });
    }

    if (path === "/api/upgrade/status") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      return sendJson(res, 200, { job: deps.upgrade.status() });
    }

    if (path === "/api/upgrade/versions") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      const result = await deps.upgrade.listVersions();
      // 版本源全败 → reachable:false 空列表（不 5xx）；成功携带 source id。
      return sendJson(
        res,
        200,
        result.reachable
          ? { reachable: true, source: result.source, versions: result.versions }
          : { reachable: false, versions: [] },
      );
    }

    if (path === "/api/prompt-optimization/targets") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.promptOptimization === undefined) {
        return sendJson(res, 503, { error: "prompt-optimization-unavailable" });
      }
      return sendJson(res, 200, { targets: deps.promptOptimization.listTargets() });
    }

    const promptActiveMatch = /^\/api\/prompt-optimization\/active\/([^/]+)$/.exec(path);
    if (promptActiveMatch !== null) {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.promptOptimization === undefined) {
        return sendJson(res, 503, { error: "prompt-optimization-unavailable" });
      }
      const active = deps.promptOptimization.getActive(decodeURIComponent(promptActiveMatch[1]!));
      if (active === null) return sendJson(res, 404, { error: "prompt-target-not-found" });
      return sendJson(res, 200, active);
    }

    if (path === "/api/prompt-optimization/candidates") {
      if (deps.promptOptimization === undefined) {
        return sendJson(res, 503, { error: "prompt-optimization-unavailable" });
      }
      if (method === "GET") {
        const targetId = url.searchParams.get("targetId")?.trim() || undefined;
        return sendJson(res, 200, {
          candidates: deps.promptOptimization.listCandidates(targetId),
        });
      }
      if (method === "POST") {
        const body = await readJsonBody(req, res);
        if (body === null) return;
        const outcome = deps.promptOptimization.createCandidate(body);
        if (outcome.status === "error") {
          const status = outcome.error === "target-not-found" ? 404 : 400;
          return sendJson(res, status, outcome);
        }
        return sendJson(res, 201, { candidate: outcome.candidate });
      }
      return sendJson(res, 405, { error: "method-not-allowed" });
    }

    const promptEvaluateMatch = /^\/api\/prompt-optimization\/candidates\/([^/]+)\/evaluate$/.exec(
      path,
    );
    if (promptEvaluateMatch !== null) {
      if (deps.promptOptimization === undefined) {
        return sendJson(res, 503, { error: "prompt-optimization-unavailable" });
      }
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const candidateId = decodeURIComponent(promptEvaluateMatch[1]!);
      const outcome = await deps.promptOptimization.evaluateCandidate({
        ...body,
        candidateId,
      });
      if (outcome.status === "error") {
        const status = outcome.error === "candidate-not-found" ? 404 : 400;
        return sendJson(res, status, outcome);
      }
      return sendJson(res, 201, { report: outcome.report });
    }

    const promptPromoteMatch = /^\/api\/prompt-optimization\/candidates\/([^/]+)\/promote$/.exec(
      path,
    );
    if (promptPromoteMatch !== null) {
      if (deps.promptOptimization === undefined) {
        return sendJson(res, 503, { error: "prompt-optimization-unavailable" });
      }
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const candidateId = decodeURIComponent(promptPromoteMatch[1]!);
      const outcome = deps.promptOptimization.promoteCandidate({ ...body, candidateId });
      if (outcome.status === "error") {
        const notFound = new Set([
          "candidate-not-found",
          "target-not-found",
          "evaluation-not-found",
        ]);
        const conflict = new Set([
          "confirmation-required",
          "evaluation-stale",
          "promotion-not-allowed",
          "source-changed",
          "candidate-tampered",
        ]);
        const status = notFound.has(outcome.error)
          ? 404
          : conflict.has(outcome.error)
            ? 409
            : outcome.error === "write-failed"
              ? 500
              : 400;
        return sendJson(res, status, outcome);
      }
      return sendJson(res, 200, outcome);
    }

    const promptCandidateMatch = /^\/api\/prompt-optimization\/candidates\/([^/]+)$/.exec(path);
    if (promptCandidateMatch !== null) {
      if (deps.promptOptimization === undefined) {
        return sendJson(res, 503, { error: "prompt-optimization-unavailable" });
      }
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      const candidate = deps.promptOptimization.getCandidate(
        decodeURIComponent(promptCandidateMatch[1]!),
      );
      if (candidate === null) return sendJson(res, 404, { error: "prompt-candidate-not-found" });
      return sendJson(res, 200, { candidate });
    }

    const promptCandidateReportMatch =
      /^\/api\/prompt-optimization\/candidates\/([^/]+)\/report$/.exec(path);
    if (promptCandidateReportMatch !== null) {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.promptOptimization === undefined) {
        return sendJson(res, 503, { error: "prompt-optimization-unavailable" });
      }
      const outcome = deps.promptOptimization.getCandidateReport(
        decodeURIComponent(promptCandidateReportMatch[1]!),
      );
      if (outcome === null) return sendJson(res, 404, { error: "prompt-candidate-not-found" });
      return sendJson(res, 200, outcome);
    }

    const rollbackMatch = /^\/api\/snapshots\/([^/]+)\/rollback$/.exec(path);
    if (rollbackMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const idRaw = decodeURIComponent(rollbackMatch[1]!);
      if (!/^\d+$/.test(idRaw)) return sendJson(res, 400, { error: "invalid-snapshot-id" });
      const instanceId =
        typeof body["instanceId"] === "string" && body["instanceId"] !== ""
          ? body["instanceId"]
          : undefined;
      const outcome = await deps.upgrade.rollbackSnapshot(Number(idRaw), instanceId);
      if (outcome.status === "ok") return sendJson(res, 200, { job: outcome.job });
      if (outcome.status === "snapshot-not-found") {
        return sendJson(res, 404, { error: "snapshot-not-found" });
      }
      return sendJson(res, 503, { error: "no-servicing-instance" });
    }

    if (path === "/api/gateway/stats") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      return sendJson(res, 200, { stats: await deps.gateway.stats() });
    }

    if (path === "/api/gateway/patches") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      return sendJson(res, 200, { patches: await deps.gateway.patches() });
    }

    const patchActionMatch = /^\/api\/gateway\/patches\/([^/]+)\/(apply|reapply|detect)$/.exec(
      path,
    );
    if (patchActionMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJsonBody(req, res);
      if (body === null) return; // 已回 400/413
      const id = decodeURIComponent(patchActionMatch[1]!);
      const action = patchActionMatch[2]!;
      const instanceId =
        typeof body["instanceId"] === "string" && body["instanceId"] !== ""
          ? body["instanceId"]
          : undefined;

      if (action === "detect") {
        const outcome = await deps.gateway.detectPatch({ patchId: id, instanceId });
        if (outcome.status === "ok") return sendJson(res, 200, { report: outcome.report });
        if (outcome.status === "unknown-patch")
          return sendJson(res, 404, { error: "unknown-patch" });
        return sendJson(res, 503, { error: "no-instance" });
      }

      // apply / reapply：params 必须是对象且值全为有限数值（其余交由服务层校验界限）
      const rawParams = body["params"];
      let params: Record<string, number> | undefined;
      if (rawParams !== undefined) {
        if (rawParams === null || typeof rawParams !== "object" || Array.isArray(rawParams)) {
          return sendJson(res, 400, {
            error: "invalid-params",
            detail: "params 必须是对象（参数名 → 数值）",
          });
        }
        for (const [key, value] of Object.entries(rawParams as Record<string, unknown>)) {
          if (typeof value !== "number" || !Number.isFinite(value)) {
            return sendJson(res, 400, {
              error: "invalid-params",
              detail: `参数 params.${key} 必须是数值`,
            });
          }
        }
        params = rawParams as Record<string, number>;
      }

      const outcome =
        action === "apply"
          ? await deps.gateway.applyPatch({ patchId: id, params, instanceId })
          : await deps.gateway.reapplyPatch({ patchId: id, params, instanceId });
      if (outcome.status === "ok") {
        return sendJson(res, 200, {
          status: "ok",
          result: outcome.result,
          targetPath: outcome.targetPath,
          params: outcome.params,
        });
      }
      if (outcome.status === "unknown-patch") return sendJson(res, 404, { error: "unknown-patch" });
      if (outcome.status === "invalid-params") {
        return sendJson(res, 400, { error: "invalid-params", detail: outcome.error });
      }
      if (outcome.status === "patch-conflict") {
        return sendJson(res, 409, { error: "patch-conflict", detail: outcome.error });
      }
      if (outcome.status === "config-blocked") {
        return sendJson(res, 409, { error: "config-invariants-blocked", detail: outcome.error });
      }
      return sendJson(res, 503, { error: "no-instance" });
    }

    if (path === "/api/evolution/status") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.evolution === undefined)
        return sendJson(res, 503, { error: "evolution-unavailable" });
      return sendJson(res, 200, deps.evolution.status());
    }

    if (path === "/api/evolution/preflight") {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.evolution === undefined)
        return sendJson(res, 503, { error: "evolution-unavailable" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      if (!Number.isInteger(body["holdoutCount"]) || (body["holdoutCount"] as number) < 0) {
        return sendJson(res, 400, { error: "invalid-holdout-count" });
      }
      if (body["dependencies"] !== undefined && !isStringArray(body["dependencies"])) {
        return sendJson(res, 400, { error: "invalid-dependencies" });
      }
      if (body["config"] !== undefined && !isRecord(body["config"])) {
        return sendJson(res, 400, { error: "invalid-config" });
      }
      if (body["errors"] !== undefined && !isStringArray(body["errors"])) {
        return sendJson(res, 400, { error: "invalid-errors" });
      }
      if (body["fixes"] !== undefined && !isStringArray(body["fixes"])) {
        return sendJson(res, 400, { error: "invalid-fixes" });
      }
      for (const field of ["instanceId", "endpoint", "datasetPath", "rootCause"] as const) {
        if (body[field] !== undefined && typeof body[field] !== "string") {
          return sendJson(res, 400, { error: `invalid-${field}` });
        }
      }
      const input: EvolutionPreflightInput = {
        holdoutCount: body["holdoutCount"] as number,
        ...(typeof body["instanceId"] === "string" ? { instanceId: body["instanceId"] } : {}),
        ...(isStringArray(body["dependencies"]) ? { dependencies: body["dependencies"] } : {}),
        ...(typeof body["endpoint"] === "string" ? { endpoint: body["endpoint"] } : {}),
        ...(typeof body["datasetPath"] === "string" ? { datasetPath: body["datasetPath"] } : {}),
        ...(isRecord(body["config"]) ? { config: body["config"] } : {}),
        ...(isStringArray(body["errors"]) ? { errors: body["errors"] } : {}),
        ...(typeof body["rootCause"] === "string" ? { rootCause: body["rootCause"] } : {}),
        ...(isStringArray(body["fixes"]) ? { fixes: body["fixes"] } : {}),
      };
      return sendJson(res, 200, await deps.evolution.preflight(input));
    }

    const evolutionExpandMatch = /^\/api\/evolution\/runs\/([^/]+)\/expand$/.exec(path);
    if (evolutionExpandMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.evolution === undefined)
        return sendJson(res, 503, { error: "evolution-unavailable" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      if (!Number.isInteger(body["holdoutCount"]) || (body["holdoutCount"] as number) < 0) {
        return sendJson(res, 400, { error: "invalid-holdout-count" });
      }
      if (
        body["targetCount"] !== undefined &&
        (!Number.isInteger(body["targetCount"]) || (body["targetCount"] as number) < 1)
      ) {
        return sendJson(res, 400, { error: "invalid-target-count" });
      }
      if (body["datasetPath"] !== undefined && typeof body["datasetPath"] !== "string") {
        return sendJson(res, 400, { error: "invalid-dataset-path" });
      }
      if (body["seedExamples"] !== undefined && !Array.isArray(body["seedExamples"])) {
        return sendJson(res, 400, { error: "invalid-seed-examples" });
      }
      const runId = decodeURIComponent(evolutionExpandMatch[1]!);
      const input: EvolutionExpandInput = {
        runId,
        holdoutCount: body["holdoutCount"] as number,
        ...(typeof body["targetCount"] === "number" ? { targetCount: body["targetCount"] } : {}),
        ...(typeof body["datasetPath"] === "string" ? { datasetPath: body["datasetPath"] } : {}),
        ...(Array.isArray(body["seedExamples"]) ? { seedExamples: body["seedExamples"] } : {}),
      };
      const outcome = await deps.evolution.expandDataset(input);
      if (outcome.error === "run-not-found") return sendJson(res, 404, outcome);
      if (outcome.status === "error") return sendJson(res, 400, outcome);
      return sendJson(res, 200, outcome);
    }

    const evolutionResultMatch = /^\/api\/evolution\/runs\/([^/]+)\/result$/.exec(path);
    if (evolutionResultMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.evolution === undefined)
        return sendJson(res, 503, { error: "evolution-unavailable" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      if (
        typeof body["baselineMetric"] !== "number" ||
        !Number.isFinite(body["baselineMetric"]) ||
        typeof body["candidateMetric"] !== "number" ||
        !Number.isFinite(body["candidateMetric"]) ||
        typeof body["significant"] !== "boolean"
      ) {
        return sendJson(res, 400, { error: "invalid-result" });
      }
      if (body["errors"] !== undefined && !isStringArray(body["errors"])) {
        return sendJson(res, 400, { error: "invalid-errors" });
      }
      if (body["fixes"] !== undefined && !isStringArray(body["fixes"])) {
        return sendJson(res, 400, { error: "invalid-fixes" });
      }
      if (body["rootCause"] !== undefined && typeof body["rootCause"] !== "string") {
        return sendJson(res, 400, { error: "invalid-rootCause" });
      }
      const input: EvolutionResultInput = {
        runId: decodeURIComponent(evolutionResultMatch[1]!),
        baselineMetric: body["baselineMetric"],
        candidateMetric: body["candidateMetric"],
        significant: body["significant"],
        ...(isStringArray(body["errors"]) ? { errors: body["errors"] } : {}),
        ...(typeof body["rootCause"] === "string" ? { rootCause: body["rootCause"] } : {}),
        ...(isStringArray(body["fixes"]) ? { fixes: body["fixes"] } : {}),
      };
      const outcome = await deps.evolution.recordResult(input);
      if (outcome.error === "run-not-found") return sendJson(res, 404, outcome);
      if (outcome.error === "run-not-ready") return sendJson(res, 409, outcome);
      if (outcome.status === "error") return sendJson(res, 400, outcome);
      return sendJson(res, 200, outcome);
    }

    if (path === "/api/diagnostics/report") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.renderDiagnostics === undefined)
        return sendJson(res, 503, { error: "diagnostics-unavailable" });
      const markdown = await deps.renderDiagnostics();
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
      return sendMarkdown(res, `agent-butler-diagnostic-${stamp}.md`, markdown);
    }

        const evolutionExportMatch = /^\/api\/evolution\/ledger\/([^/]+)\/export$/.exec(path);
    if (evolutionExportMatch !== null) {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.evolution === undefined)
        return sendJson(res, 503, { error: "evolution-unavailable" });
      const exported = deps.evolution.exportLedger(decodeURIComponent(evolutionExportMatch[1]!));
      if (exported === null) return sendJson(res, 404, { error: "ledger-not-found" });
      return sendMarkdown(res, exported.filename, exported.markdown);
    }

    return sendJson(res, 404, { error: "not-found" });
  } catch (error) {
    sendJson(res, 500, {
      error: "internal-error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
