/**
 * 升级服务测试（Task 13.1/13.2 butler-watch 侧）：
 * - 五步流水线接线（成功路径 / 失败自动回滚 / 回滚失败 / 在飞 E202）；
 * - 审计（upgrade-start/done/failed/rollback）与 job-event 落库；
 * - 完成通知 60s 冷却 + 队列合并（fake 时钟推进窗口）；
 * - 失败/回滚 critical 立即投递不走冷却；
 * - 熔断联动（recordJobFailure / recordSuccess）；
 * - 版本源逐源探测（GitHub → 镜像 → Docker Hub，fetch 全注入）；
 * - 快照回滚（ok / snapshot-not-found / no-servicing-instance）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandExecutor, UpgradeControl } from "@butler/adapter-hermes";
import { fail, ok, type ControlAck, type Job, type Result } from "@butler/contract";
import { createCore, type Core } from "@butler/core";
import type { AlertPoster, GatewayAlertBody } from "../src/alert-forward.js";
import type { FetchLike } from "../src/dashboard-signal.js";
import type { InspectionStage } from "../src/pipeline.js";
import {
  createUpgradeService,
  UPGRADE_DONE_ACTION,
  UPGRADE_DONE_KIND,
  UPGRADE_FAILED_ACTION,
  UPGRADE_FAILED_KIND,
  UPGRADE_ROLLBACK_ACTION,
  UPGRADE_ROLLBACK_KIND,
  UPGRADE_START_ACTION,
  type UpgradeBreaker,
  type UpgradeService,
} from "../src/upgrade.js";

const CURRENT_VERSION = "0.20.4";
const TARGET_VERSION = "0.21.0";
const INSTANCE_ID = "ins1";
const NOTIFY_COOLDOWN_MS = 60_000;

/** 可推进 fake 时钟（升级流水线 job 时间戳 + 冷却窗共用）。 */
class FakeClock {
  private t = 1_800_000_000_000;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

interface Harness {
  core: Core;
  service: UpgradeService;
  clock: FakeClock;
  posts: GatewayAlertBody[];
  breakerEvents: Array<{ type: "fail" | "success"; key: string }>;
  rollbackCalls: Array<{ instanceId: string; snapshotId: string }>;
  setRollbackOutcome(result: Result<Job>): void;
}

function stageOf(id: string, status: "pass" | "fail" | "warn" | "skipped"): InspectionStage {
  return { id, label: id, async run() { return { id, status }; } };
}

function ackOf(action: "start" | "stop"): ControlAck {
  return { instanceId: INSTANCE_ID, action, startedAt: "2026-08-20T00:00:00.000Z" };
}

let tmp: string;
let hermesRoot: string;
let harness: Harness;

/** hermes 实例目录夹具：hermes-agent/pyproject.toml + venv/bin/python（precheck 依赖）。 */
function writeHermesFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "watch-upgrade-hermes-"));
  mkdirSync(join(dir, "hermes-agent"), { recursive: true });
  mkdirSync(join(dir, "venv", "bin"), { recursive: true });
  writeFileSync(join(dir, "hermes-agent", "pyproject.toml"), `[project]\nname = "hermes-agent"\nversion = "${CURRENT_VERSION}"\n`);
  writeFileSync(join(dir, "venv", "bin", "python"), "");
  return dir;
}

