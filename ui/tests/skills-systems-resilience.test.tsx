import React from "react";
import { App } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary.js";
import { MemoryCenterPage } from "../src/pages/memory/MemoryCenterPage.js";

describe("Skills & Memory Systems Resilience", () => {
  it("ErrorBoundary.getDerivedStateFromError derives error state properly", () => {
    const testError = new Error("Test intentional crash in child tab");
    const derived = ErrorBoundary.getDerivedStateFromError(testError);
    expect(derived.hasError).toBe(true);
    expect(derived.error).toBe(testError);
  });

  it("ErrorBoundary renders fallback UI when in error state", () => {
    const boundary = new ErrorBoundary({
      fallbackTitle: "测试错误捕获视图",
      children: React.createElement("div", null, "正常内容"),
    });
    boundary.state = {
      hasError: true,
      error: new Error("Test intentional crash in child tab"),
    };

    const rendered = boundary.render();
    const html = renderToStaticMarkup(React.createElement(React.Fragment, null, rendered));

    expect(html).toContain("测试错误捕获视图");
    expect(html).toContain("Test intentional crash in child tab");
    expect(html).toContain("重试加载组件");
  });

  it("ErrorBoundary passes through children normally when healthy", () => {
    function HealthyComponent(): React.ReactElement {
      return React.createElement("div", { id: "healthy-node" }, "正常内容");
    }

    const html = renderToStaticMarkup(
      React.createElement(
        ErrorBoundary,
        { fallbackTitle: "测试健康视图" },
        React.createElement(HealthyComponent, null),
      ),
    );

    expect(html).toContain("healthy-node");
    expect(html).toContain("正常内容");
    expect(html).not.toContain("重试加载组件");
  });

  it("MemoryCenterPage does not throw when rendered with isTab=true", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        App,
        null,
        React.createElement(MemoryCenterPage, {
          isTab: true,
        }),
      ),
    );
    expect(html).toContain("Hindsight 知识图谱记忆控制台");
    expect(html).toContain("TypeSafe Jev 智能选型与决策中枢");
  });
});
