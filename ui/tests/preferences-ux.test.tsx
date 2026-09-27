/**
 * 偏好设置 (Preferences) UI/UX 规范与无障碍测试
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App as AntApp } from "antd";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "../src/theme/ThemeProvider.js";
import { PreferencesPage, PreferencesPanel } from "../src/pages/preferences/PreferencesPage.js";

describe("偏好设置 (PreferencesPage & PreferencesPanel) UI/UX 与工效测试", () => {
  it("PreferencesPanel 正常渲染主题切换与通知设置，包含完整无障碍标签", () => {
    const html = renderToStaticMarkup(
      <React.StrictMode>
        <ThemeProvider>
          <AntApp>
            <PreferencesPanel />
          </AntApp>
        </ThemeProvider>
      </React.StrictMode>
    );

    // 主题与通知模块卡片
    expect(html).toContain("外观 · 界面主题");
    expect(html).toContain("通知 · 重要通知");
    expect(html).toContain("测试通知");

    // 全键盘与无障碍属性
    expect(html).toContain('aria-label="界面主题切换"');
    expect(html).toContain('aria-label="右上角未读徽标开关"');
    expect(html).toContain('aria-label="通知范围分级筛选"');

    // 辅助与效率 · 快捷按键速查与重置默认偏好
    expect(html).toContain("辅助与效率 · 快捷按键速查");
    expect(html).toContain("恢复默认偏好");
    expect(html).toContain("Esc");
    expect(html).toContain("Enter");
  });

  it("PreferencesPage 正常渲染独立页面与结论条", () => {
    const html = renderToStaticMarkup(
      <React.StrictMode>
        <ThemeProvider>
          <AntApp>
            <PreferencesPage />
          </AntApp>
        </ThemeProvider>
      </React.StrictMode>
    );

    // 页面标题与结论条
    expect(html).toContain("偏好设置");
    expect(html).toContain("偏好即改即存");
    expect(html).toContain("偏好已即改即存");
  });
});