function makeHarness(
  stages: InspectionStage[],
  opts: { fetchFn?: FetchLike; versionMirrorHost?: string } = {},
): Harness {
  const core = createCore({ home: tmp });
  // Serving 实例（升级目标解析：显式 id 或首个 Serving）。
  core.instances.createInstance({
    instanceId: INSTANCE_ID,
    frameworkId: "hermes",
    runtime: "process",
    rootPath: hermesRoot,
    version: CURRENT_VERSION,
    confidence: 0.9,
  });
  core.instances.beginDiscover(INSTANCE_ID);
  core.instances.confirmInstance(INSTANCE_ID, "auto");
  core.instances.beginNegotiate(INSTANCE_ID);
  core.instances.markServing(INSTANCE_ID, 0);

  const clock = new FakeClock();
  const posts: GatewayAlertBody[] = [];
  const poster: AlertPoster = {
    post: async (body) => {
      posts.push(body);
    },
    flush: async () => {},
  };
  const breakerEvents: Harness["breakerEvents"] = [];
  const breaker: UpgradeBreaker = {
    recordJobFailure: (key) => {
      breakerEvents.push({ type: "fail", key });
      return undefined;
    },
    recordSuccess: (key) => {
      breakerEvents.push({ type: "success", key });
    },
  };

  // 拉取后版本复核：fake pip 成功即视 pyproject 已改写为目标版本。
  let currentVersion = CURRENT_VERSION;
  const fakeExec: CommandExecutor = {
    exec: async (cmd, args) => {
      const m = /==([\w.-]+)$/.exec(args?.[args.length - 1] ?? "");
      if (cmd.endsWith("python") && m) currentVersion = m[1]!;
      return { code: 0, stdout: "", stderr: "" };
    },
    spawnDetached: () => {},
  };
  const readFile = async (p: string): Promise<string> => {
    if (p.endsWith("pyproject.toml")) {
      return `[project]\nname = "hermes-agent"\nversion = "${currentVersion}"\n`;
    }
    return "";
  };

  // 控制门面：snapshot 登记行落 store（流水线取最新行的 scope.snapshotId）。
  let snapSeq = 0;
  let rbSeq = 0;
  const rollbackCalls: Harness["rollbackCalls"] = [];
  let rollbackOutcome: Result<Job> = ok({
    jobId: `job-rb-${++rbSeq}`,
    kind: "rollback",
    steps: [{ id: "restore-code", label: "恢复代码", status: "passed" }],
  });
  const control: UpgradeControl = {
    stop: async () => ok(ackOf("stop")),
    start: async () => ok(ackOf("start")),
    snapshot: async (instance, scope) => {
      snapSeq += 1;
      core.store.insertSnapshot({
        instance: instance.instanceId,
        scope: { snapshotId: `snap-${snapSeq}`, include: scope.include },
        label: scope.label,
      });
      return ok({
        jobId: `job-snap-${snapSeq}`,
        kind: "snapshot",
        steps: [{ id: "copy-code", label: "拷贝代码", status: "passed" }],
      });
    },
    rollback: async (instance, ref) => {
      rollbackCalls.push({ instanceId: instance.instanceId, snapshotId: ref.snapshotId });
      return rollbackOutcome.ok ? { ...rollbackOutcome } : rollbackOutcome;
    },
  };

  const service = createUpgradeService({
    core,
    control,
    stages,
    poster,
    breaker,
    fetchFn: opts.fetchFn,
    exec: fakeExec,
    readFile,
    now: () => clock.now(),
    notifyCooldownMs: NOTIFY_COOLDOWN_MS,
    versionMirrorHost: opts.versionMirrorHost,
  });

  return {
    core,
    service,
    clock,
    posts,
    breakerEvents,
    rollbackCalls,
    setRollbackOutcome: (result) => {
      rollbackOutcome = result;
    },
  };
}

/** 轮询等待升级 Job 收敛到终态（running → done/failed）。 */
async function waitTerminal(service: UpgradeService): Promise<NonNullable<ReturnType<UpgradeService["status"]>>> {
  for (let i = 0; i < 200; i += 1) {
    const view = service.status();
    if (view !== null && (view.status === "done" || view.status === "failed")) return view;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("upgrade job did not reach terminal state");
}

function auditsOf(action: string): Array<Record<string, unknown>> {
  return harness.core.audit
    .list({ action, target: INSTANCE_ID })
    .map((a) => (a.detail ?? {}) as Record<string, unknown>);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "watch-upgrade-"));
  hermesRoot = writeHermesFixture();
});

afterEach(() => {
  harness?.core.close();
  rmSync(tmp, { recursive: true, force: true });
  rmSync(hermesRoot, { recursive: true, force: true });
});

