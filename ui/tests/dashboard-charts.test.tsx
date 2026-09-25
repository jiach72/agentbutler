import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { MatrixSparkline } from "../src/pages/dashboard/MatrixSparkline.js";
import { SystemTelemetryChart } from "../src/pages/dashboard/SystemTelemetryChart.js";
import { GuardianPostureChart } from "../src/pages/dashboard/GuardianPostureChart.js";

describe("首页核心守护矩阵与时序图表套件 (Dashboard Telemetry Suite)", () => {
  it("MatrixSparkline 渲染平滑三次贝塞尔曲线及终止节点", () => {
    const html = renderToStaticMarkup(
      React.createElement(MatrixSparkline, {
        data: [10, 15, 20, 25, 30, 28, 22],
        color: "#2dd4bf",
        height: 32,
        ariaLabel: "智能体心跳",
      }),
    );

    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="智能体心跳"');
    expect(html).toContain("stroke=\"#2dd4bf\"");
    expect(html).toContain("<path d=\"M");
    expect(html).toContain("<circle");
    expect(html).toContain("motion-reduce:animate-none");
  });

  it("MatrixSparkline 在全平坦数据时不塌陷到底部", () => {
    const html = renderToStaticMarkup(
      React.createElement(MatrixSparkline, {
        data: [100, 100, 100, 100],
        color: "#2dd4bf",
        height: 32,
        ariaLabel: "平坦数据",
      }),
    );

    // 验证 path 生成正常且包含曲线
    expect(html).toContain("<path d=\"M");
    // 不应退化为空字符串
    expect(html).not.toContain('d=""');
  });

  it("SystemTelemetryChart 渲染 24 小时排程分布与指标卡片", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(SystemTelemetryChart, {
          failedTaskCount: 0,
          todayRunCount: 16,
          probeSlaText: "健康",
          onlineInstancesText: "1/1",
          nextTask: { name: "日常安全深度体检", nextRunAt: "2026-09-25T14:00:00.000Z" },
          upcomingTasks: [{ name: "记忆向量索引优化", nextRunAt: "2026-09-25T16:00:00.000Z" }],
        }),
      ),
    );

    expect(html).toContain("系统调度与时序态势");
    expect(html).toContain("今日调度触发");
    expect(html).toContain("成功执行");
    expect(html).toContain("日常安全深度体检");
    expect(html).toContain("24h 调度时序");
    expect(html).toContain("touch-pan-x");
    expect(html).toContain("motion-reduce:animate-none");
  });

  it("SystemTelemetryChart 在无任务时提示前往任务配置中心并提供链接", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(SystemTelemetryChart, {
          failedTaskCount: 0,
          todayRunCount: 0,
          probeSlaText: "健康",
          onlineInstancesText: "1/1",
          nextTask: null,
          upcomingTasks: [],
          defaultViewMode: "roster",
        }),
      ),
    );

    expect(html).toContain("暂无启用的定时排程");
    expect(html).toContain('href="/tasks"');
  });

  it("GuardianPostureChart 渲染探针响应时延与 50ms SLA 预警线", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(GuardianPostureChart, {
          inspectStatus: {
            reachable: true,
            lastAt: "2026-09-25T11:00:00.000Z",
            intervalMin: 5,
            lastDurationMs: 24,
            criticalProbe: {
              intervalMin: 5,
              slaMin: 10,
              lastStartedAt: "2026-09-25T11:00:00.000Z",
              lastCompletedAt: "2026-09-25T11:00:00.024Z",
              nextAt: "2026-09-25T11:05:00.000Z",
              deadlineAt: "2026-09-25T11:10:00.000Z",
              lastDurationMs: 24,
              lastStatus: "pass",
              lastWithinSla: true,
              overdue: false,
              inFlight: false,
              runCount: 142,
              missedTicks: 0,
            },
          },
          isBridgeConnected: true,
          onlineInstancesText: "1/1",
          memoryLabel: "可用",
          failedMessagesCount: 0,
        }),
      ),
    );

    expect(html).toContain("健康守护态势与探针 SLA");
    expect(html).toContain("SLA 达标 · 99.98%");
    expect(html).toContain("SLA 预警线 (50ms)");
    expect(html).toContain("回环隔离屏障");
    expect(html).toContain("127.0.0.1");
    expect(html).toContain("智能体守护进程");
    expect(html).toContain("记忆隔离 Enclave");
    expect(html).toContain("touch-pan-x");
    expect(html).toContain("motion-reduce:animate-none");
  });
});
