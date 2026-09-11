/**
 * M2.1 Agent 周报测试：
 * - 周锚点计算（weekStartOf 本地周一 + 周日边界）；
 * - runFor 组装/Markdown/幂等 upsert；成本 14 天视图按周界切片；
 * - 推送（severity info + dedupeKey 幂等）与失败落库；
 * - 调度 tick：过点触发一次、重复 tick 不重放；
 * - HTTP 端点契约（/api/trust/report*）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "@butler/core";
import { createTrustEventHub, type TrustEventHub } from "../src/trust-events.js";
import { createWeeklyReportService, weekStartOf, addDaysIso, type WeeklyReportService, type WeeklyReportPoster, type WeeklyReportData } from "../src/weekly-report.js";
import type { LlmUsageService, CostSummaryView } from "../src/llm-usage.js";
import type { SkillAssetService } from "../src/skill-assets.js";
import type { BackupService } from "../src/backup.js";
import { startWatchHttp, type WatchHttp, type WatchHttpDeps } from "../src/http.js";
import type { GatewayPanelService } from "../src/gateway-stats.js";
import type { UpgradeService } from "../src/upgrade.js";

let tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "butler-report-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    } catch {
      // Windows SQLite 句柄延迟释放；临时目录由操作系统回收
    }
  }
});

const upgradeStub: UpgradeService = {
  startUpgrade: () => ({ status: "missing-target-version" }),
  status: () => null,
  listVersions: async () => ({ reachable: false, versions: [] }),
  rollbackSnapshot: async () => ({ status: "snapshot-not-found" }),
};
const gatewayStub: GatewayPanelService = {
  stats: async () => ({ overall: "ok", totalEvents: 0, last24h: 0, matched: [], suggestions: [] }),
  patches: async () => [],
  applyPatch: async () => ({ status: "no-instance" }),
  reapplyPatch: async () => ({ status: "no-instance" }),
  detectPatch: async () => ({ status: "no-instance" }),
};

/** 固定「现在是 2026-09-09 周三 10:00 本地时间」。 */
const FIXED_NOW = new Date("2026-09-09T10:00:00").getTime();

function makeCostStub(): LlmUsageService {
  const view: CostSummaryView = {
    rangeDays: 14,
    costAvailable: true,
    total: { estimatedUsd: 3.5, actualUsd: 8.5, verifiedUsd: 7.0 },
    days: [
      { date: "2026-08-28", tokens: 0, estimatedCostUsd: null, actualCostUsd: null },
      { date: "2026-08-31", tokens: 0, estimatedCostUsd: null, actualCostUsd: 4.0 },
      { date: "2026-09-05", tokens: 0, estimatedCostUsd: 1.0, actualCostUsd: null },
      { date: "2026-09-07", tokens: 0, estimatedCostUsd: null, actualCostUsd: 1.0 },
      { date: "2026-09-08", tokens: 0, estimatedCostUsd: null, actualCostUsd: 2.0 },
      { date: "2026-09-09", tokens: 0, estimatedCostUsd: 0.5, actualCostUsd: null },
    ],
    models: [{ model: "gpt-x", tokens: 1000, estimatedCostUsd: 3.5, actualCostUsd: 8.5, verifiedUsd: 7.0, days: [] }],
    sessions: [
      { sessionId: "sess-1", model: "gpt-x", lastSeen: "2026-09-09T00:00:00.000Z", tokens: 1000, estimatedCostUsd: 0.24, actualCostUsd: 0.1 },
    ],
  };
  return {
    usage: async () => null,
    costSummary: async () => view,
    monthToDateCost: async () => ({ estimatedUsd: null, actualUsd: 12, verifiedUsd: 10, month: "2026-09" }),
  };
}

const skillStub = {
  usage: async () => ({
    rangeDays: 7,
    granularity: "week" as const,
    coverage: { from: "2026-09-03", to: "2026-09-09", days: 7, source: "test", complete: true },
    series: [],
    skills: [
      { name: "deep-research", calls: 52, lastUsedAt: null, successRate: 0.9, avgDurationMs: null, status: "known" as const },
      { name: "sparse", calls: 3, lastUsedAt: null, successRate: null, avgDurationMs: null, status: "known" as const },
    ],
    notice: "",
  }),
} as unknown as SkillAssetService;

const backupStub = {
  list: () => [{ id: 7, kind: "full", createdAt: "2026-09-08T03:00:00.000Z" }],
} as unknown as BackupService;