describe("createUpgradeService（startUpgrade）", () => {
  it("成功路径：五步 passed/skipped、审计 start+done、job-event 落库、熔断 recordSuccess", async () => {
    harness = makeHarness([
      stageOf("process-alive", "pass"),
      stageOf("api-connectivity", "pass"),
      stageOf("channel-probe", "pass"),
    ]);
    const outcome = harness.service.startUpgrade({ targetVersion: TARGET_VERSION, channel: "stable", trigger: "manual" });
    expect(outcome).toMatchObject({ status: "started", instanceId: INSTANCE_ID });
    if (outcome.status !== "started") throw new Error("expected started");
    expect(outcome.jobId).toBeTypeOf("string");

    const view = await waitTerminal(harness.service);
    expect(view.status).toBe("done");
    expect(view.rolledBack).toBeUndefined();
    expect(view.steps.map((s) => `${s.id}:${s.status}`)).toEqual([
      "precheck:passed",
      "snapshot:passed",
      "pull:passed",
      "patches:skipped", // 无已登记补丁
      "verify:passed",
    ]);
    expect(view.snapshotId).toBe("snap-1");

    // 审计：upgrade-start（含 jobId/targetVersion）+ upgrade-done
    const startAudits = auditsOf(UPGRADE_START_ACTION);
    expect(startAudits).toHaveLength(1);
    expect(startAudits[0]).toMatchObject({ jobId: view.jobId, targetVersion: TARGET_VERSION, trigger: "manual" });
    const doneAudits = auditsOf(UPGRADE_DONE_ACTION);
    expect(doneAudits).toHaveLength(1);
    expect(doneAudits[0]).toMatchObject({ jobId: view.jobId, targetVersion: TARGET_VERSION });

    // job-event 落库（初始 + 每步变化 + 终态；kind upgrade、jobId 一致）
    const events = harness.core.store.listEvents({ type: "job-event" });
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect((e.payload as { job: { kind: string } }).job.kind).toBe("upgrade");
    }
    const finalEvent = events.find((e) => {
      const job = (e.payload as { job: { jobId: string; steps: Array<{ id: string; status: string }> } }).job;
      return job.jobId === view.jobId && job.steps.some((s) => s.id === "verify" && s.status === "passed");
    });
    expect(finalEvent).toBeDefined();

    // 熔断联动：成功 → recordSuccess（key upgrade:<instanceId>）
    expect(harness.breakerEvents).toEqual([{ type: "success", key: `upgrade:${INSTANCE_ID}` }]);
  });

  it("入参校验：空 targetVersion → missing-target-version；非 Serving/未知实例 → no-servicing-instance", () => {
    harness = makeHarness([]);
    expect(harness.service.startUpgrade({ targetVersion: "  " })).toEqual({ status: "missing-target-version" });
    expect(harness.service.startUpgrade({ instanceId: "no-such", targetVersion: TARGET_VERSION })).toEqual({
      status: "no-servicing-instance",
    });

    // 仅 Registered（未走生命周期）的实例不可升级。
    harness.core.instances.createInstance({ instanceId: "ins-raw", frameworkId: "hermes", rootPath: hermesRoot });
    expect(harness.service.startUpgrade({ instanceId: "ins-raw", targetVersion: TARGET_VERSION })).toEqual({
      status: "no-servicing-instance",
    });
  });

  it("在飞判定：流水线执行中再次发起 → upgrade-in-flight（E202）", async () => {
    harness = makeHarness([
      stageOf("process-alive", "pass"),
      stageOf("api-connectivity", "pass"),
      stageOf("channel-probe", "pass"),
    ]);
    const first = harness.service.startUpgrade({ targetVersion: TARGET_VERSION });
    expect(first.status).toBe("started");
    // 第二次发起在同一同步块内：流水线 active 已置位（首个 await 前即建档）。
    const second = harness.service.startUpgrade({ targetVersion: "0.22.0" });
    expect(second).toEqual({ status: "upgrade-in-flight" });

    const view = await waitTerminal(harness.service);
    expect(view.status).toBe("done");
  });

  it("失败自动回滚：verify 不通过 → rollback 步骤 passed、rolledBack=true、失败 critical 立即投递、熔断 recordJobFailure", async () => {
    harness = makeHarness([
      stageOf("process-alive", "pass"),
      stageOf("api-connectivity", "pass"),
      stageOf("channel-probe", "fail"),
    ]);
    const outcome = harness.service.startUpgrade({ targetVersion: TARGET_VERSION });
    expect(outcome.status).toBe("started");

    const view = await waitTerminal(harness.service);
    expect(view.status).toBe("failed");
    expect(view.rolledBack).toBe(true);
    expect(view.error ?? "").toContain("健康验收");
    const rollbackStep = view.steps.find((s) => s.id === "rollback");
    expect(rollbackStep?.status).toBe("passed");

    // 回滚目标为升级前快照
    expect(harness.rollbackCalls).toEqual([{ instanceId: INSTANCE_ID, snapshotId: "snap-1" }]);

    // 审计 upgrade-failed（含 rolledBack）
    const failedAudits = auditsOf(UPGRADE_FAILED_ACTION);
    expect(failedAudits).toHaveLength(1);
    expect(failedAudits[0]).toMatchObject({ jobId: view.jobId, rolledBack: true });

    // 失败 critical 立即投递（不走冷却）
    expect(harness.posts).toHaveLength(1);
    expect(harness.posts[0]).toMatchObject({ kind: UPGRADE_FAILED_KIND, severity: "critical", source: "butler-watch" });
    expect(harness.posts[0]!.title).toContain(INSTANCE_ID);

    // 熔断联动：失败 → recordJobFailure
    expect(harness.breakerEvents).toEqual([{ type: "fail", key: `upgrade:${INSTANCE_ID}` }]);
  });

  it("回滚失败（E204）：rollback 步骤 failed、rolledBack 缺失、告警提示需人工介入", async () => {
    harness = makeHarness([stageOf("channel-probe", "fail")]);
    harness.setRollbackOutcome(fail("E204", "snapshot dir missing", { userHint: "快照目录缺失" }));
    harness.service.startUpgrade({ targetVersion: TARGET_VERSION });

    const view = await waitTerminal(harness.service);
    expect(view.status).toBe("failed");
    expect(view.rolledBack).toBeUndefined();
    expect(view.steps.find((s) => s.id === "rollback")?.status).toBe("failed");
    expect(view.error ?? "").toContain("人工介入");
    expect(harness.posts).toHaveLength(1); // 失败 critical 仍立即投递
  });
});

