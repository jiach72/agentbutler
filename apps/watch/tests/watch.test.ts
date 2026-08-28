import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandExecutor, CommandResult, PortProber } from "@butler/adapter-hermes";
import { createCore } from "@butler/core";
import {
  createWatchApp,
  withEvolutionBackup,
  type WatchApp,
} from "../src/watch.js";
import type { BackupService } from "../src/backup.js";
import type { EvolutionService } from "../src/evolution.js";
import type { FetchLike } from "../src/dashboard-signal.js";

let tmp: string;
let home: string;
let hermesRoot: string;
let app: WatchApp | undefined;
let fetchCalls: Array<{ url: string; method?: string; body?: string }>;

/** fixture 伪 hermes root：参照 hermes 适配器测试的完整形态（含 dashboard 段）。 */
function writeHermesFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "watch-fixture-hermes-"));
  mkdirSync(join(dir, "hermes-agent"), { recursive: true });
  mkdirSync(join(dir, "venv", "bin"), { recursive: true });
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "skills"), { recursive: true });
  writeFileSync(
    join(dir, "config.yaml"),
    [
      "platforms:",
      "  api_server:",
      "    extra:",
      '      host: "127.0.0.1"',
      "      port: 18642",
      '      key: "fixture-secret-key"',
      "dashboard:",
      "  port: 9119",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "hermes-agent", "pyproject.toml"),
    '[project]\nname = "hermes-agent"\nversion = "0.20.4"\n',
  );
  writeFileSync(join(dir, "venv", "bin", "python"), "");
  writeFileSync(join(dir, "logs", "agent.log"), "agent start\n");
  writeFileSync(join(dir, "logs", "gateway.log"), "gateway start\n");
  writeFileSync(join(dir, "memory_store.db"), "");
  return dir;
}

const fakeExec: CommandExecutor = {
  exec: async (cmd: string): Promise<CommandResult> => {
    if (cmd === "pgrep") return { code: 0, stdout: "4242\n", stderr: "" };
    if (cmd === "ps") return { code: 0, stdout: "40960 1.5\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  },
  spawnDetached: () => {},
};

const fakeProber: PortProber = async () => true;

/** dashboard /api/status 返回 200 JSON；gateway /api/alerts 返回 202。 */
const fakeFetch: FetchLike = async (url, init) => {
  fetchCalls.push({ url, method: init?.method, body: init?.body });
  if (url.endsWith("/api/status")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: "ok", version: "0.20.4", healthy: true }),
    };
  }
  return { ok: true, status: 202, json: async () => ({ id: 1 }) };
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "watch-smoke-"));
  home = join(tmp, "butler-home");
  hermesRoot = writeHermesFixture();
  fetchCalls = [];
});

afterEach(() => {
  app?.stop();
  app = undefined;
  rmSync(tmp, { recursive: true, force: true });
  rmSync(hermesRoot, { recursive: true, force: true });
});

