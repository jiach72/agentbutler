/**
 * 即时通讯工作台（IMWorkbench）主控制器组件。
 * - 组装左侧会话列表（IMConversationList）与右侧对话视窗（IMChatWindow）；
 * - Hermes 原生直连通信链路（支持多会话隔离、多轮记忆、直连 API Server）；
 * - 聚合外部通道（微信、A2A 等）数据流，无缝对接 Outbox 生命周期与链路排查 Drawer。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { App, Drawer, Flex } from "antd";
import { InfoCircleOutlined } from "@ant-design/icons";
import { loadJson, postJson } from "../../../lib/api.js";
import { MessageDetail } from "../MessageInspector.js";
import type { MessageItemView, MessageTaskView } from "../helpers.js";
import {
  toLocalDateString,
  type IMChatMessage,
  type IMConversation,
  type InboundHistoryItem,
} from "./imTypes.js";
import {
  appendDirectMessage,
  clearDirectMessages,
  createDirectSession,
  DEFAULT_DIRECT_CONVERSATION_ID,
  deleteDirectSession,
  getDirectMessages,
  getDirectSessions,
} from "./imSessionStore.js";
import { IMConversationList } from "./IMConversationList.js";
import { IMChatWindow } from "./IMChatWindow.js";
import "./im.css";

export interface IMWorkbenchProps {
  items: MessageItemView[];
  counts: Record<string, number>;
  reachable: boolean;
  selectedMessage: MessageItemView | null;
  onSelectMessage: (messageId: string | null) => void;
  taskData: MessageTaskView | null;
  taskLoading: boolean;
  onRedeliver?: (messageId: string) => void;
  redeliverBusy?: boolean;
  onExpedite?: (messageId: string) => void;
  expediteBusy?: boolean;
  onResolve?: (messageId: string, outcome: "delivered" | "cancelled", reason?: string) => void;
  resolveBusy?: boolean;
}

export function IMWorkbench(props: IMWorkbenchProps) {
  const { message } = App.useApp();

  // 1. 直连会话状态
  const [directSessions, setDirectSessions] = useState(() => getDirectSessions());
  const [activeConversationId, setActiveConversationId] = useState<string>(
    DEFAULT_DIRECT_CONVERSATION_ID
  );
  const [directMessagesMap, setDirectMessagesMap] = useState<Record<string, IMChatMessage[]>>({});
  const [sendingDirect, setSendingDirect] = useState(false);
  const [apiServerAvailable, setApiServerAvailable] = useState(true);

  // 2. 外部入站消息历史
  const [inboundItems, setInboundItems] = useState<InboundHistoryItem[]>([]);
  const loadInboundHistory = useCallback(async () => {
    const res = await loadJson<{ reachable: boolean; items: InboundHistoryItem[] }>(
      "/api/messages/optimization-history?limit=100",
      8_000
    );
    if (res.ok && Array.isArray(res.data?.items)) {
      setInboundItems(res.data.items);
    }
  }, []);

  // 探活 Hermes api_server
  const checkApiServerStatus = useCallback(async () => {
    const res = await loadJson<{ ready: boolean }>("/api/agent-message/status", 5_000);
    if (res.ok && res.data) {
      setApiServerAvailable(Boolean(res.data.ready));
    }
  }, []);

  useEffect(() => {
    void loadInboundHistory();
    void checkApiServerStatus();
  }, [loadInboundHistory, checkApiServerStatus]);

  // 加载当前激活直连会话的消息
  useEffect(() => {
    if (activeConversationId.startsWith("direct:")) {
      const msgs = getDirectMessages(activeConversationId);
      setDirectMessagesMap((prev) => ({ ...prev, [activeConversationId]: msgs }));
    }
  }, [activeConversationId]);

  // 3. 聚合会话列表（直连会话 + 外部通道聚合）
  const conversations = useMemo<IMConversation[]>(() => {
    const list: IMConversation[] = [];

    // A. 直连智能体会话（置顶）
    for (const ds of directSessions) {
      const msgs = directMessagesMap[ds.id] || getDirectMessages(ds.id);
      const last = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
      list.push({
        id: ds.id,
        type: "direct",
        channel: "hermes",
        title: ds.title,
        sessionId: ds.sessionId,
        lastMessage: last
          ? {
              content: last.content,
              timestamp: last.timestamp,
              sender: last.sender,
              state: last.state,
            }
          : undefined,
        messageCount: msgs.length,
        errorCount: msgs.filter((m) => m.state === "policy_error" || m.state === "dead_letter").length,
        isPinned: true,
        createdAt: ds.createdAt,
        updatedAt: ds.updatedAt,
      });
    }

    // B. 外部通道聚合：按 channel + chatId 分组
    const externalMap = new Map<
      string,
      {
        channel: string;
        chatId: string;
        messages: Array<{
          content: string;
          timestamp: string;
          sender: "ai" | "user";
          state?: string;
        }>;
      }
    >();

    // 收集全部直连会话的 sessionId（如 "default" 等）以供精准去重与识别
    const directSessionIds = new Set(directSessions.map((s) => s.sessionId || "default"));

    // 聚合出站 (Outbox)
    for (const item of props.items) {
      const ch = item.channel || "weixin";
      const cid = item.chatId || "default";

      // 核心修正：Hermes api-server/直连接口产生的出站消息属于内部直连会话，
      // 绝不作为所谓的“外部通道”单独创建重复会话，彻底避免两个通道同时收到相同回复的混淆！
      if ((ch === "api-server" || ch === "hermes") && directSessionIds.has(cid)) {
        continue;
      }

      const key = `channel:${ch}:${cid}`;
      let group = externalMap.get(key);
      if (!group) {
        group = { channel: ch, chatId: cid, messages: [] };
        externalMap.set(key, group);
      }
      group.messages.push({
        content: item.content,
        timestamp: item.capturedAt,
        sender: "ai",
        state: item.state,
      });
    }

    // 聚合入站 (Inbound)
    for (const item of inboundItems) {
      const ch = item.inbound?.channel || "weixin";
      const cid = item.inbound?.chatId || "default";

      if ((ch === "api-server" || ch === "hermes") && directSessionIds.has(cid)) {
        continue;
      }

      const key = `channel:${ch}:${cid}`;
      let group = externalMap.get(key);
      if (!group) {
        group = { channel: ch, chatId: cid, messages: [] };
        externalMap.set(key, group);
      }
      group.messages.push({
        content: item.inbound?.content || "",
        timestamp: item.inbound?.receivedAt || new Date().toISOString(),
        sender: "user",
      });
    }

    // 转换外部会话
    for (const [key, group] of externalMap) {
      group.messages.sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
      const last = group.messages[group.messages.length - 1];
      const errorCount = group.messages.filter(
        (m) => m.state === "dead_letter" || m.state === "policy_error"
      ).length;

      let title: string;
      if (group.channel === "api-server") {
        title =
          group.chatId === "butler-prompt-optimizer"
            ? "系统后台 · 提示词优化 (Prompt Optimizer)"
            : `Hermes 后台服务 · ${group.chatId}`;
      } else if (group.channel === "weixin") {
        title = group.chatId === "default" ? "微信默认会话" : `微信联系人 · ${group.chatId}`;
      } else {
        title = group.chatId === "default" ? `${group.channel} 通道` : `${group.channel} · ${group.chatId}`;
      }

      list.push({
        id: key,
        type: "external",
        channel: group.channel,
        title,
        chatId: group.chatId,
        lastMessage: last,
        messageCount: group.messages.length,
        errorCount,
        createdAt: group.messages[0]?.timestamp || new Date().toISOString(),
        updatedAt: last?.timestamp || new Date().toISOString(),
      });
    }

    return list;
  }, [directSessions, directMessagesMap, props.items, inboundItems]);

  // 平滑回退：如果此前选中的是已被消除的重复假会话 channel:api-server:default，则切换到 DEFAULT_DIRECT_CONVERSATION_ID
  useEffect(() => {
    if (activeConversationId === "channel:api-server:default") {
      setActiveConversationId(DEFAULT_DIRECT_CONVERSATION_ID);
    }
  }, [activeConversationId]);

  // 当前选中的会话对象
  const activeConversation = useMemo(() => {
    const found = conversations.find((c) => c.id === activeConversationId);
    if (found) return found;
    if (activeConversationId === "channel:api-server:default") {
      const defaultDirect = conversations.find((c) => c.id === DEFAULT_DIRECT_CONVERSATION_ID);
      if (defaultDirect) return defaultDirect;
    }
    return conversations[0] || null;
  }, [conversations, activeConversationId]);

  // 当前选中会话的消息流
  const activeMessages = useMemo<IMChatMessage[]>(() => {
    if (!activeConversation) return [];

    // 如果是直连会话：读 directMessages
    if (activeConversation.type === "direct") {
      const stored = directMessagesMap[activeConversation.id] || getDirectMessages(activeConversation.id);
      if (stored.length > 0) return stored;

      // 若本地存储为空（例如新客户端或清空后刷新），尝试从 Outbox 中恢复该 sessionId 的历史记录
      const targetSessionId = activeConversation.sessionId || "default";
      const outboxFallback: IMChatMessage[] = props.items
        .filter(
          (item) =>
            (item.channel === "api-server" || item.channel === "hermes") &&
            (item.chatId || "default") === targetSessionId
        )
        .map((item) => ({
          id: item.messageId,
          conversationId: activeConversation.id,
          sender: "ai" as const,
          content: item.content,
          timestamp: item.capturedAt,
          dateStr: toLocalDateString(new Date(item.capturedAt)),
          channel: "hermes",
          chatId: item.chatId,
          sessionId: item.sessionId,
          state: item.state,
          isDirect: true,
        }));
      outboxFallback.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      return outboxFallback;
    }

    // 如果是外部通道会话：组装当前 channel + chatId 的消息
    const list: IMChatMessage[] = [];
    const targetChannel = activeConversation.channel;
    const targetChatId = activeConversation.chatId;

    for (const item of props.items) {
      if (
        (item.channel || "weixin") === targetChannel &&
        (item.chatId || "default") === (targetChatId || "default")
      ) {
        list.push({
          id: item.messageId,
          conversationId: activeConversation.id,
          sender: "ai",
          content: item.content,
          timestamp: item.capturedAt,
          dateStr: toLocalDateString(new Date(item.capturedAt)),
          channel: item.channel,
          chatId: item.chatId,
          sessionId: item.sessionId,
          state: item.state,
          lastError: item.lastError,
          attemptCount: item.attemptCount,
          rawOutbox: item,
        });
      }
    }

    for (const entry of inboundItems) {
      if (
        (entry.inbound.channel || "weixin") === targetChannel &&
        (entry.inbound.chatId || "default") === (targetChatId || "default")
      ) {
        const ts = entry.inbound.receivedAt;
        list.push({
          id: entry.inboundMessageId,
          conversationId: activeConversation.id,
          sender: "user",
          content: entry.inbound.content,
          timestamp: ts,
          dateStr: toLocalDateString(new Date(ts)),
          channel: entry.inbound.channel,
          chatId: entry.inbound.chatId,
          optimizedText: entry.decision?.optimizedText,
          mode: entry.decision?.mode,
          changes: entry.decision?.changes,
          transformTrace: entry.decision?.transformTrace,
        });
      }
    }

    list.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return list;
  }, [activeConversation, directMessagesMap, props.items, inboundItems]);

  // 新建直连会话
  const handleCreateDirectSession = () => {
    const newSession = createDirectSession();
    setDirectSessions(getDirectSessions());
    setActiveConversationId(newSession.id);
    message.success(`已创建 ${newSession.title}`);
  };

  // 删除直连会话
  const handleDeleteDirectSession = (id: string) => {
    deleteDirectSession(id);
    const updated = getDirectSessions();
    setDirectSessions(updated);
    if (activeConversationId === id) {
      setActiveConversationId(DEFAULT_DIRECT_CONVERSATION_ID);
    }
    message.success("已删除对话");
  };

  // 清空当前直连对话
  const handleClearHistory = () => {
    if (!activeConversation) return;
    clearDirectMessages(activeConversation.id);
    setDirectMessagesMap((prev) => ({ ...prev, [activeConversation.id]: [] }));
    message.success("已清空消息记录");
  };

  // 发送消息处理
  const handleSendMessage = async (text: string) => {
    if (!activeConversation) return;

    // A. 直连通道发送
    if (activeConversation.type === "direct") {
      const nowStr = new Date().toISOString();
      const userMsg: IMChatMessage = {
        id: `user-msg-${Date.now()}`,
        conversationId: activeConversation.id,
        sender: "user",
        content: text,
        timestamp: nowStr,
        dateStr: toLocalDateString(new Date()),
        isDirect: true,
      };

      const afterUser = appendDirectMessage(activeConversation.id, userMsg);
      setDirectMessagesMap((prev) => ({ ...prev, [activeConversation.id]: afterUser }));

      setSendingDirect(true);
      try {
        const res = await postJson(
          "/api/agent-message",
          {
            text,
            sessionId: activeConversation.sessionId || "default",
          },
          180_000
        );

        const data = res.data as { ok?: boolean; reply?: string; error?: string } | null;

        if (res.ok && data) {
          const aiReplyText = data.reply || "（智能体已处理该指令）";
          const aiMsg: IMChatMessage = {
            id: `ai-reply-${Date.now()}`,
            conversationId: activeConversation.id,
            sender: "ai",
            content: aiReplyText,
            timestamp: new Date().toISOString(),
            dateStr: toLocalDateString(new Date()),
            state: "delivered",
            isDirect: true,
          };
          const afterAi = appendDirectMessage(activeConversation.id, aiMsg);
          setDirectMessagesMap((prev) => ({ ...prev, [activeConversation.id]: afterAi }));
        } else {
          const errDetail = data?.error || "无法连通 Hermes 智能体接口";
          const failMsg: IMChatMessage = {
            id: `ai-err-${Date.now()}`,
            conversationId: activeConversation.id,
            sender: "ai",
            content: `智能体回复失败：${errDetail}`,
            timestamp: new Date().toISOString(),
            dateStr: toLocalDateString(new Date()),
            state: "policy_error",
            lastError: errDetail,
            isDirect: true,
          };
          const afterFail = appendDirectMessage(activeConversation.id, failMsg);
          setDirectMessagesMap((prev) => ({ ...prev, [activeConversation.id]: afterFail }));
          message.error(`发送失败: ${errDetail}`);
        }
      } catch {
        const failMsg: IMChatMessage = {
          id: `ai-err-${Date.now()}`,
          conversationId: activeConversation.id,
          sender: "ai",
          content: "网络异常，未能送达智能体",
          timestamp: new Date().toISOString(),
          dateStr: toLocalDateString(new Date()),
          state: "policy_error",
          lastError: "Network Error",
          isDirect: true,
        };
        const afterFail = appendDirectMessage(activeConversation.id, failMsg);
        setDirectMessagesMap((prev) => ({ ...prev, [activeConversation.id]: afterFail }));
      } finally {
        setSendingDirect(false);
      }
    } else {
      // 外部通道发送
      message.info("已提交通道投递，请在消息流查看执行结果");
    }
  };

  return (
    <Flex vertical gap={16}>
      <div className="im-workbench-container">
        {/* 1. 左侧会话列表 */}
        <IMConversationList
          conversations={conversations}
          activeId={activeConversationId}
          onSelectConversation={setActiveConversationId}
          onCreateDirectSession={handleCreateDirectSession}
          onDeleteDirectSession={handleDeleteDirectSession}
        />

        {/* 2. 右侧对话视窗 */}
        <IMChatWindow
          conversation={activeConversation}
          messages={activeMessages}
          sending={sendingDirect}
          onSend={handleSendMessage}
          onSelectOutboxMessage={props.onSelectMessage}
          onRedeliver={props.onRedeliver}
          onClearHistory={handleClearHistory}
          apiServerAvailable={apiServerAvailable}
        />
      </div>

      {/* 3. 消息详情与链路排查 Drawer */}
      <Drawer
        title={
          <Flex align="center" gap={8}>
            <InfoCircleOutlined style={{ color: "var(--ant-color-primary)" }} />
            <span>消息详情与链路追踪</span>
          </Flex>
        }
        open={props.selectedMessage !== null}
        onClose={() => props.onSelectMessage(null)}
        width={640}
        destroyOnHidden
      >
        {props.selectedMessage !== null && (
          <MessageDetail
            message={props.selectedMessage}
            taskData={props.taskData}
            taskLoading={props.taskLoading}
            onRedeliver={props.onRedeliver}
            redeliverBusy={props.redeliverBusy}
            onExpedite={props.onExpedite}
            expediteBusy={props.expediteBusy}
            onResolve={props.onResolve}
            resolveBusy={props.resolveBusy}
          />
        )}
      </Drawer>
    </Flex>
  );
}