describe("createUpgradeService（完成通知冷却 + 队列合并）", () => {
  it("done 不立即投递；冷却窗到期后经任意入口懒触发投递一条", async () => {
    harness = makeHarness([
      stageOf("process-alive", "pass"),
      stageOf("api-connectivity", "pass"),
      stageOf("channel-probe", "pass"),
    ]);
    harness.service.startUpgrade({ targetVersion: TARGET_VERSION });
    await waitTerminal(harness.service);
    expect(harness.posts).toHaveLength(0); // 窗口内不投递

    harness.clock.advance(NOTIFY_COOLDOWN_MS - 1);
    expect(harness.service.status()).not.toBeNull();
    expect(harness.posts).toHaveLength(0); // 未到期

    harness.clock.advance(1);
    harness.service.status(); // 懒触发 flush
    expect(harness.posts).toHaveLength(1);
    expect(harness.posts[0]).toMatchObject({ kind: UPGRADE_DONE_KIND, severity: "warn", source: "butler-watch" });
    expect(harness.posts[0]!.title).toContain(INSTANCE_ID);
    expect(harness.posts[0]!.body).toContain(TARGET_VERSION);
  });

  it("窗口内多条 done 合并为一条（含合并条数与两条 job 摘要）", async () => {
    harness = makeHarness([
      stageOf("process-alive", "pass"),
      stageOf("api-connectivity", "pass"),
      stageOf("channel-probe", "pass"),
    ]);
    const started1 = harness.service.startUpgrade({ targetVersion: TARGET_VERSION });
    expect(started1.status).toBe("started");
    const first = await waitTerminal(harness.service);
    expect(first.status).toBe("done");

    harness.clock.advance(10_000); // 仍在冷却窗内
    const started2 = harness.service.startUpgrade({ targetVersion: "0.22.0" });
    expect(started2.status).toBe("started");
    const second = await waitTerminal(harness.service);
    expect(second.status).toBe("done");

    harness.clock.advance(NOTIFY_COOLDOWN_MS);
    harness.service.status();
    expect(harness.posts).toHaveLength(1); // 合并为一条
    expect(harness.posts[0]!.title).toContain("合并（2 条）");
    expect(harness.posts[0]!.body).toContain(first.jobId);
    expect(harness.posts[0]!.body).toContain(second.jobId);
  });
});

