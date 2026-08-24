import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ok } from "@butler/contract";
import { CORE_VERSION, createCore, type Core } from "../src/index";
import { fakeBundle, fakeManifest, makeTempDir, rmTempDir, writeManifestDir } from "./helpers";

describe("createCore 工厂", () => {
  let tmp: string;
  let core: Core;

  beforeEach(() => {
    tmp = makeTempDir();
    core = createCore({ home: path.join(tmp, "home") });
  });

  afterEach(() => {
    core.close();
    rmTempDir(tmp);
  });

  it("返回全部组件并创建目录与数据库", () => {
    expect(core.paths.home).toBe(path.join(tmp, "home"));
    expect(fs.existsSync(core.paths.dbFile)).toBe(true);
    for (const dir of [core.paths.adaptersDir, core.paths.snapshotsDir, core.paths.ledgerDir]) {
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    }
    for (const key of ["paths", "store", "bus", "audit", "registry", "instances", "router", "invoke"] as const) {
      expect(core[key]).toBeTruthy();
    }
    expect(CORE_VERSION).toMatch(/^core@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\+/);
  });

  it("事件自动持久化到 events 表（audit-appended 样例）", () => {
    core.audit.append({ actor: "tester", action: "start", target: "ins-1" });
    const events = core.store.listEvents({ type: "audit-appended" });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ actor: "tester", action: "start", target: "ins-1" });

    const degraded = core.store.listEvents({ type: "capability-degraded" });
    expect(degraded).toHaveLength(0);
  });

  it("invoke 走完整纪律：控制类写审计并透传结果", async () => {
    const result = await core.invoke(async () => ok({ instanceId: "ins-1", action: "restart", startedAt: "t" }), {
      method: "restart",
      instance: "ins-1",
    });
    expect(result.ok).toBe(true);
    expect(core.audit.list({ action: "restart", target: "ins-1" })).toHaveLength(1);
  });

  it("内核预扫描 adapters 目录：合法 manifest 预登记，程序化 register 接线", () => {
    // createCore 已建空 adapters 目录；再写一个子目录后手动触发加载
    writeManifestDir(core.paths.adaptersDir, "fake-fw", fakeManifest({ frameworkId: "fake-fw" }));
    const load = core.registry.loadFromDir(core.paths.adaptersDir);
    expect(load.data!.loaded).toBe(1);
    expect(core.registry.has("fake-fw")).toBe(true);

    const wired = core.registry.register(fakeBundle(fakeManifest({ frameworkId: "fake-fw" })));
    expect(wired.ok).toBe(true);
    expect(core.registry.getBundle("fake-fw")!.discovery.frameworkId).toBe("fake-fw");
  });

  it("生命周期 + 路由 + 事件持久化端到端串联", async () => {
    core.instances.createInstance({ instanceId: "e2e", frameworkId: "fake-fw", confidence: 0.95 });
    core.instances.beginDiscover("e2e");
    expect(core.instances.confirmInstance("e2e", "auto").data!.state).toBe("Confirmed");
    core.instances.beginNegotiate("e2e");
    const serving = core.instances.markServing("e2e", 2, {
      effectiveLevel: 2,
      capabilities: {
        probe: "ok",
        control: "ok",
        messaging: "not-implemented",
        "skill-driver": "not-implemented",
        "memory-driver": "not-implemented",
        "config-driver": "not-implemented",
      },
      anomalies: [],
    });
    expect(serving.data!.state).toBe("Serving");

    expect(core.router.check(serving.data!, "messaging").allowed).toBe(false);
    for (let i = 0; i < 3; i++) core.router.recordResult(serving.data!, "control", false);
    expect(core.instances.getInstance("e2e")!.state).toBe("Degraded");

    const stateEvents = core.store.listEvents({ type: "instance-state-changed" });
    expect(stateEvents.length).toBeGreaterThanOrEqual(4);
    const degradedEvents = core.store.listEvents({ type: "capability-degraded" });
    expect(degradedEvents).toHaveLength(1);
    expect(degradedEvents[0]!.severity).toBe("warn");
  });

  it("close 后重新 createCore 同一 home 可用（数据延续）", () => {
    core.audit.append({ actor: "a", action: "first-boot", target: "" });
    const dbFile = core.paths.dbFile;
    core.close();

    const second = createCore({ home: path.dirname(path.dirname(dbFile)) });
    expect(second.audit.list({ action: "first-boot" })).toHaveLength(1);
    second.close();
  });
});
