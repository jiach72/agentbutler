/**
 * 即时通讯工作台：右侧对话窗口组件（IMChatWindow）。
 * - 顶栏：会话详情、渠道标识、直连在线指示灯、清空与排查操作；
 * - 聊天流：时间胶囊、AI 白色卡片气泡（含 Markdown 与死信重投）、用户绿气泡（含 Prompt 对照折叠）；
 * - 思考打字波浪动效（Thinking Wave）；
 * - 底部拟真输入基座（内置 ✨ 增强提示词按钮）。
 */
import { useEffect, useRef, useState } from "react";
import {
  Avatar,
  Button,
  Flex,
  Popconfirm,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  CheckCircleFilled,
  ClearOutlined,
  CloseCircleFilled,
  DownOutlined,
  LoadingOutlined,
  RobotOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { useTheme } from "../../../theme/ThemeProvider.js";
import { Empty } from "../../../components/Empty.js";
import { formatIMTimeCapsule, type IMChatMessage, type IMConversation } from "./imTypes.js";
import { IMMessageInput } from "./IMMessageInput.js";
import { channelLabel } from "../helpers.js";

const { Text } = Typography;

export interface IMChatWindowProps {
  conversation: IMConversation | null;
  messages: IMChatMessage[];
  sending: boolean;
  onSend: (text: string) => Promise<void>;
  onSelectOutboxMessage?: (messageId: string) => void;
  onRedeliver?: (messageId: string) => void;
  onClearHistory?: () => void;
  apiServerAvailable?: boolean;
}

export function IMChatWindow(props: IMChatWindowProps) {
  const { mode } = useTheme();
  const isDark = mode === "dark";
  const streamContainerRef = useRef<HTMLDivElement>(null);
  const streamBottomRef = useRef<HTMLDivElement>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedOptimizations, setExpandedOptimizations] = useState<Set<string>>(new Set());

  // 用户是否向上滚动离开了底部（此时锁定滚动位置，不再随轮询自动回弹）
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const lastConversationIdRef = useRef<string | null>(null);

  // 滚动监听：判断是否接近底部（小于 80px 视为处于底部）
  const handleScroll = () => {
    const el = streamContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setUserScrolledUp(distanceFromBottom > 80);
  };

  const scrollToBottom = (smooth = true) => {
    if (streamBottomRef.current) {
      streamBottomRef.current.scrollIntoView({ behavior: smooth ? "smooth" : "auto" });
      setUserScrolledUp(false);
    }
  };

  // 智能滚动决策：
  // 1. 切换会话 -> 立即滚动到底部（auto）并重置上滑状态
  // 2. 发送中或用户刚发送消息 -> 滚动到底部（smooth）
  // 3. 轮询更新消息 -> 若用户已上滑查看历史，严格保持滚动位置，绝不回滚！
  useEffect(() => {
    const currentConvId = props.conversation?.id ?? null;
    const isConvChanged = currentConvId !== lastConversationIdRef.current;
    lastConversationIdRef.current = currentConvId;

    if (isConvChanged) {
      scrollToBottom(false);
      return;
    }

    if (props.sending) {
      scrollToBottom(true);
      return;
    }

    // 用户正在查看上方历史记录，锁住滚动位置
    if (userScrolledUp) {
      return;
    }

    // 默认保持在底部
    scrollToBottom(true);
  }, [props.conversation?.id, props.messages, props.sending, userScrolledUp]);

  // 复制文本
  const copyText = (id: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // 切换 Prompt 对照折叠
  const toggleOptimization = (id: string) => {
    setExpandedOptimizations((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!props.conversation) {
    return (
      <div className="im-chat-window" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Empty mascot={false} title="请选择或发起一个会话" hint="可在左侧点击任意联系人或创建 Hermes 直连对话" />
      </div>
    );
  }

  const isDirect = props.conversation.type === "direct";
  const wechatGreenBg = isDark ? "#286b32" : "#95ec69";
  const wechatGreenText = isDark ? "#f0fdf4" : "#111827";
  const timeCapsuleBg = isDark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.06)";
  const timeCapsuleColor = isDark ? "#9ca3af" : "#6b7280";

  return (
    <div className="im-chat-window">
      {/* 1. 顶栏：会话标题、渠道标识与状态灯 */}
      <div className="im-chat-header">
        <Flex align="center" gap={12}>
          <div>
            <Flex align="center" gap={8}>
              <Text strong style={{ fontSize: 15 }}>
                {props.conversation.title}
              </Text>
              {isDirect ? (
                <Tag color="blue" icon={<ThunderboltOutlined />} style={{ margin: 0 }}>
                  Hermes 直连通道
                </Tag>
              ) : (
                <Tag color="green" style={{ margin: 0 }}>
                  {channelLabel(props.conversation.channel)}
                </Tag>
              )}
            </Flex>
            <Flex align="center" gap={8} style={{ marginTop: 2 }}>
              {isDirect ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {props.apiServerAvailable ? (
                    <span style={{ color: "#52c41a", display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <span className="im-pulse-dot" /> 直连就绪 (已连通 Hermes api_server)
                    </span>
                  ) : (
                    <span style={{ color: "#faad14" }}>● 直连服务连接中 (支持本地规则与双向交互)</span>
                  )}
                </Text>
              ) : (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  外部通道双向审计与投递模式 · 目标 ID: {props.conversation.chatId || "默认"}
                </Text>
              )}
            </Flex>
          </div>
        </Flex>

        {/* 顶栏右侧快捷操作 */}
        <Flex align="center" gap={8}>
          {isDirect && (
            <Popconfirm
              title="确定清空当前对话的消息历史？"
              description="该操作将清除本会话所有交互记录。"
              okText="清空"
              cancelText="取消"
              onConfirm={props.onClearHistory}
            >
              <Button size="small" type="text" icon={<ClearOutlined />}>
                清空记录
              </Button>
            </Popconfirm>
          )}
        </Flex>
      </div>

      {/* 2. 聊天流消息视窗 */}
      <div className="im-chat-stream" ref={streamContainerRef} onScroll={handleScroll}>
        {props.messages.length === 0 ? (
          <div style={{ margin: "auto", textAlign: "center" }}>
            <Empty
              mascot={false}
              title={isDirect ? "直连通道已开启" : "暂无消息记录"}
              hint={
                isDirect
                  ? "像 Hermes Web UI 一样，在下方输入框直接向智能体发送指令（支持 ✨ 一键增强提示词）"
                  : "外部通道收到或发出消息后将在此实时呈现"
              }
            />
          </div>
        ) : (
          props.messages.map((msg, idx) => {
            const prev = idx > 0 ? props.messages[idx - 1] : null;
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
              <Flex vertical gap={8} key={msg.id} style={{ width: "100%" }}>
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
                      {formatIMTimeCapsule(msg.timestamp)}
                    </span>
                  </div>
                )}

                {/* 消息气泡行：AI在左，用户在右 */}
                {isAI ? (
                  /* ================= AI 气泡 (左侧白色卡片) ================= */
                  <Flex justify="flex-start" align="flex-start" gap={10} style={{ width: "100%" }}>
                    <Avatar
                      size={36}
                      style={{
                        backgroundColor: "#1677ff",
                        flexShrink: 0,
                        boxShadow: "0 1px 4px rgba(0,0,0,0.1)",
                      }}
                      icon={<RobotOutlined style={{ fontSize: 18, color: "#ffffff" }} />}
                    />

                    <Flex vertical align="flex-start" gap={4} style={{ maxWidth: "82%" }}>
                      <Flex align="center" gap={8}>
                        <div
                          className="im-bubble-ai im-markdown-content"
                          onClick={() => {
                            if (msg.rawOutbox && props.onSelectOutboxMessage) {
                              props.onSelectOutboxMessage(msg.id);
                            }
                          }}
                          style={{
                            cursor: msg.rawOutbox ? "pointer" : "default",
                          }}
                        >
                          <div style={{ whiteSpace: "pre-wrap" }}>{msg.content || "（空内容）"}</div>
                        </div>

                        {/* 状态指示与死信重发 */}
                        {msg.state === "delivering" && (
                          <Tooltip title="正在投递中…">
                            <LoadingOutlined style={{ color: "#8c8c8c", fontSize: 16 }} />
                          </Tooltip>
                        )}
                        {(msg.state === "dead_letter" || msg.state === "policy_error") && (
                          <Tooltip title={`发送失败：${msg.lastError || "通道异常"}。点击重新投递`}>
                            <Popconfirm
                              title="重新发送此消息？"
                              onConfirm={() => props.onRedeliver?.(msg.id)}
                              okText="重投"
                              cancelText="取消"
                            >
                              <CloseCircleFilled style={{ color: "#ff4d4f", fontSize: 18, cursor: "pointer" }} />
                            </Popconfirm>
                          </Tooltip>
                        )}
                        {msg.state === "delivered" && (
                          <Tooltip title="已成功送达">
                            <CheckCircleFilled style={{ color: "#52c41a", fontSize: 14, opacity: 0.7 }} />
                          </Tooltip>
                        )}
                      </Flex>

                      {/* 辅助信息微标 */}
                      <Flex align="center" gap={8} style={{ fontSize: 11, color: timeCapsuleColor, paddingLeft: 4 }}>
                        <span>{isDirect ? "Hermes 智能体" : "管家回复"}</span>
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
                              onClick={() => props.onSelectOutboxMessage?.(msg.id)}
                            >
                              链路排查 ➔
                            </span>
                          </>
                        )}
                      </Flex>
                    </Flex>
                  </Flex>
                ) : (
                  /* ================= 用户气泡 (右侧绿色/高亮) ================= */
                  <Flex justify="flex-end" align="flex-start" gap={10} style={{ width: "100%" }}>
                    <Flex vertical align="flex-end" gap={4} style={{ maxWidth: "82%" }}>
                      <div
                        className="im-bubble-user"
                        style={{
                          backgroundColor: wechatGreenBg,
                          color: wechatGreenText,
                          boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
                        }}
                      >
                        <div style={{ whiteSpace: "pre-wrap" }}>{msg.content}</div>
                      </div>

                      {/* Prompt 优化胶囊与对照卡片 */}
                      {msg.optimizedText && msg.optimizedText !== msg.content && (
                        <div style={{ maxWidth: 440, width: "100%", marginTop: 4 }}>
                          <Button
                            type="text"
                            size="small"
                            onClick={() => toggleOptimization(msg.id)}
                            style={{
                              padding: "2px 8px",
                              height: "auto",
                              background: isDark ? "rgba(255,255,255,0.06)" : "#f0f0f0",
                              fontSize: 11,
                              borderRadius: 4,
                            }}
                          >
                            <ThunderboltOutlined style={{ color: "#fa8c16" }} />
                            <span>
                              {isExpanded ? "收起 Prompt 对照" : "查看 Prompt 优化对照"}
                            </span>
                          </Button>

                          {isExpanded && (
                            <div
                              style={{
                                marginTop: 6,
                                padding: "8px 12px",
                                borderRadius: 6,
                                background: isDark ? "#1f1f1f" : "#fafafa",
                                border: "1px solid var(--ant-color-border-secondary)",
                                fontSize: 12,
                              }}
                            >
                              <div style={{ marginBottom: 4 }}>
                                <Text type="secondary" style={{ fontSize: 11 }}>整理后实际执行 Prompt：</Text>
                                <div
                                  style={{
                                    background: isDark ? "#141414" : "#ffffff",
                                    padding: "4px 8px",
                                    borderRadius: 4,
                                    border: "1px solid var(--ant-color-border-secondary)",
                                    fontWeight: 500,
                                    marginTop: 2,
                                  }}
                                >
                                  {msg.optimizedText}
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {/* 辅助信息微标 */}
                      <Flex align="center" gap={6} style={{ fontSize: 11, color: timeCapsuleColor, paddingRight: 4 }}>
                        <span>我</span>
                        <span>·</span>
                        <span
                          style={{ cursor: "pointer" }}
                          onClick={() => copyText(msg.id, msg.content)}
                        >
                          {copiedId === msg.id ? "已复制" : "复制"}
                        </span>
                      </Flex>
                    </Flex>

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

        {/* 思考中动效 */}
        {props.sending && isDirect && (
          <div className="im-thinking-wave">
            <div className="im-thinking-dot" />
            <div className="im-thinking-dot" />
            <div className="im-thinking-dot" />
            <span>Hermes 智能体正在思考并处理指令…</span>
          </div>
        )}

        <div ref={streamBottomRef} />
      </div>

      {/* 悬浮回到底部按钮 */}
      {userScrolledUp && (
        <button
          type="button"
          className="im-scroll-bottom-btn"
          onClick={() => scrollToBottom(true)}
          title="回到底部"
          aria-label="回到底部"
        >
          <DownOutlined />
          <span>回到底部</span>
        </button>
      )}

      {/* 3. 底部拟真输入基座（内置 ✨ 增强提示词按钮） */}
      <IMMessageInput
        onSend={props.onSend}
        sending={props.sending}
        placeholder={
          isDirect
            ? "给 Hermes 智能体发送指令... (支持 ✨ 一键增强提示词，Enter 发送)"
            : `发送消息至 ${channelLabel(props.conversation.channel)}...`
        }
      />
    </div>
  );
}