describe("createUpgradeService（listVersions 版本源）", () => {
  it("GitHub Releases 命中：去 v 前缀、prerelease→beta、降序去重", async () => {
    const fetchFn: FetchLike = async (url) => {
      if (url.includes("api.github.com")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { tag_name: "v0.21.0", prerelease: false },
            { tag_name: "v0.22.0-beta.1", prerelease: true },
            { tag_name: "v0.21.0", prerelease: false }, // 重复 tag 去重
          ],
        };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    };
    harness = makeHarness([], { fetchFn });
    const result = await harness.service.listVersions();
    expect(result.reachable).toBe(true);
    expect(result.source).toBe("github-releases");
    expect(result.versions).toEqual([
      { version: "0.22.0-beta.1", channel: "beta" },
      { version: "0.21.0", channel: "stable" },
    ]);
  });

  it("镜像源兜底：GitHub 主源失败 → github-releases-mirror 命中", async () => {
    const fetchFn: FetchLike = async (url) => {
      if (url.startsWith("https://mirror.example.com")) {
        return { ok: true, status: 200, json: async () => [{ tag_name: "v0.21.0", prerelease: false }] };
      }
      return { ok: false, status: 403, json: async () => ({}) }; // 主源与 docker-hub 均失败
    };
    harness = makeHarness([], { fetchFn, versionMirrorHost: "mirror.example.com" });
    const result = await harness.service.listVersions();
    expect(result.reachable).toBe(true);
    expect(result.source).toBe("github-releases-mirror");
    expect(result.versions).toEqual([{ version: "0.21.0", channel: "stable" }]);
  });

  it("全败：reachable=false 空列表（不抛异常）", async () => {
    const fetchFn: FetchLike = async () => ({ ok: false, status: 503, json: async () => ({}) });
    harness = makeHarness([], { fetchFn });
    const result = await harness.service.listVersions();
    expect(result.reachable).toBe(false);
    expect(result.versions).toEqual([]);
    expect(result.attempts).toHaveLength(3);
  });
});

describe("createUpgradeService（rollbackSnapshot）", () => {
  function insertSnapshotRow(instanceId: string, snapshotId: string): number {
    const row = harness.core.store.insertSnapshot({
      instance: instanceId,
      scope: { snapshotId },
      label: "pre-upgrade",
    });
    return row.id;
  }

  it("ok：回滚 Job 返回、审计 + job-event（kind rollback）+ critical 立即投递", async () => {
    harness = makeHarness([]);
    const rowId = insertSnapshotRow(INSTANCE_ID, "snap-9");
    const outcome = await harness.service.rollbackSnapshot(rowId);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.job.kind).toBe("rollback");
    expect(outcome.job.steps[0]).toMatchObject({ id: "restore-code", status: "passed" });

    expect(harness.rollbackCalls).toEqual([{ instanceId: INSTANCE_ID, snapshotId: "snap-9" }]);
    const audits = auditsOf(UPGRADE_ROLLBACK_ACTION);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ status: "ok", snapshotRowId: rowId, snapshotId: "snap-9" });
    const events = harness.core.store.listEvents({ type: "job-event" });
    expect(events.some((e) => (e.payload as { job: { kind: string } }).job.kind === "rollback")).toBe(true);
    expect(harness.posts).toHaveLength(1); // 回滚 critical 立即投递，不走冷却
    expect(harness.posts[0]).toMatchObject({ kind: UPGRADE_ROLLBACK_KIND, severity: "critical" });
  });

  it("快照不存在 → snapshot-not-found；实例不可用 → no-servicing-instance", async () => {
    harness = makeHarness([]);
    expect(await harness.service.rollbackSnapshot(9999)).toEqual({ status: "snapshot-not-found" });

    const rowId = insertSnapshotRow(INSTANCE_ID, "snap-10");
    expect(await harness.service.rollbackSnapshot(rowId, "no-such-instance")).toEqual({
      status: "no-servicing-instance",
    });
  });

  it("control.rollback 失败（E204）→ snapshot-not-found 且审计记 failed", async () => {
    harness = makeHarness([]);
    harness.setRollbackOutcome(fail("E204", "snapshot dir missing", { userHint: "快照目录缺失" }));
    const rowId = insertSnapshotRow(INSTANCE_ID, "snap-11");
    const outcome = await harness.service.rollbackSnapshot(rowId);
    expect(outcome).toEqual({ status: "snapshot-not-found" });
    const audits = auditsOf(UPGRADE_ROLLBACK_ACTION);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ status: "failed", snapshotId: "snap-11" });
  });
});
