/**
 * 即时通讯工作台（IM Workbench）类型定义与会话聚合模型。
 */
import type { MessageItemView } from "../helpers.js";

export type ConversationType = "direct" | "external";

export interface IMConversation {
  id: string; // direct:<sessionId> 或 channel:<channel>:<chatId>
  type: ConversationType;
  channel: string; // 'hermes' | 'weixin' | 'a2a' | 'api-server' 等
  title: string;
  chatId?: string;
  sessionId?: string;
  lastMessage?: {
    content: string;
    timestamp: string;
    sender: "ai" | "user";
    state?: string;
  };
  messageCount: number;
  errorCount: number; // 失败/死信数量
  isPinned?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IMChatMessage {
  id: string;
  conversationId: string;
  sender: "ai" | "user";
  content: string;
  timestamp: string;
  dateStr: string; // YYYY-MM-DD
  channel?: string;
  chatId?: string;
  sessionId?: string;
  // AI 出站状态 (Outbox)
  state?: string;
  lastError?: string | null;
  attemptCount?: number;
  rawOutbox?: MessageItemView;
  // 用户入站 Prompt 优化属性
  optimizedText?: string;
  mode?: "pass-through" | "quick" | "rule" | "llm";
  changes?: string[];
  transformTrace?: string[];
  // 本地直连专用标记
  isDirect?: boolean;
}

export interface InboundHistoryItem {
  inboundMessageId: string;
  inbound: {
    inboundMessageId: string;
    channel: string;
    chatId: string;
    content: string;
    receivedAt: string;
  };
  decision: {
    optimizedText: string;
    mode?: "pass-through" | "quick" | "rule" | "llm";
    changes?: string[];
    transformTrace?: string[];
  } | null;
  decidedAt: string | null;
}

export interface PromptEnhanceResult {
  original: string;
  enhanced: string;
  mode: "rule" | "llm";
  changes: string[];
}

/** 格式化本地日期 YYYY-MM-DD */
export function toLocalDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 格式化居中微信/IM 时间胶囊 */
export function formatIMTimeCapsule(timestampStr: string): string {
  const d = new Date(timestampStr);
  if (Number.isNaN(d.getTime())) return timestampStr;
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const yesterday = new Date(now.getTime() - 86_400_000);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();

  const timePart = d.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  if (isToday) return timePart;
  if (isYesterday) return `昨天 ${timePart}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${timePart}`;
}
