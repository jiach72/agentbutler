import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("即时通讯与知识库入口优化契约", () => {
  const mainSource = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const layoutSource = readFileSync(new URL("../src/components/Layout.tsx", import.meta.url), "utf8");
  const dashboardSource = readFileSync(new URL("../src/pages/dashboard/DashboardPage.tsx", import.meta.url), "utf8");

  it("main.tsx 声明了 /im 和 /chat 语义别名路由直达 /gateway?tab=im", () => {
    expect(mainSource).toContain('path="/im"');
    expect(mainSource).toContain('path="/chat"');
    expect(mainSource).toContain('to="/gateway?tab=im"');
  });

  it("main.tsx 声明了 /kb 和 /docs 语义别名路由直达 /knowledge", () => {
    expect(mainSource).toContain('path="/kb"');
    expect(mainSource).toContain('path="/docs"');
    expect(mainSource).toContain('to="/knowledge"');
  });

  it("main.tsx 使用 RedirectWithSearch 保留原请求的 query 参数 (如 prefill)", () => {
    expect(mainSource).toContain("RedirectWithSearch");
    expect(mainSource).toContain("new URLSearchParams(location.search)");
  });

  it("Layout.tsx 顶栏常驻即时通讯快捷按钮", () => {
    expect(layoutSource).toContain('to="/gateway?tab=im"');
    expect(layoutSource).toContain("即时通讯工作台 (⌘I / Ctrl+I)");
  });

  it("Layout.tsx 支持 ⌘I / Ctrl+I 全局快捷键呼出即时通讯", () => {
    expect(layoutSource).toContain('key.toLowerCase() === "i"');
    expect(layoutSource).toContain('navigate("/gateway?tab=im")');
  });

  it("Layout.tsx ⌘K 搜索面板支持 im, chat, kb 等缩写置顶匹配", () => {
    expect(layoutSource).toContain('"im", "chat", "msg", "talk"');
    expect(layoutSource).toContain('"kb", "rag", "doc", "knowledge"');
  });

  it("DashboardPage 随手吩咐支持发往对话与排程任务双通道分流", () => {
    expect(dashboardSource).toContain('mode: "im" | "task" = "im"');
    expect(dashboardSource).toContain("发往对话");
    expect(dashboardSource).toContain("排程任务");
    expect(dashboardSource).toContain("Shift+Enter");
  });

  it("DashboardPage 快捷标签醒目突出即时通讯与本地知识库", () => {
    expect(dashboardSource).toContain('to="/gateway?tab=im"');
    expect(dashboardSource).toContain('to="/knowledge"');
    expect(dashboardSource).toContain("直接打开即时通讯对话工作台");
  });
});