describe("createWatchApp 组装冒烟", () => {
  it("检出实例进入 Serving，首轮巡检产出 inspection-completed", async () => {
    app = await createWatchApp({
      home,
      config: { hermesRoot, watchHttpPort: 0 },
      exec: fakeExec,
      prober: fakeProber,
      fetchFn: fakeFetch,
    });

    // 检出实例 + 生命周期接线到 Serving
    expect(app.instances).toHaveLength(1);
    const record = app.core.instances.getInstance(app.instances[0]!.instanceId);
    expect(record?.state).toBe("Serving");
    expect(record?.frameworkId).toBe("hermes");
    expect(record?.runtime).toBe("process");

    // 日志源注册（agent.log + gateway.log）
    expect(app.tailer.listSources().map((s) => s.id)).toEqual([
      "hermes:logs:agent.log",
      "hermes:logs:gateway.log",
    ]);

    // 首轮巡检（autoStart 立即执行）产出事件并落 events 表
    const events = app.core.store.listEvents({ type: "inspection-completed" });
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload["overall"]).toBe("healthy");
    expect(payload["confidence"]).toBe(1);
    const checks = payload["checks"] as Array<{ id: string; status: string }>;
    expect(checks.map((c) => c.id)).toEqual([
      "process-alive",
      "api-connectivity",
      "memory-probe",
      "channel-probe",
      "llm-probe",
      "stall-write",
      "resource-watermark",
      "dashboard-signal",
    ]);
    expect(checks.every((c) => c.status === "pass" || c.status === "skipped")).toBe(true);

    // dashboard 信号作为补充检查项
    const dashboard = checks.find((c) => c.id === "dashboard-signal");
    expect(dashboard?.status).toBe("pass");
    expect(dashboard?.detail).toContain("status=ok");

    // audit 记录 actor=butler-watch
    expect(app.core.audit.list({ action: "inspection", actor: "butler-watch" })).toHaveLength(1);
  });

  it("追加错误行 → tail tick 聚合指纹 → 告警转发 POST gateway", async () => {
    app = await createWatchApp({
      home,
      config: { hermesRoot, watchHttpPort: 0 },
      exec: fakeExec,
      prober: fakeProber,
      fetchFn: fakeFetch,
    });
    const alertPostsBefore = fetchCalls.filter((c) => c.url.endsWith("/api/alerts")).length;
    expect(alertPostsBefore).toBe(0); // 初始日志无错误行，无告警

    appendFileSync(
      join(hermesRoot, "logs", "agent.log"),
      "2026-08-20 12:00:00 ERROR failed to connect to postgres at /var/run/pg.sock\n",
    );
    await app.pollTail();

    // 指纹聚合事件（首见签名 alert=true，归属 hermes-main）
    const fingerprintEvents = app.core.store.listEvents({ type: "fingerprint-aggregated" });
    expect(fingerprintEvents).toHaveLength(1);
    const payload = fingerprintEvents[0]!.payload as Record<string, unknown>;
    expect(payload["alert"]).toBe(true);
    expect(payload["instanceId"]).toBe("hermes-main");
    expect(payload["count"]).toBe(1);

    // 告警转发：flush 后断言 POST /api/alerts 的 body 与 dedupeKey
    await app.forwarder.flush();
    const alertPosts = fetchCalls.filter((c) => c.url.endsWith("/api/alerts"));
    expect(alertPosts).toHaveLength(1);
    expect(alertPosts[0]!.method).toBe("POST");
    const body = JSON.parse(alertPosts[0]!.body!) as Record<string, unknown>;
    expect(body["kind"]).toBe("fingerprint");
    expect(body["severity"]).toBe("warn");
    expect(body["source"]).toBe("butler-watch");
    expect(body["dedupeKey"]).toBe(payload["signature"]);

    // 位点已提交：重复 poll 不重复聚合
    await app.pollTail();
    expect(app.core.store.listEvents({ type: "fingerprint-aggregated" })).toHaveLength(1);
  });

  it("config.autoStart=false：不自动巡检、不注册 tail 循环，可手动驱动", async () => {
    app = await createWatchApp({
      home,
      config: { hermesRoot, watchHttpPort: 0, autoStart: false },
      exec: fakeExec,
      prober: fakeProber,
      fetchFn: fakeFetch,
    });
    expect(app.scheduler.isRunning()).toBe(false);
    expect(app.core.store.listEvents({ type: "inspection-completed" })).toHaveLength(0);

    await app.scheduler.runOnce(); // 手动巡检
    expect(app.core.store.listEvents({ type: "inspection-completed" })).toHaveLength(1);
  });

  it("重启时从持久化 Discovering 状态继续协商并刷新真实根路径", async () => {
    const stale = createCore({ home });
    stale.instances.createInstance({
      instanceId: "hermes-main",
      frameworkId: "hermes",
      rootPath: "/tmp/old-hermes",
      confidence: 0.1,
    });
    stale.instances.beginDiscover("hermes-main");
    stale.close();

    app = await createWatchApp({
      home,
      config: { hermesRoot, watchHttpPort: 0, autoStart: false },
      exec: fakeExec,
      prober: fakeProber,
      fetchFn: fakeFetch,
    });

    expect(app.instances).toHaveLength(1);
    expect(app.instances[0]).toMatchObject({
      instanceId: "hermes-main",
      state: "Serving",
      rootPath: hermesRoot,
      version: "0.20.4",
    });
    expect(app.instances[0]!.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("重启后恢复已跳闸的 runbook 熔断状态", async () => {
    app = await createWatchApp({
      home,
      config: { hermesRoot, watchHttpPort: 0, autoStart: false },
      exec: fakeExec,
      prober: fakeProber,
      fetchFn: fakeFetch,
    });
    for (let i = 0; i < 5; i += 1) {
      app.breaker.recordFailure("rb-restart:hermes-main", `failure-${i}`);
    }
    expect(app.breaker.isTripped("rb-restart:hermes-main")).toBe(true);
    app.stop();
    app = undefined;

    app = await createWatchApp({
      home,
      config: { hermesRoot, watchHttpPort: 0, autoStart: false },
      exec: fakeExec,
      prober: fakeProber,
      fetchFn: fakeFetch,
    });
    expect(app.breaker.isTripped("rb-restart:hermes-main")).toBe(true);
  }, 15_000);

  it("stop 优雅停止且幂等", async () => {
    app = await createWatchApp({
      home,
      config: { hermesRoot, watchHttpPort: 0 },
      exec: fakeExec,
      prober: fakeProber,
      fetchFn: fakeFetch,
    });
    expect(app.core.store.listEvents({ type: "inspection-completed" })).toHaveLength(1);
    expect(app.scheduler.isRunning()).toBe(true);
    app.stop();
    expect(app.scheduler.isRunning()).toBe(false);
    app.stop(); // 幂等不抛异常
  }, 15_000);
});

describe("进化前备份门禁", () => {
  it("备份失败时拒绝且不调用真实进化预检", async () => {
    const core = createCore({ home: join(tmpdir(), "watch-evolution-backup-gate") });
    let preflightCalls = 0;
    const evolution = {
      status: () => ({
        minHoldoutCount: 10,
        defaultDependencies: [],
        defaultEndpoint: "",
        ledger: [],
      }),
      preflight: async () => {
        preflightCalls += 1;
        throw new Error("should not run");
      },
      expandDataset: async () => {
        throw new Error("unused");
      },
      recordResult: async () => {
        throw new Error("unused");
      },
      promoteArtifact: () => ({
        status: "error" as const,
        error: "authority-not-found" as const,
        detail: "unused",
        ledgerPath: null,
      }),
      exportLedger: () => null,
    } satisfies EvolutionService;
    const backup = {
      run: async () => {
        throw new Error("disk full");
      },
    } as unknown as BackupService;
    const wrapped = withEvolutionBackup(evolution, backup, core);
    const outcome = await wrapped.preflight({ holdoutCount: 10 });
    expect(outcome).toMatchObject({ status: "rejected-preflight", allowRun: false });
    expect(outcome.checks[0]).toMatchObject({ id: "snapshot", status: "fail" });
    expect(preflightCalls).toBe(0);
    expect(core.audit.list({ action: "preflight", actor: "evolution" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ detail: expect.objectContaining({ reason: "prebackup-failed" }) }),
      ]),
    );
    core.close();
  });
});

