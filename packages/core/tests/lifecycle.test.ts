import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InstanceStatePayload } from "../src/events";
import { EventBus } from "../src/events";
import {
  AUTO_CONFIRM_CONFIDENCE_THRESHOLD,
  INSTANCE_TRANSITIONS,
  InstanceManager,
  type InstanceRecord,
} from "../src/lifecycle";
import { SqliteStore } from "../src/store";
import { fakeCapabilityReport, makeTempDir, rmTempDir } from "./helpers";

describe("InstanceManager 状态机", () => {
  let tmp: string;
  let store: SqliteStore;
  let bus: EventBus;
  let manager: InstanceManager;
  let transitions: InstanceStatePayload[];

  beforeEach(() => {
    tmp = makeTempDir();
    store = new SqliteStore(path.join(tmp, "butler.db"));
    bus = new EventBus();
    manager = new InstanceManager({ store, bus });
    transitions = [];
    bus.on("instance-state-changed", (e) => transitions.push(e.payload));
  });

  afterEach(() => {
    store.close();
    rmTempDir(tmp);
  });

  function create(confidence = 0.9): ResultLike {
    return manager.createInstance({
      instanceId: "ins-1",
      frameworkId: "fake-fw",
      runtime: "docker",
      rootPath: "/srv/ins-1",
      version: "1.2.3",
      confidence,
      evidence: ["docker-label"],
    });
  }

  /** 驱动到 Serving（默认探测确认→协商→服务）。 */
  function driveToServing(confidence = 0.9): InstanceRecord {
    create(confidence);
    manager.beginDiscover("ins-1");
    manager.confirmInstance("ins-1", confidence >= AUTO_CONFIRM_CONFIDENCE_THRESHOLD ? "auto" : "human");
    manager.beginNegotiate("ins-1");
    const serving = manager.markServing("ins-1", 2, fakeCapabilityReport());
    expect(serving.ok).toBe(true);
    return serving.data!;
  }

  it("创建实例初始为 Registered，重复创建 → E002", () => {
    const result = create();
    expect(result.ok).toBe(true);
    expect(result.data!.state).toBe("Registered");
    expect(result.data!.confidence).toBe(0.9);
    expect(result.data!.detail.evidence).toEqual(["docker-label"]);

    const dup = create();
    expect(dup.ok).toBe(false);
    expect(dup.error?.code).toBe("E002");
  });

  it("实例不存在 → E101", () => {
    const result = manager.beginDiscover("ghost");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("E101");
  });

  it("Registered → Discovering → Confirmed（auto，confidence 0.9）", () => {
    create(0.9);
    expect(manager.beginDiscover("ins-1").data!.state).toBe("Discovering");
    const confirmed = manager.confirmInstance("ins-1", "auto");
    expect(confirmed.ok).toBe(true);
    expect(confirmed.data!.state).toBe("Confirmed");
    expect(confirmed.data!.detail.confirmedBy).toBe("auto");
  });

  it("confidence < 0.6 时 auto 确认被拒、状态停留，等待 human 后放行", () => {
    create(0.3);
    manager.beginDiscover("ins-1");

    const auto = manager.confirmInstance("ins-1", "auto");
    expect(auto.ok).toBe(false);
    expect(auto.error?.code).toBe("E002");
    expect(auto.error?.userHint).toContain("人工确认");
    expect(manager.getInstance("ins-1")!.state).toBe("Discovering");

    const human = manager.confirmInstance("ins-1", "human");
    expect(human.ok).toBe(true);
    expect(human.data!.state).toBe("Confirmed");
    expect(human.data!.detail.confirmedBy).toBe("human");
  });

  it("Discovering → Rejected 为终态，任何后续迁移均拒绝", () => {
    create();
    manager.beginDiscover("ins-1");
    const rejected = manager.rejectInstance("ins-1", "ambiguous: 2 candidates");
    expect(rejected.ok).toBe(true);
    expect(rejected.data!.state).toBe("Rejected");
    expect(rejected.data!.detail.reason).toContain("ambiguous");

    expect(INSTANCE_TRANSITIONS.Rejected).toEqual([]);
    expect(manager.beginNegotiate("ins-1").error?.code).toBe("E002");
    expect(manager.reattach("ins-1").error?.code).toBe("E002");
    expect(manager.getInstance("ins-1")!.state).toBe("Rejected");
  });

  it("完整主路径：Registered→…→Serving 且 capability/effectiveLevel 持久化", () => {
    const serving = driveToServing();
    expect(serving.state).toBe("Serving");
    expect(serving.capability!.effectiveLevel).toBe(2);
    expect(serving.capability!.capabilities.control).toBe("ok");
    expect(manager.getInstance("ins-1")!.state).toBe("Serving");
  });

  it("markServing 不传 capability 时沿用已有报告并更新 effectiveLevel", () => {
    driveToServing();
    manager.markDegraded("ins-1", "probe failing");
    const recovered = manager.markServing("ins-1", 1);
    expect(recovered.ok).toBe(true);
    expect(recovered.data!.capability!.effectiveLevel).toBe(1);
    expect(recovered.data!.capability!.capabilities.control).toBe("ok");
  });

  it("Serving ⇄ Degraded：降级与恢复", () => {
    driveToServing();
    const degraded = manager.markDegraded("ins-1", "messaging endpoint unreachable");
    expect(degraded.ok).toBe(true);
    expect(degraded.data!.state).toBe("Degraded");
    expect(degraded.data!.detail.reason).toContain("unreachable");

    const recovered = manager.markServing("ins-1", 2);
    expect(recovered.ok).toBe(true);
    expect(recovered.data!.state).toBe("Serving");
  });

  it("Degraded → Offline → reattach（Offline→Negotiating）→ 再次 Serving", () => {
    driveToServing();
    manager.markDegraded("ins-1", "all probes failing");

    const offline = manager.markOffline("ins-1", "process exited");
    expect(offline.ok).toBe(true);
    expect(offline.data!.state).toBe("Offline");
    expect(offline.data!.detail.reason).toBe("process exited");

    const reattached = manager.reattach("ins-1", "container back online");
    expect(reattached.ok).toBe(true);
    expect(reattached.data!.state).toBe("Negotiating");

    const serving = manager.markServing("ins-1", 2);
    expect(serving.ok).toBe(true);
    expect(serving.data!.state).toBe("Serving");
  });

  it("非法迁移被拒：Registered 不能直接 Negotiate/Serving，Serving 不能直接 Confirmed", () => {
    create();
    expect(manager.beginNegotiate("ins-1").error?.code).toBe("E002");
    expect(manager.markServing("ins-1", 2).error?.code).toBe("E002");
    expect(manager.markOffline("ins-1", "x").error?.code).toBe("E002"); // Serving 之外的 Offline 仅 Degraded/Serving 允许

    driveToServing();
    expect(manager.confirmInstance("ins-1", "human").error?.code).toBe("E002");
    expect(manager.beginDiscover("ins-1").error?.code).toBe("E002");
  });

  it("每次成功迁移广播 instance-state-changed（from/to/reason）", () => {
    driveToServing();
    manager.markDegraded("ins-1", "flaky");

    expect(transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      "Registered->Discovering",
      "Discovering->Confirmed",
      "Confirmed->Negotiating",
      "Negotiating->Serving",
      "Serving->Degraded",
    ]);
    const last = transitions.at(-1)!;
    expect(last.reason).toBe("flaky");
    expect(last.frameworkId).toBe("fake-fw");
    expect(last.instanceId).toBe("ins-1");
  });

  it("状态持久化：同一 store 上重建 InstanceManager 可见最新状态", () => {
    driveToServing();
    manager.markDegraded("ins-1", "persisted reason");

    const revived = new InstanceManager({ store, bus: new EventBus() });
    const record = revived.getInstance("ins-1")!;
    expect(record.state).toBe("Degraded");
    expect(record.detail.reason).toBe("persisted reason");
    expect(record.capability!.effectiveLevel).toBe(2);
    expect(revived.listInstances()).toHaveLength(1);
  });

  it("迁移事件不会为非法迁移发出", () => {
    create();
    const before = transitions.length;
    const bad = manager.markServing("ins-1", 2);
    expect(bad.ok).toBe(false);
    expect(transitions.length).toBe(before);
  });
});

/** 局部类型别名，避免测试文件重复内联 Result 形状。 */
type ResultLike = { ok: boolean; data?: InstanceRecord; error?: { code: string } };
