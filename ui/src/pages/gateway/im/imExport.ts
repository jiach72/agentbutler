/**
 * 即时通讯工作台：会话导出与知识卡片沉淀工具函数（imExport）。
 * 提供结构化 Markdown 转换、卡片元数据格式化与文件下载封装。
 */
import type { IMChatMessage, IMConversation } from "./imTypes.js";

/**
 * 将即时通讯会话完整导出为结构化 Markdown 纪要文档。
 */
export function formatConversationToMarkdown(
  conversation: IMConversation | null,
  messages: IMChatMessage[]
): string {
  const title = conversation?.title?.trim() || "未命名会话";
  const now = new Date();
  const exportTime = now.toLocaleString("zh-CN", { hour12: false });
  const typeLabel =
    conversation?.type === "group"
      ? "智能体协同群聊"
      : conversation?.type === "direct"
      ? "Hermes 原生直连通道"
      : `外部通道 (${conversation?.channel || "未知"})`;

  const lines: string[] = [];
  lines.push(`# 会话纪要：${title}`);
  lines.push("");
  lines.push(`- **导出时间**：${exportTime}`);
  lines.push(`- **会话类型**：${typeLabel}`);
  lines.push(`- **消息总数**：${messages.length} 条`);
  if (conversation?.chatId) {
    lines.push(`- **目标 ID**：\`${conversation.chatId}\``);
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  if (messages.length === 0) {
    lines.push("*（本会话暂无消息记录）*");
    return lines.join("\n");
  }

  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx];
    const isAI = msg.sender === "ai";
    const senderName = isAI
      ? msg.botName || (conversation?.type === "group" ? "协同智能体" : "管家")
      : "用户";
    const timeStr = msg.timestamp
      ? new Date(msg.timestamp).toLocaleTimeString("zh-CN", { hour12: false })
      : "";

    lines.push(`### [${timeStr || `第 ${idx + 1} 步`}] ${senderName}`);
    lines.push("");
    lines.push(msg.content?.trim() || "（空内容）");
    lines.push("");

    // 附带 Prompt 优化记录
    if (msg.optimizedText && msg.optimizedText !== msg.content) {
      lines.push(`> ⚡ **Prompt 优化对照**：${msg.optimizedText}`);
      lines.push("");
    }

    // 附带流水线接力记录
    if (msg.peerHandoff) {
      lines.push(
        `> 🔄 **自主接力**：已转交给 @${msg.peerHandoff.toBotName ?? msg.peerHandoff.toBotId}（${msg.peerHandoff.reason || "流水线协作"}）`
      );
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * 将单条 AI 回复提取并格式化为标准知识卡片结构。
 */
export function formatMessageToKnowledgeCard(
  msg: IMChatMessage,
  conversation?: IMConversation | null
): {
  defaultTitle: string;
  filename: string;
  content: string;
} {
  const convTitle = conversation?.title?.trim() || "即时通讯工作台";
  const botLabel =
    msg.botName ||
    (conversation?.type === "group" ? "协同智能体" : conversation?.type === "direct" ? "Hermes 直连智能体" : "智能体管家");

  // 提取首行非空文字作为默认标题
  const rawFirstLine = (msg.content || "")
    .split("\n")
    .map((s) => s.replace(/^[#*\s->]+/, "").trim())
    .find((s) => s.length > 0) || "智能体对话沉淀";

  const defaultTitle = rawFirstLine.length > 30 ? `${rawFirstLine.slice(0, 30)}…` : rawFirstLine;
  const safeFilenameTitle = defaultTitle.replace(/[\\/:*?"<>|]/g, "_").slice(0, 20);
  const now = new Date();
  const timeTag = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  const filename = `知识卡片-${safeFilenameTitle}-${timeTag}.md`;

  const dateStr = now.toLocaleString("zh-CN", { hour12: false });

  const content = [
    `# ${defaultTitle}`,
    "",
    `- **来源**：Agent Butler 即时通讯工作台`,
    `- **会话**：${convTitle}`,
    `- **智能体**：${botLabel}`,
    `- **沉淀时间**：${dateStr}`,
    `- **标签**：#IM工作台 #知识沉淀 #智能体问答`,
    "",
    "---",
    "",
    msg.content?.trim() || "",
    "",
  ].join("\n");

  return {
    defaultTitle,
    filename,
    content,
  };
}

/**
 * 触发浏览器本地下载文本内容为文件。
 */
export function triggerTextDownload(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
