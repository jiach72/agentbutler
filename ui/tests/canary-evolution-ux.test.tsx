/**
 * 升级策略 (CanaryPage) 与系统自进化 (EvolutionPage) UI/UX 规范与无障碍测试
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App as AntApp } from "antd";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "../src/theme/ThemeProvider.js";
import { CanaryPage } from "../src/pages/canary/CanaryPage.js";
import { EvolutionPage } from "../src/pages/evolution/EvolutionPage.js";

describe("系统演进与金丝雀灰度 (CanaryPage & EvolutionPage) UI/UX 与工效测试", () => {
  it("CanaryPage 正常渲染升级策略、准入判据、版本策略单选与无障碍刷新巡检按钮", () => {
    const html = renderToStaticMarkup(
      <React.StrictMode>
        <ThemeProvider>
          <AntApp>
            <MemoryRouter>
              <CanaryPage />
            </MemoryRouter>
          </AntApp>
        </ThemeProvider>
      </React.StrictMode>
    );

    // 页面标题与卡片
    expect(html).toContain("升级策略");
    expect(html).toContain("版本策略");
    expect(html).toContain("准入判据（三条全过才自动切换）");
    expect(html).toContain("金丝雀验证记录");

    // 全键盘与操作按钮无障碍
    expect(html).toContain('aria-label="刷新升级验证记录"');
    expect(html).toContain('aria-label="立即巡检观察窗"');
  });

  it("EvolutionPage 正常渲染自进化工作台、结论条、实例范围选择与重新分析按钮", () => {
    const html = renderToStaticMarkup(
      <React.StrictMode>
        <ThemeProvider>
          <AntApp>
            <MemoryRouter>
              <EvolutionPage />
            </MemoryRouter>
          </AntApp>
        </ThemeProvider>
      </React.StrictMode>
    );

    // 页面标题与分析范围卡片
    expect(html).toContain("自进化");
    expect(html).toContain("日志中的改进方向");

    // 操作与范围选择无障碍
    expect(html).toContain('aria-label="选择实例范围"');
    expect(html).toContain('aria-label="重新分析日志改进方向"');
  });
});
