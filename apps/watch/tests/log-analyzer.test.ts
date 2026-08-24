import { describe, expect, it } from "vitest";
import { createLogAnalyzer, type LogAnalyzerDeps } from "../src/log-analyzer.js";

function makeDeps(linesBySource: Record<string, string[]>): LogAnalyzerDeps {
  return {
    listSources: () =>
      Object.keys(linesBySource).map((id) => ({
        id,
        path: `/tmp/${id}`,
        format: "text",
        modifiedAt: null,
        sizeBytes: 0,
      })),
    readTail: (sourceId) => ({
      sourceId,
      path: `/tmp/${sourceId}`,
      format: "text",
      lines: linesBySource[sourceId] ?? [],
      truncated: false,
      limit: 300,
      totalLines: (linesBySource[sourceId] ?? []).length,
    }),
  };
}

describe("createLogAnalyzer 日志错误指纹聚合", () => {
  it("识别限流并建议重连通道", () => {
    const analyzer = createLogAnalyzer(
      makeDeps({
        "hermes.log": [
          "2026-08-23 10:00:01 ERROR iLink send failed: rate limit exceeded",
          "2026-08-23 10:00:02 ERROR iLink send failed: rate limit exceeded",
        ],
      }),
    );
    const view = analyzer.analyze();
    expect(view.scannedSources).toBe(1);
    expect(view.scannedLines).toBe(2);
    expect(view.issues).toHaveLength(1);
    expect(view.issues[0]).toMatchObject({
      kind: "rate-limit",
      severity: "warn",
      count: 2,
      suggestedAction: "rb-reconnect",
      actionLabel: "重连消息通道",
    });
  });

  it("识别端口占用并建议重启（同指纹去重聚合）", () => {
    const analyzer = createLogAnalyzer(
      makeDeps({
        "gateway.log": [
          "Error: listen EADDRINUSE: address already in use 127.0.0.1:8642",
          "Error: listen EADDRINUSE: address already in use 127.0.0.1:8642",
        ],
      }),
    );
    const view = analyzer.analyze();
    expect(view.issues).toHaveLength(1);
    expect(view.issues[0]).toMatchObject({
      kind: "port-conflict",
      severity: "error",
      count: 2,
      suggestedAction: "rb-restart",
    });
  });

  it("多来源同类错误聚合计数并列出来源", () => {
    const analyzer = createLogAnalyzer(
      makeDeps({
        "hermes.log": ["ERROR weixin timeout after 30s"],
        "gateway.log": ["ERROR weixin timeout after 30s"],
      }),
    );
    const view = analyzer.analyze();
    expect(view.issues).toHaveLength(1);
    expect(view.issues[0]!.count).toBe(2);
    expect(view.issues[0]!.sources).toEqual(["hermes.log", "gateway.log"]);
  });

  it("依赖缺失与磁盘不足不提供自动修复", () => {
    const analyzer = createLogAnalyzer(
      makeDeps({
        "evolution.log": [
          "ModuleNotFoundError: No module named 'dspy'",
          "OSError: [Errno 28] No space left on device",
        ],
      }),
    );
    const view = analyzer.analyze();
    expect(view.issues).toHaveLength(2);
    expect(view.issues.every((item) => item.suggestedAction === null)).toBe(true);
  });

  it("未归类 ERROR 归为系统错误并建议重启", () => {
    const analyzer = createLogAnalyzer(
      makeDeps({ "hermes.log": ["2026-08-23 10:00:01 ERROR something exploded"] }),
    );
    const view = analyzer.analyze();
    expect(view.issues[0]).toMatchObject({
      kind: "generic-error",
      suggestedAction: "rb-restart",
    });
  });

  it("正常日志不产生问题", () => {
    const analyzer = createLogAnalyzer(
      makeDeps({ "hermes.log": ["INFO gateway started", "DEBUG heartbeat ok"] }),
    );
    expect(analyzer.analyze().issues).toEqual([]);
  });
});