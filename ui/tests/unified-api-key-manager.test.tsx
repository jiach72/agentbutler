import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App, ConfigProvider } from "antd";
import { MemoryRouter } from "react-router-dom";
import { UnifiedApiKeyManager } from "../src/pages/settings/UnifiedApiKeyManager.js";
import { SettingsPage } from "../src/pages/settings/SettingsPage.js";
import { ThemeProvider } from "../src/theme/ThemeProvider.js";

describe("UnifiedApiKeyManager", () => {
  it("UnifiedApiKeyManager 正常渲染标题、统计卡、分类切换与操作按钮", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        ConfigProvider,
        null,
        React.createElement(
          App,
          null,
          React.createElement(UnifiedApiKeyManager),
        ),
      ),
    );

    expect(html).toContain("API 密钥与服务中心");
    expect(html).toContain("API 凭据");
    expect(html).toContain("添加 API Key");
    expect(html).toContain("同步至 Hermes");
    expect(html).toContain("全部");
    expect(html).toContain("网络搜索");
    expect(html).toContain("视觉多模态");
    expect(html).toContain("大语言模型");
    expect(html).toContain("受管服务总数");
  });

  it("SettingsPage 包含 API 密钥与服务分类及 API 密钥管理 Tab", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(
          ConfigProvider,
          null,
          React.createElement(
            App,
            null,
            React.createElement(
              MemoryRouter,
              { initialEntries: ["/settings?tab=llm"] },
              React.createElement(SettingsPage),
            ),
          ),
        ),
      ),
    );

    expect(html).toContain("API 密钥管理");
    expect(html).toContain("高级模型配置");
    expect(html).toContain("Ollama 本地模型");
    expect(html).toContain("通知与偏好");
  });
});
