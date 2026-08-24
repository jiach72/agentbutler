import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BridgeHealth } from "@butler/contract";
import { afterEach, describe, expect, it, vi } from "vitest";

import { capabilityScan } from "../src/capability-scan";
import { createHermesAdapter } from "../src/index";
import {
  REQUIRED_MESSAGING_COVERAGE,
  probeHermesMessagingCapability,
} from "../src/messaging/capability";

const SECRET = "capability-secret-never-report";
const BRIDGE_URL = "http://127.0.0.1:8754";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function completeHealth(overrides: Partial<BridgeHealth> = {}): BridgeHealth {
  return {
    protocolVersion: 1,
    bridgeVersion: "0.1.0",
    instanceId: "hermes-main",
    attached: true,
    outboxWritable: true,
    policyVersion: "message-policy-v1",
    channels: { weixin: "ok", a2a: "ok", "api-server": "ok" },
    coverage: Object.fromEntries(REQUIRED_MESSAGING_COVERAGE.map((key) => [key, "ok"])),
    ...overrides,
  };
}

function configured(fetchImpl: typeof fetch) {
  return {
    bridgeUrl: BRIDGE_URL,
    bridgeToken: SECRET,
    fetchImpl,
    timeoutMs: 50,
  };
}

describe("probeHermesMessagingCapability", () => {
  it("reports unavailable without Bridge configuration and degraded for partial configuration", async () => {
    await expect(probeHermesMessagingCapability("hermes-main")).resolves.toEqual({
      status: "unavailable",
      anomalies: ["Hermes Bridge 未配置（消息接管未安装或未启用）"],
    });

    const fetchImpl = vi.fn<typeof fetch>();
    const partial = await probeHermesMessagingCapability("hermes-main", {
      bridgeUrl: BRIDGE_URL,
      fetchImpl,
    });
    expect(partial.status).toBe("degraded");
    expect(partial.anomalies).toEqual(["Hermes Bridge 配置不完整（需要 URL 与文件加载的 token）"]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("promotes only a live authenticated Bridge with complete coverage to ok", async () => {
    const result = await probeHermesMessagingCapability(
      "hermes-main",
      configured(async () => jsonResponse(completeHealth())),
    );

    expect(result).toEqual({ status: "ok", anomalies: [] });
  });

  it.each([
    ["Outbox read-only", completeHealth({ outboxWritable: false }), "Outbox 不可写"],
    ["no adapters", completeHealth({ attached: false, channels: {} }), "没有已 attach 的适配器"],
    ["no policy", completeHealth({ policyVersion: null }), "没有有效策略快照"],
    [
      "degraded channel",
      completeHealth({ channels: { weixin: "degraded" } }),
      "通道状态未全部就绪",
    ],
    ["wrong instance", completeHealth({ instanceId: "other" }), "实例不匹配"],
    [
      "incomplete coverage",
      completeHealth({
        coverage: Object.fromEntries(
          REQUIRED_MESSAGING_COVERAGE.filter((key) => key !== "apiSse").map((key) => [key, "ok"]),
        ),
      }),
      "覆盖矩阵不完整: apiSse",
    ],
  ])("keeps %s at degraded", async (_name, health, anomaly) => {
    const result = await probeHermesMessagingCapability(
      "hermes-main",
      configured(async () => jsonResponse(health)),
    );

    expect(result.status).toBe("degraded");
    expect(result.anomalies.some((item) => item.includes(anomaly))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(BRIDGE_URL);
  });

  it.each([
    [
      "unreachable",
      async () => {
        throw new Error(`offline ${SECRET} ${BRIDGE_URL}`);
      },
      "Hermes Bridge 不可达",
    ],
    [
      "authentication",
      async () => jsonResponse({ error: "unauthorized", detail: SECRET }, 401),
      "Hermes Bridge 鉴权失败",
    ],
    [
      "protocol",
      async () => jsonResponse(completeHealth({ protocolVersion: 2 as 1 })),
      "Hermes Bridge 协议版本不兼容",
    ],
  ])("sanitizes %s probe failures", async (_name, fetchImpl, anomaly) => {
    const result = await probeHermesMessagingCapability(
      "hermes-main",
      configured(fetchImpl as typeof fetch),
    );
    expect(result).toEqual({ status: "degraded", anomalies: [anomaly] });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(BRIDGE_URL);
  });

  it("degrades malformed health payloads instead of throwing", async () => {
    const result = await probeHermesMessagingCapability(
      "hermes-main",
      configured(async () => jsonResponse({ ...completeHealth(), channels: null })),
    );
    expect(result).toEqual({
      status: "degraded",
      anomalies: ["Hermes Bridge 健康响应结构无效"],
    });
  });
});

describe("capabilityScan messaging level", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function hermesRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "hermes-capability-"));
    roots.push(root);
    mkdirSync(join(root, "venv", "bin"), { recursive: true });
    mkdirSync(join(root, "skills"));
    writeFileSync(join(root, "venv", "bin", "python"), "");
    writeFileSync(join(root, "memory_store.db"), "");
    writeFileSync(join(root, "config.yaml"), "platforms: {}\n");
    return root;
  }

  it("keeps the production capability scan at L2", async () => {
    const root = hermesRoot();
    const result = await capabilityScan(root, { prober: async () => true });
    expect(result.data).toMatchObject({
      effectiveLevel: 2,
      capabilities: { messaging: "not-implemented" },
    });
  });

  it("does not expose messaging from the production adapter", async () => {
    const root = hermesRoot();
    const adapter = createHermesAdapter();
    const result = await adapter.discovery.capabilityScan({
      instanceId: "hermes-main",
      rootPath: root,
    });

    expect(result.data).toMatchObject({
      effectiveLevel: 2,
      capabilities: { messaging: "not-implemented" },
    });
    expect(adapter.messaging).toBeUndefined();
  });
});
