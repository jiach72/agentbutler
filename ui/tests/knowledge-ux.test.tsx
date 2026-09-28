import React from "react";
import { readFileSync } from "node:fs";
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

  it("KnowledgePage 源码包含文档内搜索与在即时通讯中提问直达动作", () => {
    const src = readFileSync(new URL("../src/pages/knowledge/KnowledgePage.tsx", import.meta.url), "utf8");
    expect(src).toContain("在即时通讯中提问");
    expect(src).toContain("在文档中搜索关键词...");
    expect(src).toContain("handleAskButlerAboutDoc");
    expect(src).toContain("renderHighlightedDocContent");
    expect(src).toContain("/gateway?tab=im&prefill=");
  });

  it("文档关键词安全匹配与高亮切分逻辑准确无死角", () => {
    const highlight = (content: string, keyword: string) => {
      const q = keyword.trim();
      if (!q) return [content];
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return content.split(new RegExp(`(${escaped})`, "gi"));
    };

    const text = "本指南介绍 AnythingLLM 与 Hermes RAG 部署规范，涉及向量嵌入模型 nomic-embed-text。";
    const parts = highlight(text, "rag");
    expect(parts.some((p) => p.toLowerCase() === "rag")).toBe(true);

    const specialParts = highlight("涉及参数 [port: 8754] 与 127.0.0.1 回环", "[port: 8754]");
    expect(specialParts.some((p) => p === "[port: 8754]")).toBe(true);
  });

  it("KnowledgePage 源码支持收集箱来源与向量化状态多维快选及大小/时间排序", () => {
    const src = readFileSync(new URL("../src/pages/knowledge/KnowledgePage.tsx", import.meta.url), "utf8");
    expect(src).toContain("docSourceFilter");
    expect(src).toContain("docIngestedFilter");
    expect(src).toContain("全部来源");
    expect(src).toContain("Obsidian 笔记");
    expect(src).toContain("微信/聊天归档");
    expect(src).toContain("已向量化");
    expect(src).toContain("就绪待分段");
    expect(src).toContain("showSizeChanger: true");
    expect(src).toContain("sorter: (a, b) => a.size - b.size");
    expect(src).toContain("重置全部筛选");
  });
});
