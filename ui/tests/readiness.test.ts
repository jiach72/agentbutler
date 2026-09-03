import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReadinessSection } from "../src/pages/dashboard/ReadinessSection.js";
import { buildLocalReadiness } from "../src/pages/dashboard/readiness.js";
import type {
  ConnectionsPayload,
  DiscoveredLlmConfigView,
  HealthPayload,
  HostMetricsPayload,
  LlmStatusView,
} from "../src/pages/dashboard/types.js";

const connected: ConnectionsPayload = {
  reachable: true,
  connections: [{
    instanceId: "hermes-main",
    frameworkId: "hermes",
    displayName: "Hermes",
    state: "running",
    connectionState: "connected",
    connected: true,
    runtime: "docker",
    rootPath: "/opt/hermes",
    version: "0.20.4",
    confidence: 0.95,
    effectiveLevel: null,
    capabilities: {},
    checks: [],
    anomalies: [],
    lastCheckedAt: null,
    lastActionAt: null,
    lastAction: null,
    latencyMs: null,
    lastError: null,
  }],
};

const readyManaged: LlmStatusView = {
  vault: { available: true },
  profiles: 1,
  activeProfiles: 1,
  bindings: 1,
  activeBindings: 1,
  ready: true,
  blocked: [],
};

const nativeModel: DiscoveredLlmConfigView = {
  id: "native-1",
  source: "/opt/hermes/.env",
  provider: "OpenAI",
  protocol: "openai-compatible",
  endpoint: "https://api.example.com/v1",
  model: "gpt-test",
  maskedKey: "sk-***",
  importable: true,
  runtimeObserved: false,
};

describe("首页本机运行就绪度", () => {
  it("所有独立条件就绪时才给出完整运行结论", () => {
    const result = buildLocalReadiness(connected, readyManaged, [nativeModel]);

    expect(result.ready).toBe(true);
    expect(result.summary).toBe("本机已具备运行条件");
    expect(result.nextAction).toBeUndefined();
  });

  it("未发现 Hermes 原生模型时说明影响范围并导向设置向导", () => {
    const result = buildLocalReadiness(connected, readyManaged, []);
    const native = result.items.find((item) => item.id === "native-model");

    expect(result.ready).toBe(false);
    expect(native).toMatchObject({ tone: "warn", action: { label: "查看说明", to: "/setup" } });
    expect(native?.detail).toContain("不影响连接检查");
  });

  it("运行时已观测到 Hermes 模型时，不错误引导用户重新配置", () => {
    const observed: DiscoveredLlmConfigView = {
      ...nativeModel,
      id: "runtime-log",
      source: "/opt/hermes/logs/agent.log",
      provider: "Hermes runtime",
      endpoint: "",
      model: "deepseek-v4-flash-vision-exp",
      maskedKey: "—",
      importable: false,
      runtimeObserved: true,
    };
    const result = buildLocalReadiness(connected, readyManaged, [observed]);
    const native = result.items.find((item) => item.id === "native-model");

    expect(result.ready).toBe(true);
    expect(native).toMatchObject({ tone: "ok", status: "已观察到 1 个运行模型" });
    expect(native?.detail).toContain("运行日志");
  });

  it("凭据库不可用时不误报 Hermes 原生模型故障", () => {
    const result = buildLocalReadiness(connected, { ...readyManaged, vault: { available: false }, ready: false }, [nativeModel]);
    const managed = result.items.find((item) => item.id === "managed-model");

    expect(managed).toMatchObject({ tone: "error", action: { label: "打开安全设置", to: "/settings" } });
    expect(result.summary).toBe("还有一项运行准备待完成");
  });

  it("控制通道不可达时优先引导排查而不是要求重新配置模型", () => {
    const result = buildLocalReadiness({ reachable: false, connections: [] }, readyManaged, [nativeModel]);

    expect(result.nextAction).toEqual({ label: "开始排查", to: "/troubleshoot?symptom=error" });
    expect(result.summary).toBe("先完成本机智能体连接");
  });

  it("发现实例但未连接时引导继续设置，而不是误报模型故障", () => {
    const result = buildLocalReadiness({
      ...connected,
      connections: connected.connections?.map((connection) => ({ ...connection, connected: false, connectionState: "disconnected" })),
    }, readyManaged, [nativeModel]);

    expect(result.nextAction).toEqual({ label: "继续设置", to: "/setup" });
    expect(result.items.find((item) => item.id === "connection")?.status).toBe("尚未连接");
  });

  it("将三类独立就绪状态与可执行下一步渲染在首页", () => {
    const html = renderToStaticMarkup(
      React.createElement(ReadinessSection, {
        connections: connected,
        llmStatus: readyManaged,
        discoveredModels: [],
        refreshing: false,
        onRefresh: () => undefined,
      }),
    );

    expect(html).toContain("本机运行就绪度");
    expect(html).toContain("本机智能体连接");
    expect(html).toContain("Hermes 原生模型");
    expect(html).toContain("管家受管任务模型");
    expect(html).toContain('href="/setup"');
  });

  it("运行详情中的本机资源与管家指标保留完整数据", () => {
    const hostMetrics: HostMetricsPayload = {
      machine: {
        capturedAt: "2026-09-01T08:00:00.000Z",
        cpuPercent: 12.5,
        memTotalBytes: 16_000_000_000,
        memFreeBytes: 8_000_000_000,
        load1: 0.4,
        uptimeSeconds: 3 * 86_400 + 4 * 3_600,
        diskTotalBytes: 1_000_000_000_000,
        diskUsedBytes: 250_000_000_000,
        gpu: { name: "Test GPU", utilPercent: 35, memUsedMb: 1234 },
      },
      agents: [
        { instanceId: "hermes-main", cpuPercent: 3.2, rssBytes: 4096 },
        { instanceId: "openclaw-a", cpuPercent: 1.1, rssBytes: 2048 },
      ],
      samples: [],
    };
    const html = renderToStaticMarkup(
      React.createElement(ReadinessSection, {
        connections: connected,
        llmStatus: readyManaged,
        discoveredModels: [],
        refreshing: false,
        onRefresh: () => undefined,
        hostMetrics,
        inspectionHistory: { days: 14, items: [] },
      }),
    );

    expect(html).toContain("本机资源");
    expect(html).toContain("12.5%");
    expect(html).toContain("3 天 4 小时");
    expect(html).toContain("Test GPU");
    // 多实例 → Tabs 短名切换
    expect(html).toContain("hermes");
    expect(html).toContain("openclaw");
    expect(html).toContain("管家运行指标");
    expect(html).toContain("暂无走势数据");
  });

  it("主机指标不可达时信息卡降级为次要提示而非报错", () => {
    const serviceHealth: HealthPayload = {
      ok: true,
      services: {
        gateway: { reachable: true, serviceVersion: "g@1", schemaVersion: "v1", latencyMs: 12 },
        watch: { reachable: true, serviceVersion: "w@1", schemaVersion: "v1", latencyMs: 34 },
      },
    };
    const html = renderToStaticMarkup(
      React.createElement(ReadinessSection, {
        connections: connected,
        llmStatus: readyManaged,
        discoveredModels: [],
        refreshing: false,
        onRefresh: () => undefined,
        serviceHealth,
        inspectStatus: null,
      }),
    );

    expect(html).toContain("主机指标暂不可用");
    expect(html).toContain("告警网关（gateway）");
    expect(html).toContain("12ms");
    expect(html).toContain("34ms");
  });
});
