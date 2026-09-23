import React from "react";
import { App } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KnowledgeConfigCard } from "../src/pages/settings/KnowledgeConfigCard.js";

describe("本地知识库设置的信息层级", () => {
  it("服务技术规格默认收起，并以原生键盘可操作的 summary 暴露", () => {
    const html = renderToStaticMarkup(
      React.createElement(App, null, React.createElement(KnowledgeConfigCard)),
    );

    expect(html).toMatch(/<details(?:\s[^>]*)?>/);
    expect(html).not.toMatch(/<details[^>]*\bopen(?:\s|=|>)/);
    expect(html).toContain("<summary>服务技术规格与配置参数</summary>");
    expect(html).toContain("anythingllm-data");
  });
});
