import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { fail, ok, type InstanceRef, type MessagingAdapter, type PolicyAck, type PolicySnapshot, type Result } from "@butler/contract";

import { createPolicySnapshot, DEFAULT_MESSAGE_POLICY, validateMessagePolicy } from "../src/message/config.js";
import { MessageGatewayService } from "../src/message/service.js";
import { MessagePolicyStore } from "../src/message/store.js";
import { createGatewayServer } from "../src/server.js";

describe("relayMode policy support", () => {
  it("默认策略为 takeover", () => {
    expect(DEFAULT_MESSAGE_POLICY.relayMode).toBe("takeover");
  });

  it("快照 payload 携带 relayMode", () => {
    const snapshot = createPolicySnapshot({ ...DEFAULT_MESSAGE_POLICY, relayMode: "passthrough" });
    expect(snapshot.payload["relayMode"]).toBe("passthrough");
  });

  it("非法 relayMode 被拒绝", () => {
    expect(() =>
      validateMessagePolicy({ ...DEFAULT_MESSAGE_POLICY, relayMode: "off" as never }),
    ).toThrow(/relayMode/);
  });
});

describe("relay_control store", () => {
  it("缺省为接管且无待生效标记", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "butler-relay-"));
    const store = new MessagePolicyStore(path.join(dir, "messages.sqlite"));
    try {
      expect(store.getRelayControl()).toEqual({ enabled: true, pending: false, updatedAt: null });
    } finally {
      store.close();
    }
  });

  it("写入后可读回并跨实例持久", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "butler-relay-"));
    const file = path.join(dir, "messages.sqlite");
    const first = new MessagePolicyStore(file);
    first.setRelayControl(false, true, "2026-09-01T00:00:00.000Z");
    first.close();
    const second = new MessagePolicyStore(file);
    try {
      expect(second.getRelayControl()).toEqual({
        enabled: false,
        pending: true,
        updatedAt: "2026-09-01T00:00:00.000Z",
      });
    } finally {
      second.close();
    }
  });
});

class RecordingAdapter implements MessagingAdapter {
  sent: PolicySnapshot[] = [];
  fail = false;
  async attachOutbound() {
    throw new Error("unused");
  }
  async health() {
    throw new Error("unused");
  }
  async updatePolicy(_instance: InstanceRef, snapshot: PolicySnapshot): Promise<Result<PolicyAck>> {
    if (this.fail) return fail("E302", "bridge down");
    this.sent.push(snapshot);
    return ok({ version: snapshot.version, sha256: snapshot.sha256, appliedAt: "2026-09-01T00:00:00.000Z" });
  }
  async listChanges() {
    throw new Error("unused");
  }
  async decideOutbound() {
    throw new Error("unused");
  }
  async deliver() {
    throw new Error("unused");
  }
  async forwardInbound() {
    throw new Error("unused");
  }
  async inboundHistory() {
    throw new Error("unused");
  }
  subscribeTaskEvents() {
    return () => undefined;
  }
  async prewarmChannel() {
    throw new Error("unused");
  }
}

function makeService(store: MessagePolicyStore, adapter: RecordingAdapter): MessageGatewayService {
  return new MessageGatewayService({
    adapter,
    instance: { instanceId: "hermes-main", rootPath: "/tmp", runtime: "process" },
    store,
    config: DEFAULT_MESSAGE_POLICY,
    clock: () => new Date("2026-09-01T00:00:00.000Z"),
  });
}

/** updatePolicy 可挂起的假适配器：用于验证并发调用被串行化。 */
class GatedAdapter implements MessagingAdapter {
  fail = false;
  readonly snapshots: PolicySnapshot[] = [];
  readonly gates: Array<() => void> = [];

  async attachOutbound(): Promise<never> {
    throw new Error("unused");
  }
  async health(): Promise<never> {
    throw new Error("unused");
  }
  async updatePolicy(_instance: InstanceRef, snapshot: PolicySnapshot): Promise<Result<PolicyAck>> {
    if (this.fail) return fail("E302", "bridge down");
    this.snapshots.push(snapshot);
    await new Promise<void>((resolve) => this.gates.push(resolve));
    return ok({ version: snapshot.version, sha256: snapshot.sha256, appliedAt: "2026-09-01T00:00:00.000Z" });
  }
  async listChanges(): Promise<never> {
    throw new Error("unused");
  }
  async decideOutbound(): Promise<never> {
    throw new Error("unused");
  }
  async deliver(): Promise<never> {
    throw new Error("unused");
  }
  async forwardInbound(): Promise<never> {
    throw new Error("unused");
  }
  async inboundHistory(): Promise<never> {
    throw new Error("unused");
  }
  subscribeTaskEvents(): () => void {
    return () => undefined;
  }
  async prewarmChannel(): Promise<never> {
    throw new Error("unused");
  }
}

