/**
 * 专家工具工作台（ToolsPage）UI/UX 与无障碍交互测试
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { App as AntApp } from "antd";
import { describe, expect, it } from "vitest";
import { ToolsPage } from "../src/pages/tools/ToolsPage.js";

function renderToolsPage(): string {
  return renderToStaticMarkup(
    <React.StrictMode>
      <MemoryRouter>
        <AntApp>
          <ToolsPage />
        </AntApp>
      </MemoryRouter>
    </React.StrictMode>
  );
}

describe("专家工具工作台 (ToolsPage)", () => {
  it("首屏完整渲染标题、结论条与体检卡片", () => {
    const html = renderToolsPage();

    expect(html).toContain("专家工具");
    expect(html).toContain("宿主机一键体检命令");
    expect(html).toContain("node scripts/doctor.mjs");
    expect(html).toContain("复制安装体检命令");
    expect(html).toContain("直达链路体检");
    expect(html).toContain("直达排障助手");
    expect(html).toContain("直达系统日志");
    expect(html).toContain("直达核心文件");
  });

  it("内联导航按钮采用无感 SPA 路由，杜绝硬刷新 href 穿透", () => {
    const html = renderToolsPage();

    // 快捷按钮应作为 button 渲染由 onClick navigate 控制，而非原生 a 标签携带站内 href
    expect(html).not.toMatch(/<a[^>]*ant-btn[^>]*href="\/troubleshoot"/);
    expect(html).not.toMatch(/<a[^>]*ant-btn[^>]*href="\/setup"/);
    expect(html).not.toMatch(/<a[^>]*ant-btn[^>]*href="\/logs"/);
    expect(html).not.toMatch(/<a[^>]*ant-btn[^>]*href="\/core-files"/);
  });

  it("渲染诊断与维护、核心资产与审计深度分析专区", () => {
    const html = renderToolsPage();

    expect(html).toContain("专家工具 · 诊断与维护");
    expect(html).toContain("连接体检");
    expect(html).toContain("排障助手");
    expect(html).toContain("系统日志");
    expect(html).toContain("核心配置与资产维护");
    expect(html).toContain("核心文件");
    expect(html).toContain("记忆系统中心");
    expect(html).toContain("升级策略");
    expect(html).toContain("审计追踪与深度分析");
    expect(html).toContain("行为审计");
    expect(html).toContain("会话追踪");
    expect(html).toContain("记忆变更");
  });

  it("首屏渲染专家工具即时检索框与 Hermes 速查命令", () => {
    const html = renderToolsPage();
    expect(html).toContain("搜索专家工具或报表");
    expect(html).toContain("Hermes 引擎指引与常用运维命令");
    expect(html).toContain("systemctl --user status hermes-gateway");
  });
});