describe("Task 7 自动 runbook 触发", () => {
  it("memory-probe fail → 自动触发 rb-restart（事件+审计）；防抖窗口内第二轮不重复", async () => {
    // ① memory_store.db 写入非 SQLite 格式字节 → 探针打开/勘察失败 → memory-probe fail
    //    （SQLite 对只读文件会降级只读打开，故用损坏内容制造 fail）。
    writeFileSync(
      join(hermesRoot, "memory_store.db"),
      "this is definitely not a sqlite database file",
    );
    // ② 移除 venv 证据：控制面 isAlive 退化为 pgrep-only（无进程 → stop 幂等成功）、
    //    start 无 venv 入口立即失败 → restart 步骤快速失败，runbook 不陷入 30s 存活轮询。
    //    检测置信度仍 0.9（目录+config+pyproject+探活）≥ 0.6，实例照常进入 Serving。
    rmSync(join(hermesRoot, "venv"), { recursive: true, force: true });
    // process-alive 走实例 rootPath 下的 hermes-agent 路径命中；其余 pgrep 无进程。
    const hermesOnlyExec: CommandExecutor = {
      exec: async (cmd, args) => {
        if (cmd === "pgrep" && args[1]?.endsWith("hermes-agent"))
          return { code: 0, stdout: "4242\n", stderr: "" };
        if (cmd === "ps") return { code: 0, stdout: "40960 1.5\n", stderr: "" };
        return { code: 1, stdout: "", stderr: "" };
      },
      spawnDetached: () => {},
    };
    app = await createWatchApp({
      home,
      config: { hermesRoot, watchHttpPort: 0 },
      exec: hermesOnlyExec,
      prober: fakeProber,
      fetchFn: fakeFetch,
    });

    // 首轮巡检（start 立即执行）：memory-probe fail → rb-restart 自动执行
    const started = app.core.store.listEvents({ type: "runbook-started" });
    expect(started).toHaveLength(1);
    expect(started[0]!.payload).toMatchObject({
      runbookId: "rb-restart",
      instanceId: app.instances[0]!.instanceId,
      trigger: "auto",
    });
    expect(app.core.store.listEvents({ type: "runbook-completed" })).toHaveLength(1);

    // 独立关键探针必须先将失败送入持久告警队列，再尝试自动修复。
    await app.alertPoster.flush();
    const criticalAlerts = fetchCalls
      .filter((call) => call.url.endsWith("/api/alerts"))
      .map((call) => JSON.parse(call.body ?? "{}") as Record<string, unknown>);
    expect(criticalAlerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "critical-memory-probe",
          severity: "critical",
          source: "butler-watch",
          dedupeKey: "critical-memory-probe:hermes-main",
        }),
      ]),
    );
    const probeAudit = app.core.audit.list({ action: "critical-memory-probe", target: "hermes-main" });
    expect(probeAudit[0]?.detail).toEqual(
      expect.objectContaining({ observedAt: expect.any(String), source: "independent-sla-scheduler" }),
    );
    expect(app.core.audit.list({ action: "critical-memory-alert-queued", target: "hermes-main" })).toHaveLength(1);

    // runbook 执行留痕（actor "runbook" 的整体审计，含 runbookId）
    const runbookAudits = app.core.audit
      .list({ action: "runbook" })
      .filter((a) => a.actor === "runbook");
    expect(runbookAudits.length).toBeGreaterThanOrEqual(1);

    // 第二轮巡检：memory-probe 仍 fail，但防抖窗口（默认 15min）内不重复自动触发
    await app.scheduler.runOnce();
    expect(app.core.store.listEvents({ type: "runbook-started" })).toHaveLength(1);

    // 巡检后处理失败不阻断巡检循环：第二轮巡检事件正常产出
    expect(app.core.store.listEvents({ type: "inspection-completed" })).toHaveLength(2);
  });

  it("runbookAuto=false 时关键探针失败仍立即进入告警队列", async () => {
    writeFileSync(join(hermesRoot, "memory_store.db"), "not-a-sqlite-database");
    const hermesOnlyExec: CommandExecutor = {
      exec: async (cmd, args) => {
        if (cmd === "pgrep" && args?.[1]?.endsWith("hermes-agent"))
          return { code: 0, stdout: "4242\n", stderr: "" };
        if (cmd === "ps") return { code: 0, stdout: "40960 1.5\n", stderr: "" };
        return { code: 1, stdout: "", stderr: "" };
      },
      spawnDetached: () => {},
    };
    app = await createWatchApp({
      home,
      config: { hermesRoot, watchHttpPort: 0, autoStart: false, runbookAuto: false },
      exec: hermesOnlyExec,
      prober: fakeProber,
      fetchFn: fakeFetch,
    });

    await app.criticalScheduler.start();
    await app.alertPoster.flush();
    expect(app.core.store.listEvents({ type: "runbook-started" })).toHaveLength(0);
    const alerts = fetchCalls
      .filter((call) => call.url.endsWith("/api/alerts"))
      .map((call) => JSON.parse(call.body ?? "{}") as Record<string, unknown>);
    expect(alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "critical-memory-probe", severity: "critical" }),
      ]),
    );
  });
});

