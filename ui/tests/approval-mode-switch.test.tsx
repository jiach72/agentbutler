import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ApprovalModeSwitch } from "../src/components/ApprovalModeSwitch.js";
import { ThemeProvider } from "../src/theme/ThemeProvider.js";

function render(): string {
  return renderToStaticMarkup(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        MemoryRouter,
        { initialEntries: ["/dashboard"] },
        React.createElement(ApprovalModeSwitch),
      ),
    ),
  );
}

describe("侧栏放行模式开关", () => {
  it("读不到数据时显示「读取中」，不谎称当前模式、也不显示待处理条数", () => {
    const html = render();
    expect(html).toContain("高危动作");
    expect(html).toContain("读取中");
    expect(html).toContain("正在读取放行模式");
    // 模式未知时开关不给勾选态，待处理区块也不渲染——不确定的时候不能装作确定。
    expect(html).not.toContain("条待处理");
    expect(html).not.toContain("sidebar-approval-mode is-warn");
  });

  it("开关带无障碍标签，模式行与说明行结构完整", () => {
    const html = render();
    expect(html).toContain('aria-label="全部允许模式"');
    expect(html).toContain("sidebar-approval-mode");
    expect(html).toContain("sidebar-approval-mode-note");
  });
});
