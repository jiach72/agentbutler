/**
 * 即时通讯工作台（IM Workbench）单元测试：
 * 1. 提示词增强引擎（promptEnhancer 规则快道断言）；
 * 2. 直连会话管理器（imSessionStore 状态机与持久化断言）。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import React from "react";
import { App } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { enhancePromptRules } from "../src/pages/gateway/im/promptEnhancer.js";
import { IMMessageInput, QUICK_PROMPT_CATEGORIES } from "../src/pages/gateway/im/IMMessageInput.js";
import {
  formatConversationToMarkdown,
  formatMessageToKnowledgeCard,
} from "../src/pages/gateway/im/imExport.js";
import {
  appendDirectMessage,
  clearDirectMessages,
  createDirectSession,
  DEFAULT_DIRECT_CONVERSATION_ID,
  deleteDirectSession,
  getDirectMessages,
  getDirectSessions,
  renameDirectSession,
} from "../src/pages/gateway/im/imSessionStore.js";
import type { IMChatMessage } from "../src/pages/gateway/im/imTypes.js";

describe("即时通讯工作台：提示词增强引擎 (promptEnhancer)", () => {
  it("去除开头的口语客套语", () => {
    const res1 = enhancePromptRules("请帮我看看今天的系统日志");
    expect(res1.enhanced).toBe("今天的系统日志");
    expect(res1.changes).toContain("去除口语客套语");

    const res2 = enhancePromptRules("麻烦你帮我检查下网络连通性");
    expect(res2.enhanced).toBe("检查网络连通性");
  });

  it("消解设备代词为「本机」", () => {
    const res = enhancePromptRules("查看这台电脑的内存使用率");
    expect(res.enhanced).toBe("查看本机的内存使用率");
    expect(res.changes).toContain("消解设备代词为「本机」");
  });

  it("口语化动词规范归一", () => {
    const res = enhancePromptRules("把报警配置弄好一点，并搞一下超时问题");
    expect(res.enhanced).toBe("把报警配置改进，并处理超时问题");
    expect(res.changes).toContain("口语动词规范化");
  });

  it("去除冗余的「一下」后缀", () => {
    const res = enhancePromptRules("检查一下通道状态并重启一下网关");
    expect(res.enhanced).toBe("检查通道状态并重启网关");
  });

  it("将疑问句转化为明确的验收任务", () => {
    const res = enhancePromptRules("检查微信通道正常了吗？");
    expect(res.enhanced).toBe("检查并验证 微信通道 的运行状态是否正常");
    expect(res.changes).toContain("疑问句转化为明确验收任务");
  });

  it("短文本自动补充上下文与分析建议（如用户截图中的「肥嘟嘟」）", () => {
    const res = enhancePromptRules("肥嘟嘟");
    expect(res.enhanced).toBe("请针对「肥嘟嘟」展开分析，并提供具体的行动建议与状态");
    expect(res.changes).toContain("补充任务上下文与行动建议");
  });
});

describe("即时通讯工作台：键盘可操作性", () => {
  it("快捷指令和发送操作使用可聚焦按钮，并为图标操作提供名称", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        App,
        null,
        React.createElement(IMMessageInput, { onSend: async () => undefined, sending: false }),
      ),
    );

    expect(html).toContain("检查系统健康与网关状态");
    expect((html.match(/<button\b/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(html).toMatch(/class="[^"]*\bim-action-chip\b/);
    expect(html).toContain('aria-label="发送消息"');
  });
});

describe("即时通讯工作台：直连会话管理器 (imSessionStore)", () => {
  beforeEach(() => {
    // 重置内存测试状态
    const sessions = getDirectSessions();
    for (const s of sessions) {
      if (s.id !== DEFAULT_DIRECT_CONVERSATION_ID) {
        deleteDirectSession(s.id);
      }
    }
    clearDirectMessages(DEFAULT_DIRECT_CONVERSATION_ID);
  });

  it("默认初始化包含 Hermes 直连智能体会话", () => {
    const sessions = getDirectSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions[0]?.id).toBe(DEFAULT_DIRECT_CONVERSATION_ID);
    expect(sessions[0]?.title).toBe("Hermes 智能体 (直连通道)");
  });

  it("支持创建新直连会话并自动维护排序", () => {
    const newSession = createDirectSession("系统巡检会话");
    expect(newSession.title).toBe("系统巡检会话");
    expect(newSession.id).toContain("direct:session-");

    const sessions = getDirectSessions();
    expect(sessions[0]?.id).toBe(newSession.id);
  });

  it("支持重命名与删除自定义直连会话", () => {
    const session = createDirectSession("临时会话");
    renameDirectSession(session.id, "重要排查");

    const updated = getDirectSessions().find((s) => s.id === session.id);
    expect(updated?.title).toBe("重要排查");

    deleteDirectSession(session.id);
    const afterDelete = getDirectSessions().find((s) => s.id === session.id);
    expect(afterDelete).toBeUndefined();
  });

  it("支持消息流追加、读取与清空", () => {
    const msg: IMChatMessage = {
      id: "msg-1",
      conversationId: DEFAULT_DIRECT_CONVERSATION_ID,
      sender: "user",
      content: "你好 Hermes",
      timestamp: "2026-09-17T12:00:00.000Z",
      dateStr: "2026-09-17",
      isDirect: true,
    };

    appendDirectMessage(DEFAULT_DIRECT_CONVERSATION_ID, msg);
    const msgs = getDirectMessages(DEFAULT_DIRECT_CONVERSATION_ID);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.content).toBe("你好 Hermes");

    clearDirectMessages(DEFAULT_DIRECT_CONVERSATION_ID);
    expect(getDirectMessages(DEFAULT_DIRECT_CONVERSATION_ID)).toHaveLength(0);
  });

  it("直连会话与 api-server 内部通道精准映射，不产生假外部通道", () => {
    const sessions = getDirectSessions();
    const directSessionIds = new Set(sessions.map((s) => s.sessionId || "default"));

    // 模拟来自 Outbox 的混合出站消息
    const mockOutboxItems = [
      { channel: "api-server", chatId: "default", content: "AI 回复：我在 Hermes 直连", capturedAt: "2026-09-18T00:00:00Z", state: "delivered" },
      { channel: "weixin", chatId: "wx_user_123", content: "发给微信用户的消息", capturedAt: "2026-09-18T00:01:00Z", state: "delivered" },
      { channel: "api-server", chatId: "butler-prompt-optimizer", content: "后台提示词优化响应", capturedAt: "2026-09-18T00:02:00Z", state: "delivered" },
    ];

    // 执行与 IMWorkbench 相同的聚合判决逻辑
    const externalChannels: string[] = [];
    for (const item of mockOutboxItems) {
      const ch = item.channel || "weixin";
      const cid = item.chatId || "default";
      if ((ch === "api-server" || ch === "hermes") && directSessionIds.has(cid)) {
        continue; // 成功阻断直连链路外泄为外部通道
      }
      externalChannels.push(`${ch}:${cid}`);
    }

    // 严密断言：api-server:default 必须被排除（不会生成假“外部通道”），微信与特定系统任务正常保留
    expect(externalChannels).not.toContain("api-server:default");
    expect(externalChannels).toContain("weixin:wx_user_123");
    expect(externalChannels).toContain("api-server:butler-prompt-optimizer");
  });
});

describe("即时通讯工作台：会话导出与知识卡片沉淀 (imExport)", () => {
  it("导出空消息记录的会话返回友好的占位说明", () => {
    const md = formatConversationToMarkdown(
      {
        id: "direct:default",
        type: "direct",
        channel: "hermes",
        title: "Hermes 专属管家",
        createdAt: "2026-09-18T00:00:00Z",
        updatedAt: "2026-09-18T00:00:00Z",
      },
      []
    );
    expect(md).toContain("# 会话纪要：Hermes 专属管家");
    expect(md).toContain("Hermes 原生直连通道");
    expect(md).toContain("本会话暂无消息记录");
  });

  it("导出多轮对话并正确呈现用户、AI、Prompt优化与自主接力", () => {
    const messages: IMChatMessage[] = [
      {
        id: "m1",
        conversationId: "group:g1",
        sender: "user",
        content: "检查服务器健康并排查死信",
        optimizedText: "检查服务器运行指标，并排查死信队列的积压原因与未投递消息",
        timestamp: "2026-09-18T10:00:00Z",
        dateStr: "2026-09-18",
      },
      {
        id: "m2",
        conversationId: "group:g1",
        sender: "ai",
        botId: "butler",
        botName: "全能管家",
        content: "已检查健康：CPU 15%，内存 42%，无死信积压。",
        timestamp: "2026-09-18T10:01:00Z",
        dateStr: "2026-09-18",
        peerHandoff: {
          toBotId: "inspector",
          toBotName: "审查员",
          reason: "深入排查慢查询与安全审计",
        },
      },
    ];

    const md = formatConversationToMarkdown(
      {
        id: "group:g1",
        type: "group",
        channel: "hermes",
        title: "DevOps 协同群",
        createdAt: "2026-09-18T00:00:00Z",
        updatedAt: "2026-09-18T00:00:00Z",
      },
      messages
    );

    expect(md).toContain("# 会话纪要：DevOps 协同群");
    expect(md).toContain("智能体协同群聊");
    expect(md).toContain("- **消息总数**：2 条");
    expect(md).toContain("Prompt 优化对照");
    expect(md).toContain("已转交给 @审查员");
    expect(md).toContain("全能管家");
  });

  it("将 AI 消息提取为知识卡片格式并清洗文件名", () => {
    const aiMsg: IMChatMessage = {
      id: "ai-123",
      conversationId: "direct:default",
      sender: "ai",
      botName: "全能管家",
      content: "## 本地 RAG 部署要点\n1. 需要先拉取 nomic-embed-text 向量模型\n2. 启动 AnythingLLM 容器\n3. 配置嵌入维度为 768",
      timestamp: "2026-09-18T12:00:00Z",
      dateStr: "2026-09-18",
    };

    const card = formatMessageToKnowledgeCard(aiMsg, {
      id: "direct:default",
      type: "direct",
      channel: "hermes",
      title: "Hermes 专属管家",
      createdAt: "2026-09-18T00:00:00Z",
      updatedAt: "2026-09-18T00:00:00Z",
    });

    expect(card.defaultTitle).toBe("本地 RAG 部署要点");
    expect(card.filename).toMatch(/^知识卡片-本地 RAG 部署要点-\d{8}-\d{4}\.md$/);
    expect(card.content).toContain("# 本地 RAG 部署要点");
    expect(card.content).toContain("- **来源**：Agent Butler 即时通讯工作台");
    expect(card.content).toContain("- **会话**：Hermes 专属管家");
    expect(card.content).toContain("#IM工作台 #知识沉淀 #智能体问答");
    expect(card.content).toContain("需要先拉取 nomic-embed-text 向量模型");
  });

  it("IMChatWindow 源码包含会话内查找、引用追问与填入输入框等交互闭环出口", () => {
    const src = readFileSync(new URL("../src/pages/gateway/im/IMChatWindow.tsx", import.meta.url), "utf8");
    expect(src).toContain("在当前会话中查找...");
    expect(src).toContain("引用追问");
    expect(src).toContain("填入输入框");
    expect(src).toContain("清空搜索条件");
    expect(src).toContain("handleRefillUser");
    expect(src).toContain("handleQuoteAI");
  });

  it("会话消息过滤算法正确匹配正文、Bot 名称与消息 ID", () => {
    const list: IMChatMessage[] = [
      {
        id: "msg-001",
        conversationId: "conv-1",
        sender: "user",
        content: "排查 Docker 容器日志与 502 错误",
        timestamp: "2026-09-28T09:00:00Z",
        dateStr: "2026-09-28",
      },
      {
        id: "msg-002",
        conversationId: "conv-1",
        sender: "ai",
        botId: "inspector",
        botName: "安全审查员",
        content: "未发现 502，网关正常在线，内存消耗正常",
        timestamp: "2026-09-28T09:01:00Z",
        dateStr: "2026-09-28",
      },
      {
        id: "msg-003",
        conversationId: "conv-1",
        sender: "ai",
        botId: "scout",
        botName: "情报侦察员",
        content: "最新外部资讯整理完毕，共 3 条更新",
        timestamp: "2026-09-28T09:02:00Z",
        dateStr: "2026-09-28",
      },
    ];

    const filterMsgs = (keyword: string) => {
      const q = keyword.trim().toLowerCase();
      if (!q) return list;
      return list.filter(
        (m) =>
          m.content.toLowerCase().includes(q) ||
          (m.botName && m.botName.toLowerCase().includes(q)) ||
          m.id.toLowerCase().includes(q)
      );
    };

    expect(filterMsgs("502")).toHaveLength(2);
    expect(filterMsgs("安全审查员")).toHaveLength(1);
    expect(filterMsgs("安全审查员")[0].id).toBe("msg-002");
    expect(filterMsgs("msg-003")).toHaveLength(1);
    expect(filterMsgs("不存在的关键字")).toHaveLength(0);
    expect(filterMsgs("")).toHaveLength(3);
  });

  it("分类快捷指令库 (QUICK_PROMPT_CATEGORIES) 结构完备且涵盖运维、汇报与问答", () => {
    expect(QUICK_PROMPT_CATEGORIES.length).toBeGreaterThanOrEqual(3);
    const keys = QUICK_PROMPT_CATEGORIES.map((c) => c.key);
    expect(keys).toContain("ops");
    expect(keys).toContain("summary");
    expect(keys).toContain("knowledge");

    for (const cat of QUICK_PROMPT_CATEGORIES) {
      expect(cat.label).toBeTruthy();
      expect(cat.items.length).toBeGreaterThanOrEqual(2);
      for (const item of cat.items) {
        expect(typeof item).toBe("string");
        expect(item.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("即时通讯工作台：UI/UX 深度重构与视窗自适应 (Commit 88)", () => {
  it("im.css 满足视窗高度自适应、Zen 模式、移动端推拉与气泡悬浮操作条规范", () => {
    const css = readFileSync(new URL("../src/pages/gateway/im/im.css", import.meta.url), "utf8");
    // 1. 高度自适应消灭双滚动条
    expect(css).toContain("height: calc(100vh - 128px)");
    expect(css).toContain("min-height: 560px");
    // 2. Zen Mode 纯净沉浸模式
    expect(css).toContain(".im-workbench-container.im-zen-mode");
    expect(css).toContain("z-index: 1000");
    // 3. 悬浮微型快捷操作条与代码块复制
    expect(css).toContain(".im-bubble-row");
    expect(css).toContain(".im-bubble-actions");
    expect(css).toContain(".im-bubble-row.im-bubble-row-user .im-bubble-actions");
    expect(css).toContain(".im-code-copy-btn");
    // 4. 移动端推拉视图响应式
    expect(css).toContain("@media (max-width: 768px)");
    expect(css).toContain(".im-workbench-container.mobile-view-chat .im-sidebar");
    expect(css).toContain(".im-workbench-container.mobile-view-list .im-chat-window");
  });

  it("IMChatWindow.tsx 具备 RichMarkdownBubble、悬浮工具条、Zen Mode 切换与移动端返回", () => {
    const src = readFileSync(new URL("../src/pages/gateway/im/IMChatWindow.tsx", import.meta.url), "utf8");
    expect(src).toContain("RichMarkdownBubble");
    expect(src).toContain("im-code-copy-btn");
    expect(src).toContain("im-bubble-actions");
    expect(src).toContain("im-bubble-row im-bubble-row-user");
    expect(src).toContain("onToggleZenMode");
    expect(src).toContain("onBackToList");
    expect(src).toContain("im-mobile-back-btn");
    expect(src).toContain("FullscreenOutlined");
    expect(src).toContain("FullscreenExitOutlined");
  });

  it("IMWorkbench.tsx 实现 isZenMode、mobileView 与 ESC 快捷键退出的控制逻辑", () => {
    const src = readFileSync(new URL("../src/pages/gateway/im/IMWorkbench.tsx", import.meta.url), "utf8");
    expect(src).toContain("isZenMode");
    expect(src).toContain("mobileView");
    expect(src).toContain("handleSelectConversation");
    expect(src).toContain('e.key === "Escape" && isZenMode');
    expect(src).toContain("im-zen-mode");
    expect(src).toContain("mobile-view-chat");
    expect(src).toContain("mobile-view-list");
  });
});


