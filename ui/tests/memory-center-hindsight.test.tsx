import React from "react";
import { App } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryCenterPage } from "../src/pages/memory/MemoryCenterPage.js";

describe("MemoryCenterPage Hindsight 控制台与星图集成", () => {
  it("静态渲染正常加载 Hindsight 知识图谱控制台、直达链接与记忆星图", () => {
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

    // 验证 Constellation Canvas 存在
    expect(html).toContain("<canvas");

    // 验证底层四层认知事实分类
    expect(html).toContain("World");
    expect(html).toContain("Experience");
    expect(html).toContain("Observation");
    expect(html).toContain("Entity");
  });
});