describe("MessageGatewayService updatePolicy serialization", () => {
  it("并发的 updatePolicy 串行执行：前一次未完成前下一次不触达 Bridge", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "butler-relay-svc-"));
    const store = new MessagePolicyStore(path.join(dir, "messages.sqlite"));
    const adapter = new GatedAdapter();
    const service = makeService(store, adapter);
    try {
    const first = service.setRelayEnabled(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.snapshots).toHaveLength(1);
    const second = service.updatePolicy(DEFAULT_MESSAGE_POLICY);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(adapter.snapshots).toHaveLength(1);

    adapter.gates[0]?.();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(adapter.snapshots).toHaveLength(2);
    adapter.gates[1]?.();
    await second;
      expect(store.getRelayControl()).toEqual({
        enabled: false,
        pending: false,
        updatedAt: "2026-09-01T00:00:00.000Z",
      });
    } finally {
      store.close();
    }
  });

  it("updatePolicy 成功后对账：清除 store 中的 relay pending", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "butler-relay-svc-"));
    const store = new MessagePolicyStore(path.join(dir, "messages.sqlite"));
    store.setRelayControl(false, true, "2026-08-31T00:00:00.000Z");
    const adapter = new RecordingAdapter();
    const service = makeService(store, adapter);
    try {
      await service.updatePolicy(DEFAULT_MESSAGE_POLICY);
      expect(adapter.sent.at(-1)?.payload["relayMode"]).toBe("passthrough");
      expect(store.getRelayControl()).toEqual({
        enabled: false,
        pending: false,
        updatedAt: "2026-09-01T00:00:00.000Z",
      });
    } finally {
      store.close();
    }
  });

  it("Bridge 恢复后的周期重装清掉离线切换遗留的 pending", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "butler-relay-svc-"));
    const store = new MessagePolicyStore(path.join(dir, "messages.sqlite"));
    const adapter = new RecordingAdapter();
    adapter.fail = true;
    const service = new MessageGatewayService({
      adapter,
      instance: { instanceId: "hermes-main", rootPath: "/tmp", runtime: "process" },
      store,
      config: DEFAULT_MESSAGE_POLICY,
      clock: () => new Date("2026-09-01T00:00:00.000Z"),
      intervalMs: 25,
    });
    try {
      const relay = await service.setRelayEnabled(false);
      expect(relay.pending).toBe(true);
      expect(store.getRelayControl().pending).toBe(true);

      await service.start();
      expect(adapter.sent).toHaveLength(0);
      adapter.fail = false;
      await vi.waitFor(
        () => {
          expect(store.getRelayControl().pending).toBe(false);
        },
        { timeout: 3_000, interval: 25 },
      );
      expect(store.getRelayControl().enabled).toBe(false);
      expect(adapter.sent.at(-1)?.payload["relayMode"]).toBe("passthrough");
    } finally {
      await service.stop();
      store.close();
    }
  });
});

describe("MessageGatewayService relay switch", () => {
  it("切换为原通道：立即装策略且 pending 清零", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "butler-relay-svc-"));
    const store = new MessagePolicyStore(path.join(dir, "messages.sqlite"));
    const adapter = new RecordingAdapter();
    const service = makeService(store, adapter);
    try {
      const relay = await service.setRelayEnabled(false);
      expect(relay).toEqual({ enabled: false, pending: false, updatedAt: "2026-09-01T00:00:00.000Z" });
      expect(adapter.sent.at(-1)?.payload["relayMode"]).toBe("passthrough");
      expect(store.getRelayControl().enabled).toBe(false);
      expect(store.getRelayControl().pending).toBe(false);
    } finally {
      store.close();
    }
  });

  it("Bridge 离线：本地落盘 pending=true", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "butler-relay-svc-"));
    const store = new MessagePolicyStore(path.join(dir, "messages.sqlite"));
    const adapter = new RecordingAdapter();
    adapter.fail = true;
    const service = makeService(store, adapter);
    try {
      const relay = await service.setRelayEnabled(false);
      expect(relay.pending).toBe(true);
      expect(store.getRelayControl().pending).toBe(true);
    } finally {
      store.close();
    }
  });

  it("构造时恢复持久化的关闭状态到策略配置", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "butler-relay-svc-"));
    const store = new MessagePolicyStore(path.join(dir, "messages.sqlite"));
    store.setRelayControl(false, true, "2026-09-01T00:00:00.000Z");
    const adapter = new RecordingAdapter();
    const service = makeService(store, adapter);
    try {
      await service.updatePolicy(DEFAULT_MESSAGE_POLICY);
      expect(adapter.sent.at(-1)?.payload["relayMode"]).toBe("passthrough");
    } finally {
      store.close();
    }
  });
});

class FakeServiceForHttp {
  fail = false;
  async status() {
    throw new Error("unused");
  }
  async updatePolicy() {
    throw new Error("unused");
  }
  wake(): void {}
  async setRelayEnabled(enabled: boolean) {
    if (this.fail) throw new Error("E303");
    return { enabled, pending: !enabled, updatedAt: "2026-09-01T00:00:00.000Z" };
  }
}

describe("POST /api/messages/relay", () => {
  it("校验 enabled 布尔并转发服务", async () => {
    const app = createGatewayServer({
      startLoop: false,
      messageService: new FakeServiceForHttp() as never,
      messageStore: undefined,
    });
    try {
      const bad = await app.inject({ method: "POST", url: "/api/messages/relay", payload: { enabled: "yes" } });
      expect(bad.statusCode).toBe(400);
      const ok = await app.inject({ method: "POST", url: "/api/messages/relay", payload: { enabled: false } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ enabled: false, pending: true, updatedAt: "2026-09-01T00:00:00.000Z" });
    } finally {
      await app.close();
    }
  });
});
