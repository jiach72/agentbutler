/**
 * 核心文件 (CoreFilesPage) 与系统日志 (LogsPage) UI/UX 规范与无障碍测试
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App as AntApp } from "antd";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "../src/theme/ThemeProvider.js";
import { CoreFilesPage } from "../src/pages/CoreFilesPage.js";
import { LogsPage } from "../src/pages/Logs.js";

describe("核心文件与系统日志 (CoreFilesPage & LogsPage) UI/UX 与工效测试", () => {
  it("CoreFilesPage 正常渲染核心文件标题、实例选择器与全量无障碍工具按钮", () => {
    const html = renderToStaticMarkup(
      <React.StrictMode>
        <ThemeProvider>
          <AntApp>
            <MemoryRouter>
              <CoreFilesPage />
            </MemoryRouter>
          </AntApp>
        </ThemeProvider>
      </React.StrictMode>
    );

    // 页面标题与卡片
    expect(html).toContain("核心文件");
    expect(html).toContain("文件清单");

    // 全键盘与操作按钮无障碍
    expect(html).toContain('aria-label="选择实例"');
    expect(html).toContain('aria-label="搜索核心文件"');
    expect(html).toContain("搜索核心文件 (如: SOPS, memory, config, prompt)...");
    expect(html).toContain('aria-label="刷新核心文件列表"');
    expect(html).toContain('aria-label="立即备份当前文件"');
    expect(html).toContain('aria-label="下载当前文件"');
  });

  it("LogsPage 正常渲染系统日志标题、结论条与无障碍跳转按钮", () => {
    const html = renderToStaticMarkup(
      <React.StrictMode>
        <ThemeProvider>
          <AntApp>
            <MemoryRouter>
              <LogsPage />
            </MemoryRouter>
          </AntApp>
        </ThemeProvider>
      </React.StrictMode>
    );

    // 页面标题与结论条
    expect(html).toContain("系统日志");
    expect(html).toContain("日志记录不等于当前故障");

    // SPA 无刷新路由按钮无障碍
    expect(html).toContain('aria-label="前往排查当前问题"');
    expect(html).toContain("排查当前问题");
  });
});
