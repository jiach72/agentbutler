import React from "react";
import { App } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KnowledgeStarChart, type GraphData } from "../src/pages/knowledge/KnowledgeStarChart.js";

const mockGraphData: GraphData = {
  nodes: [
    {
      id: "doc-1",
      name: "Agent 架构设计.md",
      type: "obsidian",
      val: 18,
      connections: 12,
    },
    {
      id: "doc-2",
      name: "本地知识库检索.md",
      type: "obsidian",
      val: 14,
      connections: 8,
    },
    {
      id: "doc-3",
      name: "微信传输文档.pdf",
      type: "inbox",
      val: 20,
      connections: 2,
    },
    {
      id: "tag:rag",
      name: "#RAG",
      type: "tag",
      val: 10,
      connections: 5,
    },
    {
      id: "concept:core",
      name: "核心枢纽",
      type: "concept",
      val: 22,
      connections: 15,
    },
  ],
  links: [
    { source: "doc-1", target: "doc-2", type: "wikilink", strength: 1.0 },
    { source: "doc-1", target: "tag:rag", type: "tag", strength: 0.8 },
    { source: "doc-2", target: "concept:core", type: "wikilink", strength: 0.9 },
  ],
  stats: {
    totalNodes: 5,
    totalLinks: 3,
    docCount: 3,
    tagCount: 1,
  },
};

describe("知识星图组件 (KnowledgeStarChart)", () => {
  it("静态渲染正常加载顶部过滤器与自适应全览操作", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        App,
        null,
        React.createElement(KnowledgeStarChart, {
          data: mockGraphData,
          loading: false,
        }),
      ),
    );

    // 验证标题与统计标签
    expect(html).toContain("知识星图 (Galaxy Graph)");
    expect(html).toContain("5 星体");
    expect(html).toContain("3 连线");

    // 验证分类按钮与计数
    expect(html).toContain("全景星图 (5)");
    expect(html).toContain("Obsidian (2)");
    expect(html).toContain("聊天归档 (1)");
    expect(html).toContain("标签 (1)");

    // 验证视焦模式切换
    expect(html).toContain("智能聚焦");
    expect(html).toContain("全显星名");
    expect(html).toContain("纯净星空");

    // 验证自适应全览操作
    expect(html).toContain("自适应全览");

    // 验证 canvas 存在
    expect(html).toContain("<canvas");
  });

  it("当无数据时渲染友好空状态引导", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        App,
        null,
        React.createElement(KnowledgeStarChart, {
          data: null,
          loading: false,
        }),
      ),
    );

    expect(html).toContain("知识库暂无文档或笔记");
  });
});