describe("管家自身日志源", () => {
  it("/api/logs 返回管家自身 journald 来源并可读取尾部", async () => {
    app = await createWatchApp({
      home,
      config: { hermesRoot, watchHttpPort: 0 },
      exec: fakeExec,
      prober: fakeProber,
      fetchFn: fakeFetch,
    });
    const addr = app.watchHttp.address();
    expect(addr).not.toBeNull();
    const base = "http://127.0.0.1:" + (addr?.port ?? 0);

    const listRes = await fetch(base + "/api/logs");
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { sources: Array<{ id: string }> };
    const ids = list.sources.map((s) => s.id);
    expect(ids).toContain("butler:watch");
    expect(ids).toContain("butler:web");
    expect(ids).toContain("butler:gateway");
    expect(ids).toContain("butler:vite");
    expect(ids).toContain("hermes:logs:agent.log");

    const tailRes = await fetch(base + "/api/logs/" + encodeURIComponent("butler:watch") + "?limit=20");
    expect(tailRes.status).toBe(200);
    const tail = (await tailRes.json()) as {
      sourceId: string;
      format: string;
      lines: string[];
      error?: string;
    };
    expect(tail.sourceId).toBe("butler:watch");
    expect(tail.format).toBe("journald");
    expect(Array.isArray(tail.lines)).toBe(true);
    // 测试环境未必有 systemd 用户日志；有则应有行，无则应带可读错误
    if (tail.error !== undefined) {
      expect(tail.lines).toHaveLength(0);
    }
  });
});

