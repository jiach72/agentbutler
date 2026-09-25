/**
 * AI 与智能体全景技术百科（LearnPage）结构与渲染测试
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { App as AntApp } from "antd";
import { describe, expect, it } from "vitest";
import { LearnPage } from "../src/pages/learn/LearnPage.js";

function renderLearnPage(): string {
  return renderToStaticMarkup(
    <React.StrictMode>
      <MemoryRouter initialEntries={["/learn"]}>
        <AntApp>
          <LearnPage />
        </AntApp>
      </MemoryRouter>
    </React.StrictMode>
  );
}

describe("AI 与智能体全景技术百科（/learn）", () => {
  it("完整渲染六大知识核心板块", () => {
    const html = renderLearnPage();

    // 页面标题与主副标题
    expect(html).toContain("AI 与智能体全景技术百科");
    expect(html).toContain("日常使用 · 智能体通识");

    // 模块 1：演化脉络
    expect(html).toContain("技术代际跃迁：从传统软件到自主智能体");
    expect(html).toContain("第一代：传统软件系统");
    expect(html).toContain("第二代：大语言模型 (LLM)");
    expect(html).toContain("第三代：自主智能体 (Agent Butler)");

    // 模块 2：大模型底层原理
    expect(html).toContain("大语言模型 (LLM) 原理与运行参数解密");
    expect(html).toContain("Token 词元计量");
    expect(html).toContain("Context Window");
    expect(html).toContain("Temperature 采样温度");
    expect(html).toContain("Top-p 核采样");
    expect(html).toContain("Hallucination 幻觉");
    expect(html).toContain("RLHF / DPO 对齐");

    // 模块 3：Agent 架构与 ReAct
    expect(html).toContain("自主智能体 (Agent) 架构与 ReAct 思考循环");
    expect(html).toContain("1. 感知目标");
    expect(html).toContain("2. 拆解规划");
    expect(html).toContain("3. 工具调用");
    expect(html).toContain("4. 结果观察");
    expect(html).toContain("自主反思与修正闭环 (Feedback Loop)");
    expect(html).toContain("MCP 开放协议");

    // 模块 4：记忆体系与 RAG
    expect(html).toContain("三层记忆架构与检索增强生成 (RAG)");
    expect(html).toContain("1. 工作记忆 (Working)");
    expect(html).toContain("2. 情境记忆 (Episodic)");
    expect(html).toContain("3. 语义记忆 (Semantic)");

    // 模块 5：安全合规
    expect(html).toContain("安全合规防线：人机在环 (HITL) 与回环沙箱");
    expect(html).toContain("防线 1 · 行为指纹预检");
    expect(html).toContain("防线 2 · HITL 审批门禁");
    expect(html).toContain("防线 3 · 物理回环与熔断");

    // 模块 6：权威大词典
    expect(html).toContain("AI &amp; 智能体核心术语权威分类速查字典");
  });

  it("包含全面的专业术语词典条目", () => {
    const html = renderLearnPage();

    expect(html).toContain("AGI (通用人工智能)");
    expect(html).toContain("Transformer 架构");
    expect(html).toContain("自注意力机制");
    expect(html).toContain("Token (词元)");
    expect(html).toContain("ReAct 思考循环");
    expect(html).toContain("Tool Call (函数/工具调用)");
    expect(html).toContain("MCP 协议");
    expect(html).toContain("RAG (检索增强生成)");
    expect(html).toContain("Embedding (向量嵌入)");
    expect(html).toContain("Prompt 注入攻击");
    expect(html).toContain("HITL (人机在环 / 审批门禁)");
    expect(html).toContain("Loopback (本地回环网络)");
    expect(html).toContain("Kill Switch (紧急熔断)");
  });

  it("渲染顶部多维度分类导航 Tab 与全局搜索框", () => {
    const html = renderLearnPage();

    expect(html).toContain("全部通读");
    expect(html).toContain("AI 演进全景");
    expect(html).toContain("大模型底层原理");
    expect(html).toContain("Agent 架构与工具");
    expect(html).toContain("记忆与知识检索 RAG");
    expect(html).toContain("安全隔离与防线");
    expect(html).toContain("权威分类大词典");
    expect(html).toContain("全局搜索 AI 概念、术语与指标");
  });
});
