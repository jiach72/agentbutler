/**
 * 诊断与维护中心 (DiagnosticsCenter) UI/UX 规范与可用性测试
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App as AntApp } from "antd";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "../src/theme/ThemeProvider.js";
import { DiagnosticsCenter } from "../src/pages/settings/DiagnosticsCenter.js";

describe("诊断与维护中心 (DiagnosticsCenter) UI/UX 与工效测试", () => {
  it("正常渲染脱敏矩阵、生成报告与打包下载操作", () => {
    const html = renderToStaticMarkup(
      <React.StrictMode>
        <ThemeProvider>
          <AntApp>
            <DiagnosticsCenter actionBusy={false} />
          </AntApp>
        </ThemeProvider>
      </React.StrictMode>
    );

    // 核心脱敏标题与标签
    expect(html).toContain("脱敏诊断报告与打包导出");
    expect(html).toContain("100% 隐私脱敏");
    expect(html).toContain("隐私安全与脱敏矩阵");
    expect(html).toContain("密钥令牌 100% 自动剥离");

    // 操作按钮
    expect(html).toContain("生成诊断报告");
    expect(html).toContain("打包下载 ZIP");

    // 本机维护审计与指标透视
    expect(html).toContain("安全凭据合规");
    expect(html).toContain("最近本机结果");
  });

  it("当操作忙时正确禁用操作按钮", () => {
    const html = renderToStaticMarkup(
      <React.StrictMode>
        <ThemeProvider>
          <AntApp>
            <DiagnosticsCenter actionBusy={true} />
          </AntApp>
        </ThemeProvider>
      </React.StrictMode>
    );

    expect(html).toContain("disabled");
  });
});