describe("系统日志分页（PRD M1）", () => {
  it("文件日志支持 before 游标向前翻页并回到最新", async () => {
    const logPath = join(hermesRoot, "logs", "agent.log");
    const lines: string[] = [];
    for (let index = 0; index < 600; index += 1) {
      lines.push(`paged-line-${String(index).padStart(3, "0")}`);
    }
    appendFileSync(logPath, lines.join("\n") + "\n");
    app = await createWatchApp({
      home,
      config: { hermesRoot, watchHttpPort: 0 },
      exec: fakeExec,
      prober: fakeProber,
      fetchFn: fakeFetch,
    });
    const addr = app.watchHttp.address();
    expect(addr).not.toBeNull();
    const base = "http://127.0.0.1:" + (addr?.port ?? 0);
    const source = encodeURIComponent("hermes:logs:agent.log");
    const pageUrl = (before?: number): string =>
      `${base}/api/logs/${source}?limit=100${before === undefined ? "" : `&before=${before}`}`;

    const newest = (await (await fetch(pageUrl())).json()) as {
      lines: string[];
      pageStart: number | null;
      hasOlder: boolean;
      hasNewer: boolean;
      totalLines: number;
    };
    expect(newest.lines).toHaveLength(100);
    expect(newest.lines[0]).toBe("paged-line-500");
    expect(newest.lines[99]).toBe("paged-line-599");
    expect(newest.hasOlder).toBe(true);
    expect(newest.hasNewer).toBe(false);
    expect(newest.pageStart).toBeTypeOf("number");

    const older = (await (await fetch(pageUrl(newest.pageStart!))).json()) as {
      lines: string[];
      hasOlder: boolean;
      hasNewer: boolean;
    };
    expect(older.lines).toHaveLength(100);
    expect(older.lines[0]).toBe("paged-line-400");
    expect(older.lines[99]).toBe("paged-line-499");
    expect(older.hasOlder).toBe(true);
    expect(older.hasNewer).toBe(true);
  });
});