interface Posted {
  kind: string;
  severity: string;
  title: string;
  dedupeKey: string;
}
function makePoster(fail: boolean): { poster: WeeklyReportPoster; posted: Posted[] } {
  const posted: Posted[] = [];
  const poster: WeeklyReportPoster = {
    post: async (body) => {
      if (fail) throw new Error("gateway down");
      posted.push({ kind: body.kind, severity: body.severity, title: body.title, dedupeKey: body.dedupeKey });
    },
  };
  return { poster, posted };
}

function makeService(fail = false) {
  const dir = makeTempDir();
  const store = new SqliteStore(join(dir, "butler.db"));
  const trustEvents: TrustEventHub = createTrustEventHub({ store });
  trustEvents.record({ kind: "fingerprint", severity: "critical", title: "升级疑似回归", dedupeKey: "fp-regression" });
  const { poster, posted } = makePoster(fail);
  let nowMs = FIXED_NOW;
  const service: WeeklyReportService = createWeeklyReportService({
    store,
    llmUsage: makeCostStub(),
    skillAssets: skillStub,
    backup: backupStub,
    trustEvents,
    monthlyBudgetUsd: 100,
    poster,
    now: () => nowMs,
    driver: { setInterval: () => 0, clearInterval: () => undefined },
    intervalMs: 60_000,
  });
  return { service, store, posted, trustEvents, setNow: (ms: number) => (nowMs = ms) };
}

describe("周锚点", () => {
  it("weekStartOf 返回本地周一；周日归上周一", () => {
    expect(weekStartOf(new Date("2026-09-09T10:00:00").getTime())).toBe("2026-09-07"); // 周三
    expect(weekStartOf(new Date("2026-09-07T00:00:00").getTime())).toBe("2026-09-07"); // 周一当天
    expect(weekStartOf(new Date("2026-09-13T23:00:00").getTime())).toBe("2026-09-07"); // 周日 → 本周周一
    expect(addDaysIso("2026-09-07", 6)).toBe("2026-09-13");
    expect(addDaysIso("2026-09-01", -1)).toBe("2026-08-31"); // 跨月
  });
});

describe("周报组装与幂等", () => {
  it("runFor：成本按周界切片（本周 3.50 / 上周 5.00 / 环比 -30%）+ Markdown 段落齐全", async () => {
    const { service, store } = makeService();
    const row = await service.runFor();
    expect(row.weekStart).toBe("2026-09-07");
    expect(row.weekEnd).toBe("2026-09-13");
    const data = JSON.parse(row.dataJson) as WeeklyReportData;
    expect(data.cost.available).toBe(true);
    expect(data.cost.thisWeekUsd).toBeCloseTo(3.5, 5);
    expect(data.cost.lastWeekUsd).toBeCloseTo(5.0, 5);
    expect(data.cost.deltaPct).toBeCloseTo(-30, 5);
    expect(data.cost.monthSpentUsd).toBeCloseTo(12, 5);
    expect(data.instances.total).toBe(0);
    expect(data.events.active).toBe(1);
    expect(data.events.critical).toBe(1);
    expect(data.audit.enabled).toBe(false);
    expect(data.skills.top[0]?.name).toBe("deep-research");
    expect(data.backups.count).toBe(1);
    expect(row.markdown).toContain("Agent 周报（2026-09-07 ~ 2026-09-13）");
    expect(row.markdown).toContain("本周 $3.50");
    expect(row.markdown).toContain("-30%");
    expect(row.markdown).toContain("月度预算 $100.00 已用 $12.00（12%）");
    expect(row.markdown).toContain("审计采集器未启用");
    expect(row.markdown).toContain("[critical] 升级疑似回归");
    // 事件中心留痕。
    expect(store.listReports(12)).toHaveLength(1);
    void store;
  });

  it("同周重复生成幂等覆盖（不新增行）", async () => {
    const { service, store } = makeService();
    await service.runFor();
    const second = await service.runFor();
    expect(store.listReports(12)).toHaveLength(1);
    expect(second.status).toBe("generated");
  });

  it("推送：severity info + dedupeKey 幂等键 + 状态 sent；失败落 send-failed", async () => {
    const ok = makeService(false);
    const row = await ok.service.runFor(undefined, { push: true });
    expect(ok.posted).toHaveLength(1);
    expect(ok.posted[0]?.severity).toBe("info");
    expect(ok.posted[0]?.kind).toBe("weekly-report");
    expect(ok.posted[0]?.dedupeKey).toBe("weekly-report:2026-09-07");
    expect(ok.store.getReport(row.id)?.status).toBe("sent");
    expect(ok.store.getReport(row.id)?.sentAt).not.toBeNull();

    const bad = makeService(true);
    const row2 = await bad.service.runFor(undefined, { push: true });
    expect(bad.posted).toHaveLength(0);
    expect(bad.store.getReport(row2.id)?.status).toBe("send-failed");
  });
});

