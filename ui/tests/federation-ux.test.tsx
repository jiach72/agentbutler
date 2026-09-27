/**
 * 实例联邦 (Federation) UI/UX 规范与无障碍测试
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App as AntApp } from "antd";
import { describe, expect, it } from "vitest";
import { FederationPage } from "../src/pages/federation/FederationPage.js";

describe("实例联邦 (FederationPage) UI/UX 与工效测试", () => {
  it("首屏正常渲染标题、刷新按钮、结论条与实例表格容器", () => {
    const html = renderToStaticMarkup(
      <React.StrictMode>
        <AntApp>
          <FederationPage />
        </AntApp>
      </React.StrictMode>
    );

    // 页面标题与刷新按钮无障碍
    expect(html).toContain("实例联邦");
    expect(html).toContain('aria-label="刷新实例联邦数据"');

    // 结论条
    expect(html).toContain("正在合并各实例视图");

    // 实例明细卡片
    expect(html).toContain("实例明细");
  });
});
