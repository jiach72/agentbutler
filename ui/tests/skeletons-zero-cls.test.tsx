import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StatStrip } from "../src/components/StatStrip.js";

describe("StatStrip Zero-CLS Skeleton Loading (Round 21)", () => {
  it("renders the requested number of skeleton placeholder cards when loading and items are empty", () => {
    const html = renderToStaticMarkup(
      <StatStrip items={[]} loading={true} skeletonCount={5} />
    );

    expect(html).toContain('aria-label="概览统计加载中"');
    // Verify ethereal-stat-card rendered 5 times
    const matches = html.match(/ethereal-stat-card/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(5);
    // Ant Design Skeleton placeholder element
    expect(html).toContain("ant-skeleton");
  });

  it("renders actual stats immediately without skeletons when items are present", () => {
    const html = renderToStaticMarkup(
      <StatStrip
        loading={false}
        items={[
          { key: "cost", label: "本周成本", value: "128.50", unit: "元" },
          { key: "events", label: "活跃事件", value: 3, unit: "个" },
        ]}
      />
    );

    expect(html).not.toContain('aria-label="概览统计加载中"');
    expect(html).toContain('aria-label="概览统计"');
    expect(html).toContain("本周成本");
    expect(html).toContain("128.50");
    expect(html).toContain("活跃事件");
    expect(html).toContain("3");

    const matches = html.match(/ethereal-stat-card/g);
    expect(matches!.length).toBe(2);
  });

  it("renders normal container without crashing when items are empty and loading is false", () => {
    const html = renderToStaticMarkup(<StatStrip items={[]} loading={false} />);
    expect(html).toContain('aria-label="概览统计"');
    expect(html).not.toContain("ethereal-stat-card");
  });
});
