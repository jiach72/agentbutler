import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore, deriveJobStatus } from "../src/store";
import { makeTempDir, rmTempDir } from "./helpers";

describe("SqliteStore", () => {
  let tmp: string;
  let store: SqliteStore;

  beforeEach(() => {
    tmp = makeTempDir();
    store = new SqliteStore(path.join(tmp, "data", "butler.db"));
  });

  afterEach(() => {
    store.close();
    rmTempDir(tmp);
  });

  it("数据库文件不存在时自动建目录建表", () => {
    const dbFile = path.join(tmp, "nested", "deeper", "butler.db");
    const fresh = new SqliteStore(dbFile);
    expect(fs.existsSync(dbFile)).toBe(true);
    // 每张表都能写入即视为建表成功
    fresh.insertEvent({ type: "t" });
    fresh.upsertFingerprint("sig");
    fresh.insertJob({ jobId: "j", kind: "snapshot" });
    fresh.insertSnapshot({ instance: "ins", scope: { include: ["data"] } });
    fresh.appendAudit({ actor: "a", action: "act" });
    fresh.saveInstance({
      instanceId: "ins",
      frameworkId: "fw",
      state: "Registered",
      runtime: "unknown",
      rootPath: "",
      version: null,
      confidence: 0,
      capabilityJson: null,
      detailJson: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    fresh.close();
  });

  it("events：写入与按类型/limit 查询，payload JSON 回程一致", () => {
    store.insertEvent({ type: "alpha", payload: { n: 1, nested: { ok: true } } });
    store.insertEvent({ type: "beta", severity: "warn", source: "watch", payload: "plain" });
    store.insertEvent({ type: "alpha", payload: { n: 2 } });

    const alphas = store.listEvents({ type: "alpha" });
    expect(alphas).toHaveLength(2);
    expect(alphas[0]!.payload).toEqual({ n: 2 }); // 新的在前
    expect(store.listEvents({ type: "alpha", limit: 1 })).toHaveLength(1);

    const beta = store.listEvents({ type: "beta" })[0]!;
    expect(beta.severity).toBe("warn");
    expect(beta.source).toBe("watch");
    expect(beta.payload).toBe("plain");
    expect(store.listEvents()).toHaveLength(3);
  });

  it("inspection-completed：在 SQLite 中按本地日聚合次数、耗时和异常数", () => {
    store.insertEvent({
      type: "inspection-completed",
      payload: { overall: "ok", checks: [{ durationMs: 100 }, { durationMs: 300 }] },
    });
    store.insertEvent({
      type: "inspection-completed",
      payload: { overall: "degraded", checks: [{ durationMs: 60 }] },
    });

    const rows = store.dailyInspectionMetrics(new Date(Date.now() - 60_000).toISOString());

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 2, avgDurationMs: 130, errorCount: 1 });
  });

  it("fingerprints：同签名 upsert 计数递增、状态可更新", () => {
    const first = store.upsertFingerprint("sig-1", "sample-1");
    expect(first.count).toBe(1);
    expect(first.status).toBe("open");

    const second = store.upsertFingerprint("sig-1", "sample-2");
    expect(second.count).toBe(2);
    expect(second.id).toBe(first.id);
    expect(second.lastSample).toBe("sample-2");
    expect(second.instance).toBe("");
    expect(new Date(second.lastSeen).getTime()).toBeGreaterThanOrEqual(new Date(first.firstSeen).getTime());

    const owned = store.upsertFingerprint("sig-own", "sample-own", "hermes-main");
    expect(owned.instance).toBe("hermes-main");
    const ownedAgain = store.upsertFingerprint("sig-own", "sample-own-2");
    expect(ownedAgain.instance).toBe("hermes-main"); // 未知来源不覆盖已知归属

    store.upsertFingerprint("sig-2");
    const all = store.listFingerprints();
    expect(all).toHaveLength(3);
    expect(all.map((f) => f.signature).sort()).toEqual(["sig-1", "sig-2", "sig-own"]);

    expect(store.updateFingerprintStatus("sig-1", "resolved")).toBe(true);
    expect(store.listFingerprints().find((f) => f.signature === "sig-1")!.status).toBe("resolved");
    expect(store.updateFingerprintStatus("missing", "resolved")).toBe(false);
  });

  it("fingerprints：可按 last_seen 时间窗口过滤", () => {
    store.upsertFingerprint("recent");
    const cutoff = new Date(Date.now() + 1_000).toISOString();
    expect(store.listFingerprints(100, cutoff)).toHaveLength(0);

    store.upsertFingerprint("newer");
    const since = new Date(Date.now() - 1_000).toISOString();
    expect(store.listFingerprints(100, since).map((item) => item.signature)).toEqual(["newer", "recent"]);
  });

  it("jobs：按 idempotencyKey/jobId 查询、状态更新、steps 回程", () => {
    store.insertJob({
      jobId: "job-1",
      kind: "upgrade",
      instance: "ins-1",
      idempotencyKey: "key-1",
      steps: [
        { id: "s1", label: "预检", status: "passed" },
        { id: "s2", label: "快照", status: "running" },
      ],
    });

    const byKey = store.findJobByIdempotencyKey("key-1")!;
    expect(byKey.jobId).toBe("job-1");
    expect(byKey.kind).toBe("upgrade");
    expect(byKey.steps).toHaveLength(2);
    expect(byKey.steps[0]).toMatchObject({ id: "s1", status: "passed" });
    expect(byKey.status).toBe("running");

    expect(store.findJobByIdempotencyKey("nope")).toBeUndefined();
    expect(store.findJobById("job-1")!.jobId).toBe("job-1");

    expect(store.updateJob("job-1", { status: "done" })).toBe(true);
    expect(store.findJobById("job-1")!.status).toBe("done");
    expect(store.listJobs({ instance: "ins-1" })).toHaveLength(1);
    expect(store.listJobs({ instance: "other" })).toHaveLength(0);
  });

  it("deriveJobStatus：failed 优先、全部收敛为 done、否则 running", () => {
    expect(deriveJobStatus([{ id: "s", label: "l", status: "failed" }])).toBe("failed");
    expect(
      deriveJobStatus([
        { id: "a", label: "l", status: "passed" },
        { id: "b", label: "l", status: "skipped" },
      ]),
    ).toBe("done");
    expect(deriveJobStatus([{ id: "a", label: "l", status: "pending" }])).toBe("running");
    expect(deriveJobStatus([])).toBe("running");
  });

  it("snapshots：登记、按实例列举、状态更新", () => {
    const row = store.insertSnapshot({ instance: "ins-1", scope: { include: ["code", "data"] }, label: "before-upgrade" });
    store.insertSnapshot({ instance: "ins-2", scope: { include: ["data"] } });

    expect(row.id).toBeGreaterThan(0);
    const list = store.listSnapshots("ins-1");
    expect(list).toHaveLength(1);
    expect(list[0]!.scope).toEqual({ include: ["code", "data"] });
    expect(list[0]!.label).toBe("before-upgrade");

    expect(store.updateSnapshotStatus(row.id, "evicted")).toBe(true);
    expect(store.listSnapshots("ins-1")[0]!.status).toBe("evicted");
    expect(store.listSnapshots()).toHaveLength(2);
  });

  it("audit：追加、action/target 过滤与 limit", () => {
    store.appendAudit({ actor: "kernel", action: "start", target: "ins-1", detail: { reason: "runbook" } });
    store.appendAudit({ actor: "human", action: "stop", target: "ins-1" });
    store.appendAudit({ actor: "kernel", action: "start", target: "ins-2" });

    expect(store.listAudit()).toHaveLength(3);
    expect(store.listAudit({ action: "start" })).toHaveLength(2);
    expect(store.listAudit({ action: "start", target: "ins-1" })).toHaveLength(1);
    expect(store.listAudit({ target: "ins-1" })).toHaveLength(2);
    expect(store.listAudit({ limit: 2 })).toHaveLength(2);
    expect(store.listAudit({ action: "start", target: "ins-1" })[0]!.detail).toEqual({ reason: "runbook" });
  });

  it("instances：saveInstance upsert 与读取回程", () => {
    const now = new Date().toISOString();
    store.saveInstance({
      instanceId: "ins-1",
      frameworkId: "hermes",
      state: "Serving",
      runtime: "docker",
      rootPath: "/srv/hermes",
      version: "0.5.0",
      confidence: 0.9,
      capabilityJson: JSON.stringify({ effectiveLevel: 2, capabilities: {}, anomalies: [] }),
      detailJson: JSON.stringify({ reason: "none" }),
      createdAt: now,
      updatedAt: now,
    });
    let row = store.getInstance("ins-1")!;
    expect(row.frameworkId).toBe("hermes");
    expect(row.state).toBe("Serving");
    expect(row.capabilityJson).toContain("effectiveLevel");

    store.saveInstance({ ...row, state: "Degraded", updatedAt: new Date().toISOString() });
    row = store.getInstance("ins-1")!;
    expect(row.state).toBe("Degraded");
    expect(store.listInstances()).toHaveLength(1);
    expect(store.getInstance("nope")).toBeUndefined();
  });

  it("关闭重开后数据仍在（WAL 持久化）", () => {
    store.insertEvent({ type: "persist-check", payload: 42 });
    store.appendAudit({ actor: "a", action: "b" });
    const dbFile = store.dbFile;
    store.close();

    const reopened = new SqliteStore(dbFile);
    expect(reopened.listEvents({ type: "persist-check" })[0]!.payload).toBe(42);
    expect(reopened.listAudit()).toHaveLength(1);
    reopened.close();
  });
});
