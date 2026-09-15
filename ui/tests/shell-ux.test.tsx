import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { Layout } from "../src/components/Layout.js";
import { MobileTabBar } from "../src/components/MobileTabBar.js";
import { PageHeader } from "../src/components/PageHeader.js";
import { ThemeProvider } from "../src/theme/ThemeProvider.js";

function renderAt(path: string, element: React.ReactNode): string {
  return renderToStaticMarkup(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>{element}</MemoryRouter>
    </ThemeProvider>,
  );
}

describe("公共界面的任务入口", () => {
  it("整个布局只挂载一个急停控件", () => {
    const html = renderAt("/dashboard", <Layout />);
    expect(html.match(/aria-label="读取急停状态"/g)).toHaveLength(1);
  });

  it("手机只有首页、任务、消息、设置四个入口", () => {
    const html = renderAt("/tasks", <MobileTabBar />);
    for (const path of ["/dashboard", "/tasks", "/gateway", "/settings"]) {
      expect(html).toContain(`href="${path}"`);
    }
    expect(html).not.toContain('aria-label="更多导航"');
    expect(html.match(/href="/g)).toHaveLength(4);
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain("急停");
  });

  it("详情路径仍选中对应手机主入口，前缀相似但不同的路由不误选", () => {
    const nested = renderAt("/tasks/details", <MobileTabBar />);
    expect(nested).toMatch(/href="\/tasks"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/tasks"/);
    const unknown = renderAt("/tasks-other", <MobileTabBar />);
    expect(unknown).not.toContain('aria-current="page"');
  });

  it("页标题不自动重复已经在导航里的分组名", () => {
    const html = renderAt("/gateway", <PageHeader title="消息通知" />);
    expect(html).not.toContain("控制台");
    expect(html).not.toContain("日常使用");
    expect(html).toContain(">消息通知</h1>");
  });

  it("明确提供的业务上下文仍可展示", () => {
    const html = renderAt("/gateway", <PageHeader title="消息通知" eyebrow="待处理记录" />);
    expect(html).toContain("待处理记录");
  });
});

describe("访问口令提示与部署方式解耦", () => {
  const source = readFileSync(new URL("../src/components/AccessGate.tsx", import.meta.url), "utf8");

  it("不再承诺本机地址免口令", () => {
    expect(source).toContain("当前部署需要访问口令");
    expect(source).not.toContain("只有从其他设备访问时才需要口令");
    expect(source).not.toContain("免输入口令");
  });

  it("保留密码输入，并使用可提交的表单", () => {
    expect(source).toContain("<Input.Password");
    expect(source).toContain("<form");
    expect(source).toContain('htmlType="submit"');
    expect(source).toContain('autoComplete="current-password"');
  });
});
