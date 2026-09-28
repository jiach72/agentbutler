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

  it("KnowledgePage 具备多场景提问模版、标签提取与收集箱快捷过滤芯片 (Commit 90)", () => {
    const src = readFileSync(new URL("../src/pages/knowledge/KnowledgePage.tsx", import.meta.url), "utf8");
    // 1. 预览抽屉多场景提问
    expect(src).toContain("💡 梳理核心要点与操作步骤（默认）");
    expect(src).toContain("📋 提取行动项与待办清单");
    expect(src).toContain("🛡️ 审查潜在风险与合规注意");
    expect(src).toContain("📝 总结为 200 字即时工作简报");
    // 2. 标签提取与联动过滤
    expect(src).toContain("previewDocTags");
    expect(src).toContain("handleFilterByTag");
    expect(src).toContain("文档标签：");
    // 3. 表格操作列直达提问
    expect(src).toContain("在即时通讯中提问此文档");
    // 4. 表格工具条快捷分类芯片
    expect(src).toContain("🔖 知识卡片");
    expect(src).toContain("📓 Obsidian");
    expect(src).toContain("💬 聊天归档");
    expect(src).toContain("⏳ 待切片");
    // 5. 问答出处（Citations）IM 追问
    expect(src).toContain("在即时通讯中就此出处追问细节");
  });

  it("Markdown 知识标签自动提取算法精准提取 #标签 并安全过滤标题", () => {
    const extractTags = (content: string) => {
      const matches = content.matchAll(/(?:^|\s)#([a-zA-Z0-9_\u4e00-\u9fa5]+)/g);
      const tags: string[] = [];
      for (const m of matches) {
        if (m[1]) tags.push(`#${m[1]}`);
      }
      return Array.from(new Set(tags));
    };

    const doc = "# 知识卡片-本地 RAG 部署要点\n- 会话：Hermes 专属管家\n#IM工作台 #知识沉淀 #向量模型_768\n\n正文描述...";
    const tags = extractTags(doc);
    expect(tags).toContain("#IM工作台");
    expect(tags).toContain("#知识沉淀");
    expect(tags).toContain("#向量模型_768");
    // 不应将 # 误判为标签
    expect(tags).not.toContain("#");
  });

  it("KnowledgePage 支持资料收集箱多选 (rowSelection)、批量删除与在即时通讯中综合提问 (Commit 93)", () => {
    const src = readFileSync(new URL("../src/pages/knowledge/KnowledgePage.tsx", import.meta.url), "utf8");
    expect(src).toContain("selectedDocIds");
    expect(src).toContain("handleBatchDelete");
    expect(src).toContain("handleBatchAskIM");
    expect(src).toContain("rowSelection=");
    expect(src).toContain("在即时通讯中综合提问");
    expect(src).toContain("批量删除");
    expect(src).toContain("取消选择");
  });

  it("KnowledgePage 支持表格操作列与预览抽屉一键复制知识库引用标签", () => {
    const src = readFileSync(new URL("../src/pages/knowledge/KnowledgePage.tsx", import.meta.url), "utf8");
    expect(src).toContain("复制知识库引用标签 ([参考本地知识库: 《...》])");
    expect(src).toContain("[参考本地知识库: 《");
    expect(src).toContain("已复制引用标签:");
    expect(src).toContain("复制引用标签");
  });

  it("KnowledgePage 问答出处（Citations）支持切片复制、原文预览与多场景快捷提问", () => {
    const src = readFileSync(new URL("../src/pages/knowledge/KnowledgePage.tsx", import.meta.url), "utf8");
    expect(src).toContain("🛡️ 潜在风险与合规？");
    expect(src).toContain("📝 200 字工作简报？");
    expect(src).toContain("一键复制出处切片内容");
    expect(src).toContain("在线预览该文档原文");
    expect(src).toContain("handleOpenPreview(matchedDoc)");
    expect(src).toContain("copiedSnippetIdx === i");
    expect(src).toContain("已复制问答全文 √");
    expect(src).toContain("即时通讯工作台");
    expect(src).toContain("navigate(\"/gateway?tab=im\")");
  });

  it("KnowledgePage 支持在线新建私有笔记与知识卡片并自动切片入库", () => {
    const src = readFileSync(new URL("../src/pages/knowledge/KnowledgePage.tsx", import.meta.url), "utf8");
    expect(src).toContain("新建私有笔记/卡片");
    expect(src).toContain("新建私有笔记与知识卡片");
    expect(src).toContain("createNoteModalOpen");
    expect(src).toContain("handleCreateNote");
    expect(src).toContain("保存并自动切片入库");
    expect(src).toContain("知识分类预设");
    expect(src).toContain("🔖 知识卡片");
    expect(src).toContain("📓 技术架构");
    expect(src).toContain("💡 灵感备忘");
    expect(src).toContain("📋 运维规程");
  });

  it("KnowledgePage 收集箱支持全分类标签筛选、快捷新建笔记按钮与弹窗结构化模板填入及快捷键 (Commit 119)", () => {
    const src = readFileSync(new URL("../src/pages/knowledge/KnowledgePage.tsx", import.meta.url), "utf8");
    // 快捷分类 CheckableTag 扩充断言
    expect(src).toContain("docFilter === \"技术架构\"");
    expect(src).toContain("docFilter === \"灵感备忘\"");
    expect(src).toContain("docFilter === \"运维规程\"");
    // 表格操作栏新建笔记按钮
    expect(src).toContain("新建笔记");
    // 新建笔记弹窗模板与快捷键断言
    expect(src).toContain("架构模版");
    expect(src).toContain("运维模版");
    expect(src).toContain("卡片模版");
    expect(src).toContain("Ctrl + Enter");
    expect(src).toContain("im-kbd-hint");
  });
});



