import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorBoundary } from "../src/components/ErrorBoundary.js";

// Mock window for SSR environment
const globalWithWindow = globalThis as unknown as { window?: unknown };
if (typeof globalWithWindow.window === "undefined") {
  globalWithWindow.window = {
    history: { pushState: vi.fn() },
    dispatchEvent: vi.fn(),
    location: { href: "http://localhost:5173/" },
  };
}

function HealthyComponent() {
  return <div id="healthy-content">核心业务视图正常运行</div>;
}

function _BrokenComponent(): React.ReactNode {
  throw new Error("模拟异常：异步数据反序列化失败，字段格式不匹配");
}

describe("ErrorBoundary UI/UX 崩溃隔离与自愈交互", () => {
  it("正常渲染：子组件无异常时透明透传，不渲染任何错误边界容器", () => {
    const html = renderToStaticMarkup(
      <ErrorBoundary fallbackTitle="页面视图加载异常">
        <HealthyComponent />
      </ErrorBoundary>,
    );

    expect(html).toContain("核心业务视图正常运行");
    expect(html).not.toContain("页面视图加载异常");
    expect(html).not.toContain("role=\"alert\"");
  });

  it("异常隔离：子组件抛出异常时安全隔离，展示高保真保护文案与三级恢复动作", () => {
    // Suppress console.error in vitest output for intentional error boundary test
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Use ErrorBoundary's static lifecycle directly for SSR testing
    const boundary = new ErrorBoundary({
      children: <HealthyComponent />,
      fallbackTitle: "知识库星图视图受阻",
    });

    // Simulate error state
    boundary.state = {
      hasError: true,
      error: new Error("模拟异常：WebGL 上下文丢失"),
      errorInfo: { componentStack: "\n    at BrokenComponent\n    at KnowledgeStarChart" } as React.ErrorInfo,
      copied: false,
    };

    const html = renderToStaticMarkup(boundary.render());

    // 1. 验证友好标题与受控隔离文案
    expect(html).toContain("知识库星图视图受阻");
    expect(html).toContain("为保护全局系统控制台，管家已对该区域执行安全隔离");
    expect(html).toContain("侧边导航、紧急熔断与后端服务均保持正常可用");

    // 2. 验证错误信息摘要
    expect(html).toContain("模拟异常：WebGL 上下文丢失");

    // 3. 验证三级自愈与导航动作
    expect(html).toContain("重试加载组件");
    expect(html).toContain("返回系统仪表盘");
    expect(html).toContain("前往排障与自愈向导");

    // 4. 验证技术堆栈折叠层与复制按钮
    expect(html).toContain("查看技术诊断信息与组件堆栈");
    expect(html).toContain("复制完整诊断信息");
    expect(html).toContain("KnowledgeStarChart");

    consoleSpy.mockRestore();
  });

  it("紧凑模式：支持 compact 紧凑状态，适合小型卡片或微组件隔离", () => {
    const boundary = new ErrorBoundary({
      children: <HealthyComponent />,
      fallbackTitle: "微组件加载异常",
      compact: true,
    });

    boundary.state = {
      hasError: true,
      error: new Error("单卡片指标计算超时"),
      errorInfo: null,
      copied: false,
    };

    const html = renderToStaticMarkup(boundary.render());

    expect(html).toContain("微组件加载异常");
    expect(html).toContain("重试加载");
    expect(html).not.toContain("返回系统仪表盘");
  });
});
