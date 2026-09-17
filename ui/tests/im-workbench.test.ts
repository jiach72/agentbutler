/**
 * 即时通讯工作台（IM Workbench）单元测试：
 * 1. 提示词增强引擎（promptEnhancer 规则快道断言）；
 * 2. 直连会话管理器（imSessionStore 状态机与持久化断言）。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { enhancePromptRules } from "../src/pages/gateway/im/promptEnhancer.js";
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
});
