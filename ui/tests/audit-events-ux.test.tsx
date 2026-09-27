/**
 * 行为审计 (AuditPage) 与事件中心 (EventsPage) UI/UX 规范与无障碍测试
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App as AntApp } from "antd";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AuditPage } from "../src/pages/audit/AuditPage.js";
import { EventsPage } from "../src/pages/events/EventsPage.js";

describe("行为审计与事件中心 (AuditPage & EventsPage) UI/UX 与工效测试", () => {
  it("AuditPage 正常渲染行为审计标题、结论条与全量无障碍筛选器", () => {
    const html = renderToStaticMarkup(
      <React.StrictMode>
        <AntApp>
          <MemoryRouter>
            <AuditPage />
          </MemoryRouter>
        </AntApp>
      </React.StrictMode>
    );

    // 页面标题与动作时间线
    expect(html).toContain("行为审计");
    expect(html).toContain("动作时间线");

    // 全量工效无障碍筛选器
    expect(html).toContain('aria-label="选择审计时间范围"');
    expect(html).toContain('aria-label="筛选动作类型"');
    expect(html).toContain('aria-label="筛选严重级别"');
  });

  it("EventsPage 正常渲染事件中心标题、状态筛选器与列表容器", () => {
    const html = renderToStaticMarkup(
      <React.StrictMode>
        <AntApp>
          <MemoryRouter>
            <EventsPage />
          </MemoryRouter>
        </AntApp>
      </React.StrictMode>
    );

    // 页面标题与卡片
    expect(html).toContain("事件中心");
    expect(html).toContain("事件列表");

    // 状态筛选分段控制器与即时搜索无障碍
    expect(html).toContain('aria-label="按事件处理状态筛选"');
    expect(html).toContain('aria-label="搜索事件"');
    expect(html).toContain("搜索事件标题 / 类型");
  });
});
