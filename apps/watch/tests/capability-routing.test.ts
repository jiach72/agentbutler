import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ok, type CapabilityReport, type ControlAdapter, type InstanceRef } from "@butler/contract";
import { createCore, type Core } from "@butler/core";
import { createRoutedControl } from "../src/watch.js";

describe("watch 控制面能力路由", () => {
  let core: Core;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "watch-capability-routing-"));
    core = createCore({ home });
  });

  afterEach(() => {
    core.close();
    rmSync(home, { recursive: true, force: true });
  });

  function serving(control: CapabilityReport["capabilities"]["control"], config: CapabilityReport["capabilities"]["config-driver"]): InstanceRef {
    const instanceId = "route-ins";
    core.instances.createInstance({
      instanceId,
      frameworkId: "hermes",
      runtime: "process",
      rootPath: "/tmp/hermes",
      confidence: 1,
    });
    core.instances.beginDiscover(instanceId);
    core.instances.confirmInstance(instanceId, "auto");
    core.instances.beginNegotiate(instanceId);
    core.instances.markServing(instanceId, 2, {
      effectiveLevel: 2,
      capabilities: {
        probe: "ok",
        control,
        messaging: "not-implemented",
        "skill-driver": "not-implemented",
        "memory-driver": "not-implemented",
        "config-driver": config,
      },
      anomalies: [],
    });
    return { instanceId, rootPath: "/tmp/hermes", runtime: "process" };
  }

  function fakeControl(calls: string[]): ControlAdapter {
    return {
      start: async (instance) => {
        calls.push("start");
        return ok({ instanceId: instance.instanceId, action: "start", startedAt: "2026-08-24T00:00:00.000Z" });
      },
      stop: async (instance) => {
        calls.push("stop");
        return ok({ instanceId: instance.instanceId, action: "stop", startedAt: "2026-08-24T00:00:00.000Z" });
      },
      restart: async (instance) => {
        calls.push("restart");
        return ok({ instanceId: instance.instanceId, action: "restart", startedAt: "2026-08-24T00:00:00.000Z" });
      },
      upgrade: async () => {
        calls.push("upgrade");
        return ok({ jobId: "job-upgrade", kind: "upgrade", steps: [] });
      },
      snapshot: async () => {
        calls.push("snapshot");
        return ok({ jobId: "job-snapshot", kind: "snapshot", steps: [] });
      },
      rollback: async () => {
        calls.push("rollback");
        return ok({ jobId: "job-rollback", kind: "rollback", steps: [] });
      },
      validateConfig: async () => {
        calls.push("validateConfig");
        return ok({ passed: true, violations: [] });
      },
    };
  }

  it("control 未实现时在 adapter 前拒绝 restart，避免 runbook 旁路", async () => {
    const calls: string[] = [];
    const instance = serving("not-implemented", "ok");
    const routed = createRoutedControl(core, fakeControl(calls));

    const result = await routed.restart(instance);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("E103");
    expect(calls).toEqual([]);
  });

  it("control/config-driver 已实现时 snapshot 与 validateConfig 均经内核调用", async () => {
    const calls: string[] = [];
    const instance = serving("ok", "ok");
    const routed = createRoutedControl(core, fakeControl(calls));

    await expect(routed.snapshot(instance, { include: ["data"] })).resolves.toMatchObject({ ok: true });
    await expect(routed.validateConfig(instance)).resolves.toMatchObject({ ok: true });

    expect(calls).toEqual(["snapshot", "validateConfig"]);
    expect(core.audit.list({ action: "snapshot", target: instance.instanceId })).toHaveLength(1);
  });

  it("config-driver 未实现时配置校验同样 fail-closed", async () => {
    const calls: string[] = [];
    const instance = serving("ok", "not-implemented");
    const routed = createRoutedControl(core, fakeControl(calls));

    const result = await routed.validateConfig(instance);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("E103");
    expect(calls).toEqual([]);
  });
});
