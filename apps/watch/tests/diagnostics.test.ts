import { describe, expect, it } from "vitest";
import type { Core, InstanceRecord, StoredEvent } from "@butler/core";
import type { DiagnosticReportDeps } from "../src/diagnostics.js";
import { renderDiagnosticReport } from "../src/diagnostics.js";
import type { LogAnalyzeView } from "../src/log-analyzer.js";
import type { EvolutionLedgerEntry } from "../src/evolution.js";

const FIXED_NOW = Date.parse("2026-08-23T03:00:00.000Z");

function makeDeps(): { deps: DiagnosticReportDeps; events: StoredEvent[]; logView: LogAnalyzeView } {
  const events: StoredEvent[] = [
    {
      id: 1,
      ts: "2026-08-23T02:00:00.000Z",
      type: "inspection-completed",
      severity: "info",
      source: "core",
      payload: {
        instanceId: "hermes-main",
        frameworkId: "hermes",
        startedAt: "2026-08-23T01:50:00.000Z",
        finishedAt: "2026-08-23T02:00:00.000Z",
        overall: "degraded",
        confidence: 0.82,
        checks: [
          { id: "service", status: "failed", detail: "/home/jiach/.hermes 服务未响应" },
        ],
      },
    },
    {
      id: 2,
      ts: "2026-08-23T01:00:00.000Z",
      type: "fingerprint-aggregated",
      severity: "warn",
      source: "watch",
      payload: {
        signature: "sig-a",
        template: "openai 401 invalid key /home/jiach/secret",
        windowStart: "2026-08-20T00:00:00.000Z",
        count: 5,
        isFirstEver: true,
        escalated: false,
        alert: true,
        sample: "raw-sample-line",
      },
    },
    {
      id: 3,
      ts: "2026-08-23T00:30:00.000Z",
      type: "fingerprint-aggregated",
      severity: "warn",
      source: "watch",
      payload: {
        signature: "sig-a",
        template: "openai 401 invalid key /home/jiach/secret",
        windowStart: "2026-08-19T00:00:00.000Z",
        count: 3,
        isFirstEver: false,
        escalated: false,
        alert: false,
        sample: "raw-sample-line-2",
      },
    },
    {
      id: 4,
      ts: "2026-08-23T00:00:00.000Z",
      type: "fingerprint-aggregated",
      severity: "warn",
      source: "watch",
      payload: {
        signature: "sig-old",
        template: "old window /home/jiach/old",
        windowStart: "2026-08-10T00:00:00.000Z",
        count: 99,
        isFirstEver: true,
        escalated: false,
        alert: true,
        sample: "old-raw",
      },
    },
  ];
  const instance: InstanceRecord = {
    instanceId: "hermes-main",
    frameworkId: "hermes",
    state: "Serving",
    runtime: "process",
    rootPath: "/home/jiach/.hermes",
    version: "0.20.4",
    confidence: 0.9,
    capability: null,
    detail: { evidence: [] },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-23T02:00:00.000Z",
  };
  const store = {
    listEvents: () => events,
  } as unknown as Core["store"];
  const instances = {
    listInstances: () => [instance],
  } as unknown as Core["instances"];
  const logView: LogAnalyzeView = {
    scannedSources: 2,
    scannedLines: 500,
    analyzedAt: "2026-08-23T02:30:00.000Z",
    issues: [
      {
        id: "rate-limit",
        kind: "rate-limit",
        severity: "warn",
        title: "消息限流",
        detail: "429 /home/jiach/wechat 通道",
        count: 3,
        sources: ["gateway"],
        examples: ["example raw"],
        suggestedAction: "rb-reconnect",
        actionLabel: "重连消息通道",
      },
    ],
  };
  const ledger: EvolutionLedgerEntry = {
    runId: "run-1",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    instanceId: null,
    status: "accepted",
    holdoutCount: 10,
    dependencies: [],
    endpoint: "",
    config: {},
    checks: [],
    baselineMetric: 0.4,
    candidateMetric: 0.6,
    delta: 0.2,
    significant: true,
    errors: [],
    rootCause: "",
    fixes: [],
    conclusion: "候选显著提升，写入通过",
    disposition: "accepted",
  };
  const deps: DiagnosticReportDeps = {
    core: { store, instances } as unknown as Pick<Core, "store" | "instances">,
    butler: {
      version: () => ({
        version: "1.7.0",
        source: "/home/jiach/agent-butler",
        branch: "codex/continue-agent-butler-v1",
        commit: "abc1234",
        tag: null,
        repository: null,
        checkedAt: "2026-08-23T02:00:00.000Z",
      }),
    },
    analyzeLogs: () => logView,
    security: {
      status: async () => ({
        checkedAt: "2026-08-23T02:00:00.000Z",
        invariants: [
          { id: "i1", title: "密钥权限", status: "pass", detail: "3 个密钥均为 0600", rule: "secret-mode-0600" },
        ],
        secrets: [
          { rel: ".env", path: "/home/jiach/.agent-butler/.env", mode: "0600", secure: true, sizeBytes: 12, modifiedAt: "2026-08-22T00:00:00.000Z" },
        ],
        totalSecretFiles: 1,
        insecureSecretFiles: 0,
        message: "ok",
      }),
    },
    gateway: {
      stats: async () => ({ overall: "warn", totalEvents: 10, last24h: 3, matched: [], suggestions: [] }),
      patches: async () => [
        {
          id: "throttle",
          title: "节流补丁",
          description: "",
          target: "config.json",
          params: { interval: { default: 60, min: 1 } },
          applied: null,
          observed: null,
        },
      ],
      applyPatch: async () => ({ status: "unknown-patch" }),
      reapplyPatch: async () => ({ status: "unknown-patch" }),
      detectPatch: async () => ({ status: "unknown-patch" }),
    },
    evolution: {
      status: () => ({ minHoldoutCount: 10, defaultDependencies: [], defaultEndpoint: "", ledger: [ledger] }),
      preflight: async () => ({ status: "not-ready" }) as never,
      expandDataset: async () => ({ status: "not-ready" }) as never,
      recordResult: async () => ({ status: "rejected" }) as never,
      exportLedger: () => null,
    },
    now: () => FIXED_NOW,
  };
  return { deps, events, logView };
}

