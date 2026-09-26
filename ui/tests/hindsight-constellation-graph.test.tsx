import React from "react";
import { App } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  HindsightConstellationGraph,
  HINDSIGHT_PALETTE,
  type ConstellationData,
} from "../src/components/HindsightConstellationGraph.js";

const mockConstellationData: ConstellationData = {
  nodes: [
    { id: "node-1", label: "核心规则", group: "world" },
    { id: "node-2", label: "代码演化历程", group: "experience" },
    { id: "node-3", label: "系统监控观察", group: "observation" },
    { id: "node-4", label: "Agent Butler", group: "entity" },
  ],
  links: [
    { source: "node-1", target: "node-2", type: "semantic" },
    { source: "node-2", target: "node-3", type: "temporal" },
    { source: "node-3", target: "node-4", type: "causal" },
  ],
};

describe("HindsightConstellationGraph", () => {
  it("静态渲染正常输出 canvas 与 Hindsight 原生 HUD/图例", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        App,
        null,
        React.createElement(HindsightConstellationGraph, {
          data: mockConstellationData,
          clusterKeyFn: (n) => n.group || null,
        }),
      ),
    );

    expect(html).toContain("<canvas");
    expect(html).toContain("节点: 4");
    expect(html).toContain("连线: 3");
    expect(html).toContain("World");
    expect(html).toContain("Experience");
    expect(html).toContain("Observation");
    expect(html).toContain("Entity");
  });

  it("当无数据时渲染友好空状态引导", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        App,
        null,
        React.createElement(HindsightConstellationGraph, {
          data: null,
          emptyMessage: "未探测到记忆数据",
        }),
      ),
    );

    expect(html).toContain("未探测到记忆数据");
  });

  it("Hindsight 配色表包含官方四色", () => {
    expect(HINDSIGHT_PALETTE.world).toBe("#8b5cf6");
    expect(HINDSIGHT_PALETTE.experience).toBe("#ec4899");
    expect(HINDSIGHT_PALETTE.observation).toBe("#6366f1");
    expect(HINDSIGHT_PALETTE.entity).toBe("#0ea5e9");
  });
});
