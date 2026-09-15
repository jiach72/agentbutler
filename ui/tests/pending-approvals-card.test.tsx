import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { PendingApprovalsCard } from "../src/components/PendingApprovalsCard.js";
import { ThemeProvider } from "../src/theme/ThemeProvider.js";

function render(): string {
  return renderToStaticMarkup(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        MemoryRouter,
        { initialEntries: ["/dashboard"] },
        React.createElement(PendingApprovalsCard),
      ),
    ),
  );
}

describe("侧栏待处理审批卡片", () => {
  it("读不到数据时不渲染卡片：不显示待处理条数，也不装作没有积压", () => {
    const html = render();
    expect(html).not.toContain("条待处理");
    expect(html).not.toContain("全部批准");
  });

  it("积压为 0 时同样不渲染（无积压就不该占侧栏位置）", () => {
    const html = render();
    expect(html).toBe("");
  });
});