describe("renderDiagnosticReport 一键诊断报告", () => {
  it("包含 5 节内容并脱敏用户名路径", async () => {
    const { deps } = makeDeps();
    const report = await renderDiagnosticReport(deps);
    expect(report).toContain("# Agent Butler 诊断报告");
    expect(report).toContain("## 1. 环境信息");
    expect(report).toContain("## 2. 最近巡检");
    expect(report).toContain("## 3. 日志问题与错误指纹");
    expect(report).toContain("## 4. 配置摘要（不含密钥）");
    expect(report).toContain("## 5. 进化实验台账");
    expect(report).toContain("管家版本：1.7.0");
    expect(report).not.toContain("/home/jiach");
    expect(report).not.toContain("raw-sample-line");
    expect(report).not.toContain("example raw");
    expect(report).toContain("消息限流 · 3 次");
    expect(report).toContain("重连消息通道");
  });

  it("错误指纹按签名聚合且只统计近 7 天窗口", async () => {
    const { deps } = makeDeps();
    const report = await renderDiagnosticReport(deps);
    expect(report).toContain("近 7 天错误指纹聚类（1 类 · 合计 8 次）");
    expect(report).toContain("openai 401 invalid key ~/secret · 8 次");
    expect(report).not.toContain("old window");
    expect(report).not.toContain("old-raw");
  });

  it("没有事件时仍生成完整报告骨架", async () => {
    const { deps, events, logView } = makeDeps();
    events.length = 0;
    logView.issues.length = 0;
    deps.evolution = undefined;
    const report = await renderDiagnosticReport(deps);
    expect(report).toContain("还没有巡检记录");
    expect(report).toContain("扫描窗口内没有聚合到需要处理的问题。");
    expect(report).toContain("暂无进化实验记录。");
    expect(report).toContain("## 4. 配置摘要（不含密钥）");
  });
});
