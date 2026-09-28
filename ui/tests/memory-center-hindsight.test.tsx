import React from "react";
import { App } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryCenterPage } from "../src/pages/memory/MemoryCenterPage.js";

describe("MemoryCenterPage Hindsight 控制台与星图集成", () => {
  it("静态渲染正常加载 Hindsight 知识图谱控制台，星图直接内嵌官方 Control Plane 数据视图", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        App,
        null,
        React.createElement(MemoryCenterPage, {
          isTab: false,
        }),
      ),
    );

    // 验证 Hindsight 专区标题与端口标记
    expect(html).toContain("Hindsight 知识图谱记忆控制台");
    expect(html).toContain("API :9177 | UI :9999");

    // 验证直达官方 Web UI 与内嵌控制台操作
    expect(html).toContain("直达官方 Web UI (:9999)");
    expect(html).toContain("内嵌官方控制台");
    expect(html).toContain("http://127.0.0.1:9999");

    // 验证星图与演练场 Tab
    expect(html).toContain("记忆星图");
    expect(html).toContain("召回演练场");

    // 星图 Tab 直接 iframe 官方 Control Plane 数据视图（不自绘拓扑）
    expect(html).toContain(`src="http://127.0.0.1:9999/banks/hermes?view=data"`);
    expect(html).toContain(`title="Hindsight Memory Constellation"`);
    expect(html).toContain("新标签打开星图");

    // 自研星图已移除：不再渲染本地 canvas 拓扑
    expect(html).not.toContain("<canvas");
  });
});