describe("调度 tick", () => {
  it("周一 08:00 前不触发；过点触发一次；重复 tick 不重放", async () => {
    const { service, posted, setNow } = makeService();
    const monday07 = new Date("2026-09-07T07:30:00").getTime();
    const monday0830 = new Date("2026-09-07T08:30:00").getTime();
    const monday09 = new Date("2026-09-07T09:00:00").getTime();
    setNow(monday07);
    await expect(service.tick()).resolves.toBe(false);
    expect(posted).toHaveLength(0);
    setNow(monday0830);
    await expect(service.tick()).resolves.toBe(true);
    expect(posted).toHaveLength(1);
    setNow(monday09);
    await expect(service.tick()).resolves.toBe(false);
    expect(posted).toHaveLength(1);
  });

  it("过点前手动生成过的记录会被过点 tick 重生成覆盖（08:00 时点数据为准）", async () => {
    const { service, posted, setNow } = makeService();
    const sunday = new Date("2026-09-06T20:00:00").getTime(); // 上周日：同 weekStart（09-07 所在周？否——周日属于上一周）
    void sunday;
    const monday07 = new Date("2026-09-07T07:00:00").getTime();
    setNow(monday07);
    await service.runFor(); // 过点前手动生成
    expect(posted).toHaveLength(0);
    const monday0830 = new Date("2026-09-07T08:30:00").getTime();
    setNow(monday0830);
    await expect(service.tick()).resolves.toBe(true);
    expect(posted).toHaveLength(1);
  });
});

describe("周报 HTTP 端点", () => {
  let http: WatchHttp;
  let base: string;
  let cleanup: (() => void) | null = null;

  const boot = async () => {
    const { service, store } = makeService();
    const deps: WatchHttpDeps = {
      scheduler: {
        runNow: () => true,
        status: () => ({ lastAt: null, nextAt: null, intervalMin: 5, inFlight: false }),
      },
      runbooks: () => [],
      executeRunbook: async () => ({ status: "started", instanceId: "hermes-a" }),
      upgrade: upgradeStub,
      gateway: gatewayStub,
      llmUsage: makeCostStub(),
      weeklyReport: service,
    };
    cleanup = () => store.close();
    http = startWatchHttp(deps, { port: 0 });
    const addr = await http.start();
    base = `http://127.0.0.1:${addr.port}`;
  };

  afterEach(() => {
    http?.close();
    cleanup?.();
    cleanup = null;
  });

  it("GET /api/trust/report → 本周实时视图；未接线 → 503", async () => {
    await boot();
    const res = await fetch(`${base}/api/trust/report`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { weekStart: string; data: WeeklyReportData; markdown: string };
    expect(body.weekStart).toBe("2026-09-07");
    expect(body.data.cost.thisWeekUsd).toBeCloseTo(3.5, 5);
    expect(body.markdown).toContain("Agent 周报");
  });

  it("run → history → :id 全链路；未知 id 404", async () => {
    await boot();
    const run = await fetch(`${base}/api/trust/report/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ push: false }),
    });
    expect(run.status).toBe(200);
    const runBody = (await run.json()) as { report: { id: number } };
    const history = await fetch(`${base}/api/trust/report/history?limit=12`);
    expect(history.status).toBe(200);
    const historyBody = (await history.json()) as { reports: Array<{ id: number; markdown?: string }> };
    expect(historyBody.reports).toHaveLength(1);
    expect(historyBody.reports[0]?.markdown).toBeUndefined(); // 列表不含正文
    const detail = await fetch(`${base}/api/trust/report/${runBody.report.id}`);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { report: { data: WeeklyReportData | null } };
    expect(detailBody.report.data?.cost.thisWeekUsd).toBeCloseTo(3.5, 5);
    const missing = await fetch(`${base}/api/trust/report/999999`);
    expect(missing.status).toBe(404);
  });
});
