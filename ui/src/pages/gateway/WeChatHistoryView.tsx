/**
 * 模拟微信聊天工具 UI：以双向即时通讯视窗呈现消息通知与提示词整理历史。
 *
 * 核心交互规范：
 * 1. 左右气泡布局：AI/管家发出的消息在左侧（白色气泡），用户发出的消息在右侧（微信绿气泡）；
 * 2. 按天筛选：默认仅展示「今天」的消息，支持快捷切换「昨天」、「全部」或使用日历精准筛选；
 * 3. 提示词整理对照：右侧用户消息支持一键展开微型「对照」胶囊，比对原始输入与整理后提示词及处理模式；
 * 4. 底部微信输入底座：高度拟真微信桌面端多行输入栏，支持 Enter 快速发送、Shift+Enter 换行；
 * 5. 全链路排查：左侧 AI 消息保持原样支持点击唤起排查 Drawer（生命周期 Trace、重发与投递状态）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Avatar,
  Badge,
  Button,
  Card,
  DatePicker,
  Divider,
  Drawer,
  Flex,
  Input,
  Popconfirm,
  Radio,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  BranchesOutlined,
  CalendarOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  ExclamationCircleFilled,
  InfoCircleOutlined,
  LoadingOutlined,
  RobotOutlined,
  SearchOutlined,
  ThunderboltOutlined,
  UserOutlined,
  WechatOutlined,
} from "@ant-design/icons";
import { useTheme } from "../../theme/ThemeProvider.js";
import { Empty } from "../../components/Empty.js";
import { MessageDetail } from "./MessageInspector.js";
import { channelLabel, MESSAGE_STATE_LABELS } from "./helpers.js";
import type {
  MessageItemView,
  MessageStateFilter,
  MessageTaskView,
} from "./helpers.js";
import { loadJson } from "../../lib/api.js";

const { Text, Paragraph } = Typography;

export interface WeChatHistoryViewProps {
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
}

/** 入站整理消息结构 */
interface InboundHistoryItem {
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

/** 统一双向聊天流数据模型 */
interface UnifiedChatMessage {
  id: string;
  sender: "ai" | "user"; // ai: 靠左(白色气泡), user: 靠右(微信绿气泡)
  content: string;
  timestamp: string; // ISO 8601
  dateStr: string;   // YYYY-MM-DD
  channel?: string;
  chatId?: string;
  sessionId?: string;
  // AI (Outbox) 专属属性
  state?: string;
  lastError?: string | null;
  attemptCount?: number;
  rawOutbox?: MessageItemView;
  // User (Inbound) 专属属性
  optimizedText?: string;
  mode?: "pass-through" | "quick" | "rule" | "llm";
  changes?: string[];
  transformTrace?: string[];
}

/** 格式化本地日期 YYYY-MM-DD */
function toLocalDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 格式化微信居中时间胶囊 */
function formatWeChatTimeCapsule(timestampStr: string): string {
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

export function WeChatHistoryView(props: WeChatHistoryViewProps) {
  const { mode } = useTheme();
  const isDark = mode === "dark";

  // 今天与昨天日期字符串
  const todayStr = useMemo(() => toLocalDateString(new Date()), []);
  const yesterdayStr = useMemo(
    () => toLocalDateString(new Date(Date.now() - 86_400_000)),
    [],
  );

  // 1. 过滤状态
  const [dateFilter, setDateFilter] = useState<string>("today"); // "today" | "yesterday" | "all" | "YYYY-MM-DD"
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [searchKeyword, setSearchKeyword] = useState<string>("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // 展开对照详情的入站消息 ID 集合
  const [expandedOptimizations, setExpandedOptimizations] = useState<Set<string>>(
    new Set(),
  );

  // 2. 入站历史数据
  const [inboundItems, setInboundItems] = useState<InboundHistoryItem[]>([]);
  const [loadingInbound, setLoadingInbound] = useState(false);

  // 加载入站消息优化历史
  const loadInboundHistory = useCallback(async () => {
    setLoadingInbound(true);
    const res = await loadJson<{ reachable: boolean; items: InboundHistoryItem[] }>(
      "/api/messages/optimization-history?limit=100",
      8_000,
    );
    setLoadingInbound(false);
    if (res.ok && Array.isArray(res.data?.items)) {
      setInboundItems(res.data.items);
    }
  }, []);

  useEffect(() => {
    void loadInboundHistory();
  }, [loadInboundHistory]);

  // 通道选项
  const availableChannels = useMemo(() => {
    const set = new Set<string>();
    for (const item of props.items) {
      if (item.channel) set.add(item.channel);
    }
    for (const inItem of inboundItems) {
      if (inItem.inbound?.channel) set.add(inItem.inbound.channel);
    }
    return Array.from(set);
  }, [props.items, inboundItems]);

  // 合并 Inbound 与 Outbox 双向消息流
  const allUnifiedMessages = useMemo(() => {
    const list: UnifiedChatMessage[] = [];

    // A. AI 出站回复与通知 (Outbox) -> sender: "ai"
    for (const item of props.items) {
      const ts = item.capturedAt;
      const d = new Date(ts);
      const dateStr = Number.isNaN(d.getTime()) ? "" : toLocalDateString(d);
      list.push({
        id: item.messageId,
        sender: "ai",
        content: item.content,
        timestamp: ts,
        dateStr,
        channel: item.channel,
        chatId: item.chatId,
        sessionId: item.sessionId,
        state: item.state,
        lastError: item.lastError,
        attemptCount: item.attemptCount,
        rawOutbox: item,
      });
    }

    // B. 用户入站消息与整理优化 (Inbound) -> sender: "user"
    for (const entry of inboundItems) {
      const ts = entry.inbound.receivedAt;
      const d = new Date(ts);
      const dateStr = Number.isNaN(d.getTime()) ? "" : toLocalDateString(d);
      list.push({
        id: entry.inboundMessageId,
        sender: "user",
        content: entry.inbound.content,
        timestamp: ts,
        dateStr,
        channel: entry.inbound.channel,
        chatId: entry.inbound.chatId,
        optimizedText: entry.decision?.optimizedText,
        mode: entry.decision?.mode,
        changes: entry.decision?.changes,
        transformTrace: entry.decision?.transformTrace,
      });
    }

    // 按时间正序排列（旧 -> 新，从上往下滚动）
    list.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    return list;
  }, [props.items, inboundItems]);

  // 按天与条件过滤后的最终列表
  const filteredMessages = useMemo(() => {
    return allUnifiedMessages.filter((msg) => {
      // 1. 日期筛选（默认今天）
      if (dateFilter === "today") {
        if (msg.dateStr !== todayStr) return false;
      } else if (dateFilter === "yesterday") {
        if (msg.dateStr !== yesterdayStr) return false;
      } else if (dateFilter !== "all") {
        if (msg.dateStr !== dateFilter) return false;
      }

      // 2. 通道筛选
      if (channelFilter !== "all" && msg.channel !== channelFilter) {
        return false;
      }

      // 3. 关键词搜索
      if (searchKeyword.trim() !== "") {
        const kw = searchKeyword.toLowerCase();
        const matchContent = (msg.content || "").toLowerCase().includes(kw);
        const matchOptimized = (msg.optimizedText || "").toLowerCase().includes(kw);
        const matchId = (msg.id || "").toLowerCase().includes(kw);
        if (!matchContent && !matchOptimized && !matchId) return false;
      }

      return true;
    });
  }, [allUnifiedMessages, dateFilter, todayStr, yesterdayStr, channelFilter, searchKeyword]);

  // 复制文本
  const copyText = (id: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // 切换入站消息的对照折叠卡片
  const toggleOptimization = (id: string) => {
    setExpandedOptimizations((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 微信样式色值
  const wechatGreenBg = isDark ? "#286b32" : "#95ec69";
  const wechatGreenText = isDark ? "#f0fdf4" : "#111827";
  const aiBubbleBg = isDark ? "#262626" : "#ffffff";
  const aiBubbleText = isDark ? "#e5e7eb" : "#1f1f1f";
  const chatWindowBg = isDark ? "#141414" : "#f5f5f5";
  const timeCapsuleBg = isDark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.06)";
  const timeCapsuleColor = isDark ? "#9ca3af" : "#6b7280";

  return (
    <Card
      styles={{ body: { padding: 0 } }}
      style={{
        borderRadius: 12,
        overflow: "hidden",
        border: "1px solid var(--ant-color-border-secondary)",
        boxShadow: "0 2px 10px rgba(0,0,0,0.04)",
      }}
    >
      {/* 1. 顶部控制栏：模拟微信窗口顶栏、按天筛选与通道状态 */}
      <div
        style={{
          padding: "12px 16px",
          background: isDark ? "#1f1f1f" : "#fafafa",
          borderBottom: "1px solid var(--ant-color-border-secondary)",
        }}
      >
        <Flex justify="space-between" align="center" wrap="wrap" gap={12}>
          <Flex align="center" gap={10}>
            <Avatar
              size={36}
              style={{
                backgroundColor: "#07c160",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              icon={<WechatOutlined style={{ fontSize: 20, color: "#ffffff" }} />}
            />
            <div>
              <Flex align="center" gap={8}>
                <Text strong style={{ fontSize: 15 }}>
                  微信即时通讯工作台
                </Text>
                <Tag color="green" style={{ margin: 0 }}>
                  双向交互
                </Tag>
              </Flex>
              <Text type="secondary" style={{ fontSize: 12 }}>
                AI 发送居左 · 用户发送居右 · 提示词对照
              </Text>
            </div>
          </Flex>

          {/* 筛选工具条：按天筛选 + 通道 + 搜索 */}
          <Flex align="center" gap={8} wrap="wrap">
            {/* 按天快捷切换：今天 / 昨天 / 全部 */}
            <Radio.Group
              size="small"
              value={
                dateFilter === "today" || dateFilter === "yesterday" || dateFilter === "all"
                  ? dateFilter
                  : "custom"
              }
              onChange={(e) => setDateFilter(e.target.value)}
              buttonStyle="solid"
            >
              <Radio.Button value="today">今天</Radio.Button>
              <Radio.Button value="yesterday">昨天</Radio.Button>
              <Radio.Button value="all">全部</Radio.Button>
            </Radio.Group>

            {/* 日期选择器（精准指定某天） */}
            <DatePicker
              size="small"
              placeholder="选择指定日期"
              style={{ width: 130 }}
              onChange={(_date, dateStr) => {
                if (dateStr && typeof dateStr === "string") {
                  setDateFilter(dateStr);
                } else {
                  setDateFilter("today");
                }
              }}
            />

            {/* 通道筛选 */}
            <Select
              size="small"
              style={{ minWidth: 110 }}
              value={channelFilter}
              onChange={(val) => setChannelFilter(val)}
              options={[
                { value: "all", label: "全部通道" },
                ...availableChannels.map((c) => ({
                  value: c,
                  label: channelLabel(c),
                })),
              ]}
            />

            {/* 关键词快速检索 */}
            <Input
              size="small"
              placeholder="搜索消息/提示词"
              prefix={<SearchOutlined style={{ color: "var(--ant-color-text-quaternary)" }} />}
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
              allowClear
              style={{ width: 150 }}
            />
          </Flex>
        </Flex>
      </div>

      {/* 2. 聊天消息流主视窗（AI在左，用户在右） */}
      <div
        style={{
          background: chatWindowBg,
          height: 600,
          overflowY: "auto",
          padding: "20px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {!props.reachable ? (
          <div style={{ margin: "auto", textAlign: "center" }}>
            <Empty mascot={false} title="暂时无法连接消息服务" hint="恢复连接后将自动呈现历史流" />
          </div>
        ) : filteredMessages.length === 0 ? (
          <div style={{ margin: "auto", textAlign: "center" }}>
            <Empty
              mascot={false}
              title={
                dateFilter === "today"
                  ? "今天暂无聊天记录"
                  : dateFilter === "yesterday"
                    ? "昨天暂无聊天记录"
                    : "暂无符合条件的消息记录"
              }
              hint="可切换日期筛选或在下方输入框发起新对话"
            />
          </div>
        ) : (
          filteredMessages.map((msg, idx) => {
            const prev = idx > 0 ? filteredMessages[idx - 1] : null;
            // 超过 5 分钟或首条显示居中时间胶囊
            let showTimeCapsule = false;
            if (!prev) {
              showTimeCapsule = true;
            } else {
              const currTime = new Date(msg.timestamp).getTime();
              const prevTime = new Date(prev.timestamp).getTime();
              if (Math.abs(currTime - prevTime) > 5 * 60 * 1000) {
                showTimeCapsule = true;
              }
            }

            const isAI = msg.sender === "ai";
            const isExpanded = expandedOptimizations.has(msg.id);

            return (
              <Flex vertical gap={10} key={msg.id} style={{ width: "100%" }}>
                {/* 居中时间胶囊 */}
                {showTimeCapsule && (
                  <div style={{ textAlign: "center", margin: "4px 0" }}>
                    <span
                      style={{
                        display: "inline-block",
                        backgroundColor: timeCapsuleBg,
                        color: timeCapsuleColor,
                        fontSize: 12,
                        padding: "2px 10px",
                        borderRadius: 6,
                        userSelect: "none",
                      }}
                    >
                      {formatWeChatTimeCapsule(msg.timestamp)}
                    </span>
                  </div>
                )}

                {/* 消息行：AI 居左 (白色)，用户居右 (微信绿) */}
                {isAI ? (
                  /* ================= 左侧：AI / Butler 发出的消息 ================= */
                  <Flex justify="flex-start" align="flex-start" gap={10} style={{ width: "100%" }}>
                    {/* Butler 头像 */}
                    <Avatar
                      size={36}
                      style={{
                        backgroundColor: "#1677ff",
                        flexShrink: 0,
                        boxShadow: "0 1px 4px rgba(0,0,0,0.1)",
                      }}
                      icon={<RobotOutlined style={{ fontSize: 18, color: "#ffffff" }} />}
                    />

                    {/* 气泡与状态容器 */}
                    <Flex vertical align="flex-start" gap={4} style={{ maxWidth: "75%" }}>
                      <Flex align="center" gap={8}>
                        {/* 白色/浅灰气泡主体 */}
                        <div
                          onClick={() => {
                            if (msg.rawOutbox) props.onSelectMessage(msg.id);
                          }}
                          style={{
                            backgroundColor: aiBubbleBg,
                            color: aiBubbleText,
                            padding: "10px 14px",
                            borderRadius: "2px 10px 10px 10px",
                            border: `1px solid ${isDark ? "#303030" : "#e5e7eb"}`,
                            boxShadow: isDark
                              ? "0 1px 3px rgba(0,0,0,0.3)"
                              : "0 1px 3px rgba(0,0,0,0.06)",
                            fontSize: 14,
                            lineHeight: 1.6,
                            whiteSpace: "pre-wrap",
                            overflowWrap: "anywhere",
                            cursor: msg.rawOutbox ? "pointer" : "default",
                            position: "relative",
                          }}
                        >
                          {msg.content || "（空内容）"}
                        </div>

                        {/* 状态指示器：在气泡右侧 */}
                        {msg.state === "delivering" && (
                          <Tooltip title="正在投递中…">
                            <LoadingOutlined style={{ color: "#8c8c8c", fontSize: 16 }} />
                          </Tooltip>
                        )}
                        {(msg.state === "dead_letter" || msg.state === "policy_error") && (
                          <Tooltip title={`发送失败：${msg.lastError || "请检查通道连接"}。点击重新投递`}>
                            <Popconfirm
                              title="确认重新发送这条消息？"
                              description="消息会重新排队并再次尝试投递至通道。"
                              okText="重投"
                              cancelText="取消"
                              onConfirm={() => props.onRedeliver?.(msg.id)}
                            >
                              <CloseCircleFilled
                                style={{
                                  color: "#ff4d4f",
                                  fontSize: 18,
                                  cursor: "pointer",
                                }}
                              />
                            </Popconfirm>
                          </Tooltip>
                        )}
                        {msg.state === "delivery_unknown" && (
                          <Tooltip title="投递结果未知，请在对端通道核实">
                            <ExclamationCircleFilled style={{ color: "#faad14", fontSize: 18 }} />
                          </Tooltip>
                        )}
                        {msg.state === "delivered" && (
                          <Tooltip title="已成功送达通道">
                            <CheckCircleFilled style={{ color: "#52c41a", fontSize: 14, opacity: 0.7 }} />
                          </Tooltip>
                        )}
                      </Flex>

                      {/* 气泡下方元信息：通道、状态、重试与详情排查 */}
                      <Flex align="center" gap={6} style={{ fontSize: 11, color: timeCapsuleColor, paddingLeft: 2 }}>
                        <span>Butler</span>
                        <span>·</span>
                        <span>{channelLabel(msg.channel || "weixin")}</span>
                        {msg.state && (
                          <>
                            <span>·</span>
                            <span>{MESSAGE_STATE_LABELS[msg.state as keyof typeof MESSAGE_STATE_LABELS] ?? msg.state}</span>
                          </>
                        )}
                        {msg.attemptCount && msg.attemptCount > 1 ? <span>· 尝试 {msg.attemptCount} 次</span> : null}
                        <span>·</span>
                        <span
                          style={{ cursor: "pointer" }}
                          onClick={() => copyText(msg.id, msg.content)}
                        >
                          {copiedId === msg.id ? "已复制" : "复制"}
                        </span>
                        {msg.rawOutbox && (
                          <>
                            <span>·</span>
                            <span
                              style={{ cursor: "pointer", color: "var(--ant-color-primary)" }}
                              onClick={() => props.onSelectMessage(msg.id)}
                            >
                              排查
                            </span>
                          </>
                        )}
                      </Flex>
                    </Flex>
                  </Flex>
                ) : (
                  /* ================= 右侧：用户发出的消息 ================= */
                  <Flex justify="flex-end" align="flex-start" gap={10} style={{ width: "100%" }}>
                    {/* 气泡与对照卡片容器 */}
                    <Flex vertical align="flex-end" gap={4} style={{ maxWidth: "75%" }}>
                      {/* 微信经典绿气泡 */}
                      <div
                        style={{
                          backgroundColor: wechatGreenBg,
                          color: wechatGreenText,
                          padding: "10px 14px",
                          borderRadius: "10px 2px 10px 10px",
                          boxShadow: isDark
                            ? "0 1px 3px rgba(0,0,0,0.3)"
                            : "0 1px 3px rgba(0,0,0,0.06)",
                          fontSize: 14,
                          lineHeight: 1.6,
                          whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                          position: "relative",
                        }}
                      >
                        {msg.content || "（空内容）"}

                        {/* 提示词整理优化微型胶囊 */}
                        {Boolean(msg.optimizedText || msg.mode) && (
                          <Tag
                            color="blue"
                            style={{
                              marginLeft: 8,
                              cursor: "pointer",
                              fontSize: 11,
                              borderRadius: 10,
                              padding: "0 6px",
                              lineHeight: "18px",
                              userSelect: "none",
                            }}
                            onClick={() => toggleOptimization(msg.id)}
                          >
                            <ThunderboltOutlined style={{ marginRight: 2 }} />
                            {isExpanded ? "收起对照" : "提示词对照"}
                          </Tag>
                        )}
                      </div>

                      {/* 提示词双向整理对照折叠卡片 */}
                      {isExpanded && (msg.optimizedText || msg.mode) && (
                        <div
                          style={{
                            width: "100%",
                            background: isDark ? "#1f1f1f" : "#f9fafb",
                            border: `1px solid ${isDark ? "#303030" : "#e5e7eb"}`,
                            borderRadius: 8,
                            padding: "10px 12px",
                            fontSize: 12,
                            lineHeight: 1.5,
                            marginTop: 4,
                            boxShadow: "0 2px 6px rgba(0,0,0,0.05)",
                          }}
                        >
                          <Flex justify="space-between" align="center" style={{ marginBottom: 6 }}>
                            <Text strong style={{ fontSize: 12 }}>
                              <BranchesOutlined style={{ color: "#1677ff", marginRight: 4 }} />
                              提示词整理与优化决策
                            </Text>
                            <Tag color={msg.mode === "llm" ? "purple" : msg.mode === "quick" ? "green" : "blue"}>
                              {msg.mode === "llm"
                                ? "🤖 本地模型改写"
                                : msg.mode === "quick"
                                  ? "⚡ 快捷指令"
                                  : msg.mode === "rule"
                                    ? "📋 规则改写"
                                    : "➡️ 原样透传"}
                            </Tag>
                          </Flex>

                          <div style={{ marginBottom: 6 }}>
                            <Text type="secondary" style={{ fontSize: 11, display: "block" }}>
                              原始用户输入：
                            </Text>
                            <div
                              style={{
                                background: isDark ? "#141414" : "#ffffff",
                                padding: "4px 8px",
                                borderRadius: 4,
                                border: `1px solid ${isDark ? "#282828" : "#f0f0f0"}`,
                                color: isDark ? "#9ca3af" : "#4b5563",
                              }}
                            >
                              {msg.content}
                            </div>
                          </div>

                          <div>
                            <Text type="secondary" style={{ fontSize: 11, display: "block" }}>
                              整理后输入 AI 引擎的 Prompt：
                            </Text>
                            <div
                              style={{
                                background: isDark ? "#141414" : "#ffffff",
                                padding: "4px 8px",
                                borderRadius: 4,
                                border: `1px solid ${isDark ? "#282828" : "#f0f0f0"}`,
                                color: isDark ? "#d1d5db" : "#111827",
                                fontWeight: 500,
                              }}
                            >
                              {msg.optimizedText || msg.content}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* 气泡下方微标：通道、复制 */}
                      <Flex align="center" gap={6} style={{ fontSize: 11, color: timeCapsuleColor, paddingRight: 2 }}>
                        <span>用户</span>
                        <span>·</span>
                        <span>{channelLabel(msg.channel || "weixin")}</span>
                        <span>·</span>
                        <span
                          style={{ cursor: "pointer" }}
                          onClick={() => copyText(msg.id, msg.content)}
                        >
                          {copiedId === msg.id ? "已复制" : "复制"}
                        </span>
                      </Flex>
                    </Flex>

                    {/* 用户头像 */}
                    <Avatar
                      size={36}
                      style={{
                        backgroundColor: "#8c8c8c",
                        flexShrink: 0,
                        boxShadow: "0 1px 4px rgba(0,0,0,0.1)",
                      }}
                      icon={<UserOutlined style={{ fontSize: 18, color: "#ffffff" }} />}
                    />
                  </Flex>
                )}
              </Flex>
            );
          })
        )}
      </div>

      {/* 3. 底部信息与提示栏 */}
      <div
        style={{
          padding: "10px 16px",
          background: isDark ? "#1f1f1f" : "#fafafa",
          borderTop: "1px solid var(--ant-color-border-secondary)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <Flex align="center" gap={12} wrap="wrap">
          <Badge status="processing" text="微信双向通讯审计模式" />
          <Text type="secondary" style={{ fontSize: 12 }}>
            左侧 AI 消息（白气泡）· 右侧用户消息（绿气泡）· 点击任意气泡可复制或排查
          </Text>
        </Flex>
        <Text type="secondary" style={{ fontSize: 12 }}>
          提示：发送失败的消息可点击气泡右侧红感叹号 🔴 一键重发
        </Text>
      </div>

      {/* 4. 消息详情抽屉（复用 MessageDetail） */}
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
          />
        )}
      </Drawer>
    </Card>
  );
}
