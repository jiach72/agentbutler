import React from "react";
import { readFileSync } from "node:fs";
import { App } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { PrimaryModelCard } from "../src/pages/settings/PrimaryModelCard.js";

describe("系统主模型卡片 (PrimaryModelCard) UX 交互与深链闭环", () => {
  it("首屏静态渲染包含核心标题与连通测试入口", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        App,
        null,
        React.createElement(MemoryRouter, null, React.createElement(PrimaryModelCard)),
      ),
    );

    expect(html).toContain("系统总控主模型 (Primary Model)");
    expect(html).toContain("测试连通性");
    expect(html).toContain("切换主模型");
    expect(html).toContain("在即时通讯中测试");
  });

  it("源码实现包含即时通讯直达调用、模型详情原生复制与延迟徽标", () => {
    const src = readFileSync(
      new URL("../src/pages/settings/PrimaryModelCard.tsx", import.meta.url),
      "utf8",
    );

    expect(src).toContain("handleTestInIM");
    expect(src).toContain("/gateway?tab=im&prefill=");
    expect(src).toContain("MessageOutlined");
    expect(src).toContain("tooltips: [\"复制模型名称\", \"已复制\"]");
    expect(src).toContain("tooltips: [\"复制提供商\", \"已复制\"]");
    expect(src).toContain("tooltips: [\"复制服务端点\", \"已复制\"]");
    expect(src).toContain("⚡ {testResult.latencyMs}ms");
    expect(src).toContain("重新检测");
    expect(src).toContain("im-kbd-hint");
    expect(src).not.toContain("message=\"当前主模型运行于本地 Ollama 引擎\"");
  });
});
