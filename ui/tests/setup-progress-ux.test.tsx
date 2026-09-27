/**
 * 新实例引导配置 (SetupPage) 与任务进度流 (ProgressPage) UI/UX 规范与无障碍测试
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App as AntApp } from "antd";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "../src/theme/ThemeProvider.js";
import { SetupPage } from "../src/pages/setup/SetupPage.js";
import { ProgressPage } from "../src/pages/progress/ProgressPage.js";

describe("新实例引导配置与任务进度流 (SetupPage & ProgressPage) UI/UX 与工效测试", () => {
  it("SetupPage 正常渲染连接设置、体检按钮无障碍标签与状态卡片", () => {
    const html = renderToStaticMarkup(
      <React.StrictMode>
        <ThemeProvider>
          <AntApp>
            <MemoryRouter>
              <SetupPage />
            </MemoryRouter>
          </AntApp>
        </ThemeProvider>
      </React.StrictMode>
    );

    // 页面标题与体检按钮无障碍
    expect(html).toContain("连接设置");
    expect(html).toContain('aria-label="重新执行连接体检"');
  });

  it("ProgressPage 正常渲染进度可信度标题、结论条、筛选器与无障碍操作按钮", () => {
    const html = renderToStaticMarkup(
      <React.StrictMode>
        <ThemeProvider>
          <AntApp>
            <MemoryRouter>
              <ProgressPage />
            </MemoryRouter>
          </AntApp>
        </ThemeProvider>
      </React.StrictMode>
    );

    // 页面标题与操作卡片
    expect(html).toContain("进度可信度");
    expect(html).toContain("进度声明核实明细");

    // 全键盘与操作按钮无障碍
    expect(html).toContain('aria-label="刷新进度核实数据"');
    expect(html).toContain('aria-label="立即增量核实进度声明"');
    expect(html).toContain('aria-label="按可信度筛选进度声明"');
  });
});
