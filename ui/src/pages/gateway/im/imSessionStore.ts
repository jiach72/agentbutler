/**
 * 本地直连会话存储与多轮状态管理器（IM Session Store）。
 * 持久化于 localStorage（带 Node / 测试环境内存降级），支持多会话隔离、新建、重命名、消息流追加与一键清空。
 */
import type { IMChatMessage } from "./imTypes.js";

const DIRECT_SESSIONS_STORAGE_KEY = "butler_im_direct_sessions_v1";
const DIRECT_MESSAGES_STORAGE_PREFIX = "butler_im_messages_";

export const DEFAULT_DIRECT_CONVERSATION_ID = "direct:default";
export const DEFAULT_GROUP_CONVERSATION_ID = "group:pantheon-core";

export interface DirectSessionMeta {
  id: string;
  sessionId: string;
  title: string;
  type?: "direct" | "group";
  botId?: string;
  memberBotIds?: string[];
  createdAt: string;
  updatedAt: string;
}

const memoryStore = new Map<string, string>();

function getStorage(): {
  getItem: (key: string) => string | null;
  setItem: (key: string, val: string) => void;
  removeItem: (key: string) => void;
} {
  try {
    if (typeof globalThis !== "undefined" && "localStorage" in globalThis && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch {
    // 降级使用内存存储
  }
  return {
    getItem: (k: string) => memoryStore.get(k) ?? null,
    setItem: (k: string, v: string) => {
      memoryStore.set(k, v);
    },
    removeItem: (k: string) => {
      memoryStore.delete(k);
    },
  };
}

function safeParseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 预设初始会话（包含 Hermes 直连会话、万神殿协同中心群聊与专职 Bot） */
function buildDefaultSessions(): DirectSessionMeta[] {
  const now = new Date().toISOString();
  return [
    {
      id: DEFAULT_DIRECT_CONVERSATION_ID,
      sessionId: "default",
      title: "Hermes 智能体 (直连通道)",
      type: "direct",
      botId: "butler",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: DEFAULT_GROUP_CONVERSATION_ID,
      sessionId: "pantheon-core",
      title: "万神殿协同中心 (多 Bot 群聊)",
      type: "group",
      memberBotIds: ["butler", "inspector", "scout"],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "direct:inspector:default",
      sessionId: "inspector-default",
      title: "审查员",
      type: "direct",
      botId: "inspector",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "direct:scout:default",
      sessionId: "scout-default",
      title: "侦察员",
      type: "direct",
      botId: "scout",
      createdAt: now,
      updatedAt: now,
    },
  ];
}

/** 获取全部直连与群聊会话列表 */
export function getDirectSessions(): DirectSessionMeta[] {
  const storage = getStorage();
  const list = safeParseJson<DirectSessionMeta[]>(
    storage.getItem(DIRECT_SESSIONS_STORAGE_KEY),
    []
  );
  if (list.length === 0 || !list.some((s) => s.id === DEFAULT_GROUP_CONVERSATION_ID)) {
    const defaultSessions = buildDefaultSessions();
    // 合并已有会话，避免丢失用户历史
    const merged = [...defaultSessions, ...list.filter((s) => !defaultSessions.some((d) => d.id === s.id))];
    saveDirectSessions(merged);
    return merged;
  }
  return list;
}

/** 持久化直连会话元数据列表 */
export function saveDirectSessions(sessions: DirectSessionMeta[]): void {
  try {
    getStorage().setItem(DIRECT_SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    // 忽略存储超限异常
  }
}

/** 创建新的群聊会话 */
export function createGroupSession(title?: string, memberBotIds: string[] = ["butler", "inspector", "scout"]): DirectSessionMeta {
  const sessions = getDirectSessions();
  const nowStr = new Date().toISOString();
  const index = sessions.filter((s) => s.type === "group").length + 1;
  const uniqueKey = `group-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const newSession: DirectSessionMeta = {
    id: `group:${uniqueKey}`,
    sessionId: uniqueKey,
    title: title?.trim() || `智能体协同群 #${index}`,
    type: "group",
    memberBotIds,
    createdAt: nowStr,
    updatedAt: nowStr,
  };
  const updated = [newSession, ...sessions];
  saveDirectSessions(updated);
  return newSession;
}

/** 创建新的直连 Bot 会话 */
export function createDirectSession(title?: string, botId?: string): DirectSessionMeta {
  const sessions = getDirectSessions();
  const nowStr = new Date().toISOString();
  const index = sessions.length + 1;
  const uniqueKey = `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const targetBotId = botId || "butler";
  const newSession: DirectSessionMeta = {
    id: botId ? `direct:${botId}:${uniqueKey}` : `direct:${uniqueKey}`,
    sessionId: uniqueKey,
    title: title?.trim() || `新对话 #${index}`,
    type: "direct",
    botId: targetBotId,
    createdAt: nowStr,
    updatedAt: nowStr,
  };
  const updated = [newSession, ...sessions];
  saveDirectSessions(updated);
  return newSession;
}

/** 重命名直连会话 */
export function renameDirectSession(id: string, newTitle: string): void {
  const sessions = getDirectSessions();
  const target = sessions.find((s) => s.id === id);
  if (target) {
    target.title = newTitle.trim() || target.title;
    target.updatedAt = new Date().toISOString();
    saveDirectSessions(sessions);
  }
}

/** 更新群聊成员 Bot ID 名册 */
export function updateGroupMembers(groupId: string, memberBotIds: string[]): void {
  const sessions = getDirectSessions();
  const target = sessions.find((s) => s.id === groupId);
  if (target) {
    target.memberBotIds = memberBotIds;
    target.updatedAt = new Date().toISOString();
    saveDirectSessions(sessions);
  }
}

/** 删除直连会话（保留默认会话） */
export function deleteDirectSession(id: string): void {
  if (id === DEFAULT_DIRECT_CONVERSATION_ID) {
    clearDirectMessages(id);
    return;
  }
  const sessions = getDirectSessions().filter((s) => s.id !== id);
  saveDirectSessions(sessions);
  try {
    getStorage().removeItem(`${DIRECT_MESSAGES_STORAGE_PREFIX}${id}`);
  } catch {
    // 忽略
  }
}

/** 读取指定直连会话的消息列表 */
export function getDirectMessages(conversationId: string): IMChatMessage[] {
  return safeParseJson<IMChatMessage[]>(
    getStorage().getItem(`${DIRECT_MESSAGES_STORAGE_PREFIX}${conversationId}`),
    []
  );
}

/** 保存/追加消息到指定会话 */
export function appendDirectMessage(
  conversationId: string,
  message: IMChatMessage
): IMChatMessage[] {
  const current = getDirectMessages(conversationId);
  const updated = [...current, message];
  try {
    getStorage().setItem(
      `${DIRECT_MESSAGES_STORAGE_PREFIX}${conversationId}`,
      JSON.stringify(updated.slice(-200)) // 保留最近 200 条消息
    );
  } catch {
    // 忽略
  }

  // 更新会话的 updatedAt
  const sessions = getDirectSessions();
  const sess = sessions.find((s) => s.id === conversationId);
  if (sess) {
    sess.updatedAt = message.timestamp;
    saveDirectSessions(sessions);
  }

  return updated;
}

/** 清空指定会话的消息历史 */
export function clearDirectMessages(conversationId: string): void {
  try {
    getStorage().removeItem(`${DIRECT_MESSAGES_STORAGE_PREFIX}${conversationId}`);
  } catch {
    // 忽略
  }
}
