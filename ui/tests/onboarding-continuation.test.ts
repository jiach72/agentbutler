import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OnboardingContinuation } from "../src/pages/dashboard/OnboardingContinuation.js";
import { getScenarioTemplate } from "../src/pages/setup/templates.js";

describe("首次场景的持续入口", () => {
  it("完成首次设置后不再在首页重复显示持续入口", () => {
    const html = renderToStaticMarkup(
      React.createElement(OnboardingContinuation, {
        preferences: { instanceId: "hermes-main", templateId: "notify", completedAt: "2026-08-30T00:00:00.000Z" },
      }),
    );

    expect(html).toBe("");
  });

  it("未选择场景时引导完成设置，而不是显示空白区域", () => {
    const html = renderToStaticMarkup(
      React.createElement(OnboardingContinuation, { preferences: null }),
    );

    expect(html).toContain("选择一个常用用途");
    expect(html).toContain("开始设置");
  });

  it("只接受已定义的场景标识", () => {
    expect(getScenarioTemplate("coding")?.destination).toBe("/skills");
    expect(getScenarioTemplate("unknown")).toBeNull();
  });
});
