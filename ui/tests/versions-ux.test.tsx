/**
 * 设置中心 · 关于面板与版本管理人机工效测试
 */
import React from "react";
import { App as AntApp } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { VersionsPanel } from "../src/pages/versions/VersionsPage.js";
import { ThemeProvider } from "../src/theme/ThemeProvider.js";

describe("设置中心 · 关于与平滑升级 (VersionsPanel)", () => {
  it("渲染管家版本信息卡与状态结论条", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ThemeProvider>
          <AntApp>
            <VersionsPanel />
          </AntApp>
        </ThemeProvider>
      </MemoryRouter>
    );

    expect(html).toContain("管家 Butler");
    expect(html).toContain("版本");
    expect(html).toContain("管家已是最新版本");
  });

  it("折叠行具备键盘无障碍支持 (tabIndex=0 与 role=button)", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ThemeProvider>
          <AntApp>
            <VersionsPanel />
          </AntApp>
        </ThemeProvider>
      </MemoryRouter>
    );

    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("受管实例版本与候选升级");
    expect(html).toContain("更新偏好");
    expect(html).toContain("回滚管家自身");
    expect(html).toContain("还原受管实例（备份）");
    expect(html).toContain("备份节奏趋势");
  });
});
