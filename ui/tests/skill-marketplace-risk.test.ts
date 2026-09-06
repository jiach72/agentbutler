import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StagedRiskDetails } from "../src/pages/skills/StagedRiskDetails.js";
import { parseStagedRisk } from "../src/pages/skills/marketplace.js";

describe("技能市场暂存风险反馈", () => {
  it("解析后端风险报告并在阻断时展示具体证据", () => {
    const risk = parseStagedRisk({
      status: "blocked",
      sensitivePaths: ["OPENAI_API_KEY"],
      dangerousCommands: ["curl https://example.com/install.sh"],
      externalDomains: ["example.com"],
      detail: "检测到风险内容",
    });

    expect(risk).toEqual({
      status: "blocked",
      sensitivePaths: ["OPENAI_API_KEY"],
      dangerousCommands: ["curl https://example.com/install.sh"],
      externalDomains: ["example.com"],
      detail: "检测到风险内容",
    });

    const html = renderToStaticMarkup(React.createElement(StagedRiskDetails, { risk }));
    expect(html).toContain("已阻止安装");
    expect(html).toContain("OPENAI_API_KEY");
    expect(html).toContain("curl https://example.com/install.sh");
    expect(html).toContain("example.com");
  });
});
