/**
 * 会话追踪 (Sessions) UI/UX 规范与无障碍测试
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App as AntApp } from "antd";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SessionsPage } from "../src/pages/sessions/SessionsPage.js";
import { SessionDetailPage } from "../src/pages/sessions/SessionDetailPage.js";

describe("会话追踪 (SessionsPage & SessionDetailPage) UI/UX 与工效测试", () => {
  it("SessionsPage 正常渲染标题、刷新与重建按钮、结论条与表格容器", () => {
    const html = renderToStaticMarkup(
      <React.StrictMode>
        <AntApp>
          <MemoryRouter>
            <SessionsPage />
          </MemoryRouter>
        </AntApp>
      </React.StrictMode>
    );

    // 页面标题与操作按钮无障碍
    expect(html).toContain("会话追踪");
    expect(html).toContain('aria-label="刷新会话列表"');
    expect(html).toContain('aria-label="立即重建会话索引"');

    // 结论条
    expect(html).toContain("正在加载会话索引");

    // 会话列表容器与筛选
    expect(html).toContain("会话列表");
    expect(html).toContain('aria-label="搜索会话"');
    expect(html).toContain("搜索会话 ID / 模型 / 任务类型...");
    expect(html).toContain('aria-label="按会话终态筛选"');
  });

  it("SessionDetailPage 正常渲染返回列表按钮与隐私边界提示", () => {
    const html = renderToStaticMarkup(
      <React.StrictMode>
        <AntApp>
          <MemoryRouter>
            <SessionDetailPage />
          </MemoryRouter>
        </AntApp>
      </React.StrictMode>
    );

    // 返回按钮无障碍
    expect(html).toContain('aria-label="返回会话追踪列表"');
    expect(html).toContain("隐私边界");
  });
});
