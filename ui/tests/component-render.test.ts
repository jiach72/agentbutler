import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { Layout } from "../src/components/Layout.js";
import { ThemeProvider } from "../src/theme/ThemeProvider.js";
import { InstanceHealthCard } from "../src/pages/dashboard/InstanceHealthCard.js";
import type {
  InspectionView,
  InstanceView,
  RecoveryActionView,
} from "../src/pages/dashboard/types.js";
import { ActionStep } from "../src/pages/troubleshoot/steps/ActionStep.js";
import { SymptomStep } from "../src/pages/troubleshoot/steps/SymptomStep.js";
import { DiagnosticsCenter } from "../src/pages/settings/DiagnosticsCenter.js";

describe("关键页面组件渲染", () => {
  it("侧栏保留高频入口，并把维护功能收进维护与升级分组", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(
          MemoryRouter,
          { initialEntries: ["/evolution"] },
          React.createElement(Layout),
        ),
      ),
    );

    expect(html).toContain('href="/dashboard"');
    expect(html).toContain('href="/skills"');
    expect(html).toContain('href="/gateway"');
    expect(html).toContain('href="/core-files"');
    expect(html).toContain('href="/evolution"');
    expect(html).toContain('href="/troubleshoot"');
    expect(html).toContain('href="/logs"');
    expect(html).toContain('href="/setup"');
    expect(html).toContain('href="/settings"');
    expect(html).not.toContain('href="/assets"');
    expect(html).not.toContain('href="/versions"');
    expect(html).toContain('aria-label="开始排查问题"');
    expect(html).toContain("排查问题");
    expect(html).toContain('class="topbar-title">自进化</strong>');
  });

  it("首页实例详情能输出状态、版本和检查结果", () => {
    const instances: InstanceView[] = [
      {
        instanceId: "hermes-main",
        frameworkId: "hermes",
        state: "running",
        runtime: "docker",
        version: "0.20.4",
        confidence: 0.96,
      },
    ];
    const inspections: InspectionView[] = [
      {
        instanceId: "hermes-main",
        ts: "2026-08-30T08:00:00.000Z",
        overall: "healthy",
        confidence: 0.96,
        checks: [
          {
            id: "api-connectivity",
            status: "pass",
            detail: "接口可用",
            durationMs: 42,
          },
        ],
      },
    ];

    const html = renderToStaticMarkup(
      React.createElement(InstanceHealthCard, { instances, inspections }),
    );

    expect(html).toContain("Hermes");
    expect(html).toContain("0.20.4");
    expect(html).toContain("正常");
    expect(html).toContain("服务是否能连接");
  });

  it("排查向导现象选择提供键盘可达的选项", () => {
    const html = renderToStaticMarkup(
      React.createElement(SymptomStep, { busy: false, onChoose: () => undefined }),
    );

    expect(html).toContain("哪里不对劲？");
    expect(html).toContain('role="button"');
    expect(html).toContain("它不回我消息了");
    expect(html).toContain("更新之后就不对了");
  });

  it("排查向导动作步骤同时展示推荐和风险影响", () => {
    const action: RecoveryActionView = {
      id: "reconnect-channel",
      label: "重新连接消息通道",
      description: "重新建立消息通道连接。",
      risk: "low",
      impact: "消息可能短暂延迟",
      estimatedSeconds: 20,
      requiresConfirmation: true,
      available: true,
    };

    const html = renderToStaticMarkup(
      React.createElement(ActionStep, {
        ranked: [action],
        recommended: action,
        selected: action.id,
        symptom: "no-reply",
        busy: false,
        onSelect: () => undefined,
        onBack: () => undefined,
        onRun: () => undefined,
      }),
    );

    expect(html).toContain("重新连接消息通道");
    expect(html).toContain("推荐");
    expect(html).toContain("不影响使用");
    expect(html).toContain("执行「重新连接消息通道」");
  });

  it("诊断区明确本机结果摘要的证据边界", () => {
    const html = renderToStaticMarkup(
      React.createElement(DiagnosticsCenter, { actionBusy: false }),
    );

    expect(html).toContain("最近本机结果");
    expect(html).toContain("正在读取本机操作记录");
  });
});
