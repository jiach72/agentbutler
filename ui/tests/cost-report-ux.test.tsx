/**
 * 成本审计与周报中心 (Cost & Report) UI/UX 规范与无障碍测试
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App as AntApp } from "antd";
import { describe, expect, it } from "vitest";
import { DailyCostChart } from "../src/pages/cost/DailyCostChart.js";

const mockDays = [
  { date: "2026-09-20", tokens: 12000, estimatedCostUsd: 0.12, actualCostUsd: 0.12 },
  { date: "2026-09-21", tokens: 45000, estimatedCostUsd: 0.45, actualCostUsd: 0.45 },
  { date: "2026-09-22", tokens: 8000, estimatedCostUsd: 0.08, actualCostUsd: 0.08 },
  { date: "2026-09-23", tokens: 30000, estimatedCostUsd: 0.30, actualCostUsd: 0.30 },
];

describe("成本趋势图表 (DailyCostChart) UI/UX 与工效测试", () => {
  it("柱状图模式渲染完整指标 HUD 与全键盘无障碍属性", () => {
    const html = renderToStaticMarkup(
      <React.StrictMode>
        <AntApp>
          <DailyCostChart days={mockDays} maxDayCost={0.45} totalCost={0.95} />
        </AntApp>
      </React.StrictMode>
    );

    // 顶部 HUD 统计
    expect(html).toContain("峰值");
    expect(html).toContain("日均");
    expect(html).toContain("合计");
    expect(html).toContain("柱状分布");
    expect(html).toContain("平滑趋势");

    // 全键盘无障碍 role 与 aria-label
    expect(html).toContain('role="img"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("2026-09-21");

    // 消除写死色彩与非法圆角
    expect(html).not.toContain("#2997ff");
    expect(html).not.toContain("1.5px");
    expect(html).toContain("var(--ab-primary)");
  });
});
