/**
 * 即时通讯工作台：右侧对话窗口组件（IMChatWindow）。
 * - 顶栏：会话详情、渠道标识、直连在线指示灯、清空与排查操作；
 * - 聊天流：时间胶囊、AI 白色卡片气泡（含 Markdown 与死信重投）、用户绿气泡（含 Prompt 对照折叠）；
 * - 思考打字波浪动效（Thinking Wave）；
 * - 底部拟真输入基座（内置增强提示词按钮）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  App,
  Avatar,
  Button,
  Flex,
  Input,
  Modal,
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
  TeamOutlined,
  AppstoreAddOutlined,
  SearchOutlined,
  CompassOutlined,
  CopyOutlined,
  SyncOutlined,
  ArrowRightOutlined,
  ExportOutlined,
  ArrowLeftOutlined,
  FullscreenOutlined,
  FullscreenExitOutlined,
  BookOutlined,
  CommentOutlined,
  EditOutlined,
} from "@ant-design/icons";
import { useTheme } from "../../../theme/ThemeProvider.js";
import { Empty } from "../../../components/Empty.js";
import { formatIMTimeCapsule, type IMChatMessage, type IMConversation, type BotProfile } from "./imTypes.js";
import { IMMessageInput } from "./IMMessageInput.js";

/**
 * 辅助高亮函数：对匹配搜索关键词的文本片段进行黄色 mark 标记，防止正则特殊字符注入并保留换行
 */
export function renderHighlightedText(text: string, keyword?: string): React.ReactNode {
  if (!text) return text;
  const kw = keyword?.trim();
  if (!kw) return text;

  try {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(${escaped})`, "gi");
    const parts = text.split(regex);
    if (parts.length <= 1) return text;

    return parts.map((part, i) =>
      regex.test(part) ? (
        <mark
          key={i}
          style={{
            backgroundColor: "#ffe58f",
            color: "#000",
            padding: "0 2px",
            borderRadius: 2,
          }}
        >
          {part}
        </mark>
      ) : (
        part
      ),
    );
  } catch {
    return text;
  }
}

/** 轻量级 Markdown 气泡解析器，支持代码块独立高亮与右上角一键复制反馈，并支持普通文本段内的关键词搜索高亮 */
function RichMarkdownBubble({
  content,
  highlightKeyword,
  onCopyCode,
}: {
  content: string;
  highlightKeyword?: string;
  onCopyCode?: (code: string) => void;
}) {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  if (!content) return <span>（空内容）</span>;
  const parts = content.split(/(```[\s\S]*?```)/g);
  return (
    <div className="im-markdown-rich-content">
      {parts.map((part, index) => {
        if (part.startsWith("```") && part.endsWith("```")) {
          const raw = part.slice(3, -3).replace(/^\n+|\n+$/g, "");
          const firstLineBreak = raw.indexOf("\n");
          let lang = "";
          let code = raw;
          if (firstLineBreak > 0 && firstLineBreak < 24) {
            const possibleLang = raw.slice(0, firstLineBreak).trim();
            if (/^[a-zA-Z0-9_#-]+$/.test(possibleLang)) {
              lang = possibleLang;
              code = raw.slice(firstLineBreak + 1);
            }
          }
          const isCopied = copiedIndex === index;
          return (
            <div key={index} className="im-code-block-wrapper">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
                <span style={{ fontSize: 11, fontFamily: "monospace", opacity: 0.65 }}>{lang || "code"}</span>
                <button
                  type="button"
                  className={`im-code-copy-btn ${isCopied ? "copied" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCopyCode?.(code);
                    setCopiedIndex(index);
                    setTimeout(() => setCopiedIndex((prev) => (prev === index ? null : prev)), 2000);
                  }}
                  title={isCopied ? "代码已复制" : "复制代码块"}
                >
                  {isCopied ? (
                    <>
                      <CheckCircleFilled style={{ fontSize: 10, color: "var(--ab-ok, #52c41a)" }} />
                      <span style={{ color: "var(--ab-ok, #52c41a)" }}>已复制</span>
                    </>
                  ) : (
                    <>
                      <CopyOutlined style={{ fontSize: 10 }} />
                      <span>复制</span>
                    </>
                  )}
                </button>
              </div>
              <pre style={{ margin: 0 }}>
                <code>{code}</code>
              </pre>
            </div>
          );
        }
        return (
          <span key={index} style={{ whiteSpace: "pre-wrap" }}>
            {renderHighlightedText(part, highlightKeyword)}
          </span>
        );
      })}
    </div>
  );
}
import { channelLabel } from "../helpers.js";
import { postJson } from "../../../lib/api.js";
import {
  formatConversationToMarkdown,
  formatMessageToKnowledgeCard,
  triggerTextDownload,
} from "./imExport.js";

const { Text } = Typography;

export interface IMChatWindowProps {
  conversation: IMConversation | null;
  messages: IMChatMessage[];
  sending: boolean;
  onSend: (text: string) => Promise<void>;
  onSelectOutboxMessage?: (messageId: string) => void;
  onRedeliver?: (messageId: string) => void;
  onClearHistory?: () => void;
  onRenameSession?: (id: string, newTitle: string) => void;
  onOpenBotMarket?: () => void;
  apiServerAvailable?: boolean;
  availableBots?: BotProfile[];
  prefill?: string;
  onClearPrefill?: () => void;
  isZenMode?: boolean;
  onToggleZenMode?: () => void;
  onBackToList?: () => void;
}

export function IMChatWindow(props: IMChatWindowProps) {
  const { mode } = useTheme();
  const isDark = mode === "dark";
  const streamContainerRef = useRef<HTMLDivElement>(null);
  const streamBottomRef = useRef<HTMLDivElement>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedOptimizations, setExpandedOptimizations] = useState<Set<string>>(new Set());

  // 会话内消息检索与输入回填
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [localPrefill, setLocalPrefill] = useState<string | null>(null);

  // 用户是否向上滚动离开了底部（此时锁定滚动位置，不再随轮询自动回弹）
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const lastConversationIdRef = useRef<string | null>(null);
  const prevMessageCountRef = useRef(props.messages.length);

  // 会话内消息过滤
  const filteredMessages = useMemo(() => {
    const q = searchKeyword.trim().toLowerCase();
    if (!q) return props.messages;
    return props.messages.filter(
      (m) =>
        m.content.toLowerCase().includes(q) ||
        (m.botName && m.botName.toLowerCase().includes(q)) ||
        m.id.toLowerCase().includes(q),
    );
  }, [props.messages, searchKeyword]);

  // 滚动监听：判断是否接近底部（小于 80px 视为处于底部）
  const handleScroll = () => {
    const el = streamContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const scrolledUp = distanceFromBottom > 80;
    setUserScrolledUp(scrolledUp);
    if (!scrolledUp) {
      setHasNewMessages(false);
    }
  };

  const scrollToBottom = (smooth = true) => {
    if (streamBottomRef.current) {
      streamBottomRef.current.scrollIntoView({ behavior: smooth ? "smooth" : "auto" });
      setUserScrolledUp(false);
      setHasNewMessages(false);
    }
  };

  // 监听新消息到达：若用户正在上方看历史记录，标记有新消息
  useEffect(() => {
    if (userScrolledUp && props.messages.length > prevMessageCountRef.current) {
      setHasNewMessages(true);
    }
    prevMessageCountRef.current = props.messages.length;
  }, [props.messages.length, userScrolledUp]);

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

  // 回填用户历史消息到输入框
  const handleRefillUser = (msg: IMChatMessage) => {
    setLocalPrefill(msg.content);
    scrollToBottom(true);
    message.success("已将指令填入输入框");
  };

  // 引用 AI 回答发起追问
  const handleQuoteAI = (msg: IMChatMessage) => {
    const snippet = msg.content.trim().slice(0, 80).replace(/\n+/g, " ");
    setLocalPrefill(`针对上述回答：“${snippet}${msg.content.length > 80 ? "..." : ""}”：\n`);
    scrollToBottom(true);
    message.success("已生成引用并填入输入框");
  };

  const { message } = App.useApp();
  const [saveKnowledgeModalOpen, setSaveKnowledgeModalOpen] = useState(false);
  const [savingKnowledge, setSavingKnowledge] = useState(false);
  const [knowledgeTitle, setKnowledgeTitle] = useState("");
  const [knowledgeFilename, setKnowledgeFilename] = useState("");
  const [knowledgeContent, setKnowledgeContent] = useState("");

  // 导出会话纪要为 Markdown
  const handleExportMarkdown = () => {
    if (!props.conversation) return;
    const md = formatConversationToMarkdown(props.conversation, props.messages);
    const safeTitle = (props.conversation.title || "未命名会话").replace(/[\\/:*?"<>|]/g, "_").slice(0, 20);
    const now = new Date();
    const timeTag = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
    const filename = `会话纪要-${safeTitle}-${timeTag}.md`;
    triggerTextDownload(md, filename);
    message.success("已导出 Markdown 会话纪要");
  };

  // 打开存为知识弹窗
  const handleOpenSaveKnowledgeModal = (msg: IMChatMessage) => {
    const card = formatMessageToKnowledgeCard(msg, props.conversation);
    setKnowledgeTitle(card.defaultTitle);
    setKnowledgeFilename(card.filename);
    setKnowledgeContent(card.content);
    setSaveKnowledgeModalOpen(true);
  };

  // 确认写入本地知识库收集箱
  const handleConfirmSaveKnowledge = async () => {
    if (!knowledgeFilename.trim() || !knowledgeContent.trim()) {
      message.warning("文件名与知识内容不能为空");
      return;
    }
    setSavingKnowledge(true);
    try {
      const res = await postJson("/api/knowledge/upload", {
        filename: knowledgeFilename.trim(),
        content: knowledgeContent,
        encoding: "utf8",
        source: "upload",
      });
      if (res.ok) {
        message.success(`已沉淀知识卡片「${knowledgeFilename.trim()}」！已写入本地知识库收集箱。`);
        setSaveKnowledgeModalOpen(false);
      } else {
        const errMsg = (res.data as { error?: string })?.error || "写入失败，请检查知识库状态";
        message.error(`存入知识库失败: ${errMsg}`);
      }
    } catch (err) {
      message.error(`请求异常: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSavingKnowledge(false);
    }
  };

  if (!props.conversation) {
    return (
      <div className="im-chat-window" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Empty mascot={false} title="请选择或发起一个会话" hint="可在左侧点击任意联系人或创建 Hermes 直连对话" />
      </div>
    );
  }

  const isDirect = props.conversation.type === "direct";
  const wechatGreenBg = isDark ? "rgba(34, 139, 87, 0.32)" : "#95ec69";
  const wechatGreenText = isDark ? "#e6ffed" : "#111827";
  const wechatGreenBorder = isDark ? "1px solid rgba(34, 139, 87, 0.45)" : "none";
  const timeCapsuleBg = isDark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.06)";
  const timeCapsuleColor = isDark ? "#9ca3af" : "#6b7280";

  return (
    <div className="im-chat-window">
      {props.isZenMode && (
        <div className="im-zen-mode-exit-pill">
          <FullscreenExitOutlined style={{ fontSize: 13 }} />
          <span>全屏纯净模式 · 按 ESC 退出</span>
          <Button
            type="text"
            size="small"
            onClick={props.onToggleZenMode}
            style={{ color: "#ffffff", padding: "0 4px", height: "auto", fontSize: 11 }}
          >
            退出
          </Button>
        </div>
      )}

      {/* 1. 顶栏：会话标题、渠道标识与状态灯 */}
      <div className="im-chat-header">
        <Flex align="center" gap={10}>
          {props.onBackToList && (
            <Button
              type="text"
              size="small"
              icon={<ArrowLeftOutlined />}
              onClick={props.onBackToList}
              className="im-mobile-back-btn"
              style={{ display: "inline-flex", alignItems: "center" }}
              title="返回会话列表"
            >
              返回
            </Button>
          )}
          <div>
            <Flex align="center" gap={8}>
              {props.conversation.type === "group" ? (
                <Typography.Paragraph
                  editable={{
                    tooltip: "点击修改群聊名称",
                    onChange: (val) => {
                      if (val.trim() && props.onRenameSession) {
                        props.onRenameSession(props.conversation!.id, val.trim());
                      }
                    },
                  }}
                  strong
                  style={{ fontSize: 15, margin: 0 }}
                >
                  {props.conversation.title}
                </Typography.Paragraph>
              ) : (
                <Text strong style={{ fontSize: 15 }}>
                  {props.conversation.title}
                </Text>
              )}
              {props.conversation.type === "group" ? (
                <Tag color="gold" icon={<TeamOutlined />} style={{ margin: 0 }}>
                  智能体协同群
                </Tag>
              ) : isDirect ? (
                <Tag color="blue" icon={<ThunderboltOutlined />} style={{ margin: 0 }}>
                  {props.conversation.botId ? `Bot: ${props.conversation.botId}` : "Hermes 直连通道"}
                </Tag>
              ) : (
                <Tag color="green" style={{ margin: 0 }}>
                  {channelLabel(props.conversation.channel)}
                </Tag>
              )}
            </Flex>
            <Flex align="center" gap={8} style={{ marginTop: 2 }}>
              {props.conversation.type === "group" ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  <span style={{ color: "var(--ant-color-text-secondary)" }}>
                    协同成员：
                    {(props.conversation.memberBotIds && props.conversation.memberBotIds.length > 0
                      ? props.conversation.memberBotIds
                      : ["butler", "inspector", "scout"]
                    )
                      .map((bId) => {
                        const found = (props.availableBots || []).find((b) => b.id === bId);
                        return found ? `@${found.name}` : `@${bId}`;
                      })
                      .join("、")} · 支持 Jev 智能调度与多 Bot 接力
                  </span>
                </Text>
              ) : isDirect ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {props.apiServerAvailable ? (
                    <span style={{ color: "var(--ab-ok)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <span className="im-pulse-dot" /> 直连就绪 (已连通 Hermes api_server)
                    </span>
                  ) : (
                    <span style={{ color: "var(--ab-warn)" }}>● 直连服务连接中 (支持本地规则与双向交互)</span>
                  )}
                </Text>
              ) : (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  外部通道双向审计与投递模式 · 目标 ID:{" "}
                  <Tooltip title={props.conversation.chatId ? "点击复制目标 ID" : undefined}>
                    <Tag
                      bordered={false}
                      style={{
                        cursor: props.conversation.chatId ? "pointer" : "default",
                        margin: 0,
                        fontSize: 12,
                        padding: "0 6px",
                      }}
                      onClick={() => {
                        if (props.conversation?.chatId) {
                          copyText("chatId", props.conversation.chatId);
                        }
                      }}
                    >
                      {props.conversation.chatId || "默认"}
                      {props.conversation.chatId && (
                        <CopyOutlined style={{ marginLeft: 4, fontSize: 10 }} />
                      )}
                    </Tag>
                  </Tooltip>
                  {copiedId === "chatId" && (
                    <span style={{ color: "var(--ant-color-success)", marginLeft: 4 }}>已复制</span>
                  )}
                </Text>
              )}
            </Flex>
          </div>
        </Flex>

        {/* 顶栏右侧快捷操作 */}
        <Flex align="center" gap={8}>
          {/* 会话内关键字查找 */}
          {searchOpen ? (
            <Flex align="center" gap={4}>
              <Input
                size="small"
                prefix={<SearchOutlined style={{ color: "var(--ab-text-secondary)" }} />}
                placeholder="在当前会话中查找..."
                value={searchKeyword}
                onChange={(e) => setSearchKeyword(e.target.value)}
                allowClear
                style={{ width: 170 }}
                autoFocus
              />
              <Button
                size="small"
                type="text"
                onClick={() => {
                  setSearchOpen(false);
                  setSearchKeyword("");
                }}
              >
                关闭
              </Button>
            </Flex>
          ) : (
            <Tooltip title="在当前会话记录中按关键字检索">
              <Button
                size="small"
                icon={<SearchOutlined />}
                onClick={() => setSearchOpen(true)}
              >
                查找
              </Button>
            </Tooltip>
          )}

          <Tooltip title={props.messages.length === 0 ? "暂无消息可导出" : "将当前会话导出为结构化 Markdown 纪要"}>
            <Button
              size="small"
              icon={<ExportOutlined />}
              onClick={handleExportMarkdown}
              disabled={props.messages.length === 0}
            >
              导出会话纪要
            </Button>
          </Tooltip>

          <Tooltip title="前往本地知识库（私有资料收集、RAG 检索与知识沉淀）">
            <Button
              size="small"
              icon={<BookOutlined style={{ color: "var(--ab-primary)" }} />}
              onClick={() => {
                window.location.assign("/knowledge");
              }}
            >
              知识库
            </Button>
          </Tooltip>

          {props.conversation.type === "group" && (
            <Button
              size="small"
              icon={<AppstoreAddOutlined />}
              onClick={props.onOpenBotMarket}
            >
              Bot 模板市场
            </Button>
          )}

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

          {props.onToggleZenMode && (
            <Tooltip title={props.isZenMode ? "还原双栏视图" : "禅模式全屏展开（最大化视野）"}>
              <Button
                size="small"
                type="text"
                icon={props.isZenMode ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                onClick={props.onToggleZenMode}
                title={props.isZenMode ? "还原双栏视图" : "禅模式全屏展开"}
              />
            </Tooltip>
          )}
        </Flex>
      </div>

      {/* 2. 聊天流消息视窗 */}
      <div className="im-chat-stream" ref={streamContainerRef} onScroll={handleScroll}>
        {props.messages.length === 0 ? (
          <div style={{ margin: "auto", textAlign: "center", maxWidth: 440, padding: "20px 16px" }}>
            <Empty
              mascot={false}
              title={isDirect ? "直连通道已开启" : "暂无消息记录"}
              hint={
                isDirect
                  ? "像 Hermes Web UI 一样，在下方输入框直接向智能体发送指令（支持一键增强提示词）"
                  : "外部通道收到或发出消息后将在此实时呈现"
              }
            />
            {isDirect && (
              <Flex wrap="wrap" gap={8} justify="center" style={{ marginTop: 16 }}>
                {[
                  "检查系统健康与网关状态",
                  "汇总待处理告警与死信",
                  "查看通道连接与运行时详情",
                  "📚 基于本地知识库解答问题",
                ].map((promptText) => (
                  <Button
                    key={promptText}
                    size="small"
                    style={{ borderRadius: 12, fontSize: 12 }}
                    disabled={props.sending}
                    onClick={() => void props.onSend(promptText)}
                  >
                    {promptText}
                  </Button>
                ))}
              </Flex>
            )}
          </div>
        ) : filteredMessages.length === 0 && searchKeyword.trim() ? (
          <div style={{ margin: "auto", textAlign: "center", maxWidth: 440, padding: "20px 16px" }}>
            <Empty
              mascot={false}
              title={`未找到包含 “${searchKeyword}” 的消息`}
              hint="请尝试输入其他关键词，或清空搜索条件以查看全部记录"
            />
            <Button
              type="primary"
              size="small"
              onClick={() => setSearchKeyword("")}
              style={{ marginTop: 12 }}
            >
              清空搜索条件
            </Button>
          </div>
        ) : (
          <>
            {searchKeyword.trim() && (
              <div
                style={{
                  padding: "6px 12px",
                  background: isDark ? "rgba(22, 119, 255, 0.15)" : "#e6f4ff",
                  border: "1px solid var(--ant-color-primary-border)",
                  borderRadius: 8,
                  marginBottom: 12,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  fontSize: 12,
                }}
              >
                <span style={{ color: "var(--ant-color-primary)" }}>
                  <SearchOutlined style={{ marginRight: 6 }} />
                  找到 <strong>{filteredMessages.length}</strong> 条匹配 “{searchKeyword.trim()}” 的记录
                </span>
                <Button
                  type="link"
                  size="small"
                  onClick={() => setSearchKeyword("")}
                  style={{ padding: 0, height: "auto", fontSize: 12 }}
                >
                  清空搜索
                </Button>
              </div>
            )}
            {filteredMessages.map((msg: IMChatMessage, idx: number) => {
              const prev = idx > 0 ? filteredMessages[idx - 1] : null;
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
                  (() => {
                    let botBg = "#1677ff";
                    let botIcon = <RobotOutlined style={{ fontSize: 18, color: "#ffffff" }} />;
                    let botLabel = msg.botName || (props.conversation?.type === "group" ? "协同智能体" : isDirect ? "全能管家" : "管家回复");

                    if (msg.botId === "inspector") {
                      botBg = "#8b5cf6";
                      botIcon = <SearchOutlined style={{ fontSize: 16, color: "#ffffff" }} />;
                      botLabel = msg.botName || "审查员 (Inspector)";
                    } else if (msg.botId === "scout") {
                      botBg = "#06b6d4";
                      botIcon = <CompassOutlined style={{ fontSize: 16, color: "#ffffff" }} />;
                      botLabel = msg.botName || "侦察员 (Scout)";
                    } else if (msg.botId === "butler") {
                      botBg = "#1677ff";
                      botIcon = <RobotOutlined style={{ fontSize: 18, color: "#ffffff" }} />;
                      botLabel = msg.botName || "全能管家 (Butler)";
                    }

                    return (
                      <div className="im-bubble-row" key={msg.id}>
                        {/* 气泡悬浮操作条 */}
                        <div className="im-bubble-actions">
                          <Tooltip title="复制回答内容">
                            <button
                              type="button"
                              className="im-bubble-action-btn"
                              onClick={() => copyText(msg.id, msg.content)}
                              aria-label="复制回答"
                            >
                              <CopyOutlined style={{ fontSize: 13 }} />
                            </button>
                          </Tooltip>
                          <Tooltip title="一键沉淀为知识卡片存入本地知识库">
                            <button
                              type="button"
                              className="im-bubble-action-btn"
                              onClick={() => handleOpenSaveKnowledgeModal(msg)}
                              aria-label="存为知识"
                            >
                              <BookOutlined style={{ fontSize: 13, color: "var(--ab-primary)" }} />
                            </button>
                          </Tooltip>
                          <Tooltip title="引用此回答并填入输入框追问">
                            <button
                              type="button"
                              className="im-bubble-action-btn"
                              onClick={() => handleQuoteAI(msg)}
                              aria-label="引用追问"
                            >
                              <CommentOutlined style={{ fontSize: 13 }} />
                            </button>
                          </Tooltip>
                        </div>

                        <Flex justify="flex-start" align="flex-start" gap={10} style={{ width: "100%" }}>
                          <Avatar
                            size={36}
                            style={{
                              backgroundColor: botBg,
                              flexShrink: 0,
                              boxShadow: "0 1px 4px rgba(0,0,0,0.1)",
                            }}
                            icon={botIcon}
                          />

                          <Flex vertical align="flex-start" gap={4} style={{ maxWidth: "82%" }}>
                            {/* 智能体身份与 Jev 调度标记 */}
                            <Flex align="center" gap={6} style={{ marginBottom: 2 }}>
                              <Text strong style={{ fontSize: 12, color: "var(--ant-color-text-secondary)" }}>
                                {botLabel}
                              </Text>
                              {msg.dispatchInfo?.selectedByJev && (
                                <Tooltip title={msg.dispatchInfo.reason || "由 TypeSafe Jev 根据需求特征自动分流调度"}>
                                  <Tag color="cyan" style={{ fontSize: 10, borderRadius: 8, margin: 0, padding: "0 6px" }}>
                                    Jev 调度
                                  </Tag>
                                </Tooltip>
                              )}
                              {msg.compliance && (
                                <Tooltip title={msg.compliance.explanation}>
                                  <Tag
                                    color={msg.compliance.compliant ? "default" : "warning"}
                                    style={{ fontSize: 10, borderRadius: 8, margin: 0, padding: "0 6px" }}
                                  >
                                    合规 {msg.compliance.score}/5
                                  </Tag>
                                </Tooltip>
                              )}
                            </Flex>

                            <Flex align="center" gap={8} style={{ width: "100%" }}>
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
                                <RichMarkdownBubble content={msg.content} highlightKeyword={searchKeyword} onCopyCode={(c) => copyText(`code-${msg.id}`, c)} />
                              </div>

                            {/* 状态指示与死信重发 */}
                            {msg.state === "delivering" && (
                              <Tooltip title="正在投递中…">
                                <LoadingOutlined style={{ color: "var(--ab-text-3)", fontSize: 16 }} />
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
                                  <CloseCircleFilled style={{ color: "var(--ant-color-error)", fontSize: 18, cursor: "pointer" }} />
                                </Popconfirm>
                              </Tooltip>
                            )}
                            {msg.state === "delivered" && (
                              <Tooltip title="已成功送达">
                                <CheckCircleFilled style={{ color: "var(--ant-color-success)", fontSize: 14, opacity: 0.8 }} />
                              </Tooltip>
                            )}
                          </Flex>

                          {/* 自主接力卡片（Peer Handoff） */}
                          {msg.peerHandoff && (
                            <div
                              style={{
                                background: isDark ? "rgba(0, 89, 181, 0.12)" : "rgba(0, 89, 181, 0.06)",
                                border: "1px dashed var(--ant-color-primary-border)",
                                borderRadius: 6,
                                padding: "4px 8px",
                                fontSize: 11,
                                color: "var(--ant-color-primary)",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 6,
                              }}
                            >
                              <span>
                                <SyncOutlined style={{ marginRight: 4 }} />
                                触发流水线接力
                                <ArrowRightOutlined style={{ marginLeft: 4, fontSize: 10 }} />
                              </span>
                              <span style={{ fontWeight: 600 }}>@{msg.peerHandoff.toBotName ?? msg.peerHandoff.toBotId}</span>
                              <span style={{ color: "var(--ant-color-text-secondary)" }}>
                                ({msg.peerHandoff.reason || "专职协作"})
                              </span>
                            </div>
                          )}

                          {/* 辅助信息微标 */}
                          <Flex align="center" gap={8} style={{ fontSize: 11, color: timeCapsuleColor, paddingLeft: 4 }}>
                            <span>{isDirect ? "Hermes 智能体" : "管家回复"}</span>
                            <span>·</span>
                            <Tooltip title={`完整 ID: ${msg.id} (点击复制)`}>
                              <span
                                style={{ cursor: "pointer", fontFamily: "var(--ab-font-mono, monospace)" }}
                                onClick={() => copyText(`id-${msg.id}`, msg.id)}
                              >
                                {copiedId === `id-${msg.id}` ? "已复制 ID" : `#${msg.id.slice(0, 8)}`}
                              </span>
                            </Tooltip>
                            <span>·</span>
                            <span
                              style={{ cursor: "pointer" }}
                              onClick={() => copyText(msg.id, msg.content)}
                            >
                              {copiedId === msg.id ? "已复制内容" : "复制"}
                            </span>
                            <span>·</span>
                            <Tooltip title="将此条智能体回答一键沉淀为知识卡片并写入本地知识库收集箱">
                              <span
                                style={{
                                  cursor: "pointer",
                                  color: "var(--ant-color-primary)",
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: 3,
                                }}
                                onClick={() => handleOpenSaveKnowledgeModal(msg)}
                              >
                                <BookOutlined style={{ fontSize: 11 }} />
                                存为知识
                              </span>
                            </Tooltip>
                            <span>·</span>
                            <Tooltip title="引用此回答并填入输入框，方便针对性发起连续追问">
                              <span
                                style={{
                                  cursor: "pointer",
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: 3,
                                }}
                                onClick={() => handleQuoteAI(msg)}
                              >
                                <CommentOutlined style={{ fontSize: 11 }} />
                                引用追问
                              </span>
                            </Tooltip>
                            {msg.rawOutbox && (
                              <>
                                <span>·</span>
                                <span
                                  style={{ cursor: "pointer", color: "var(--ant-color-primary)" }}
                                  onClick={() => props.onSelectOutboxMessage?.(msg.id)}
                                >
                                  链路排查 <ArrowRightOutlined style={{ fontSize: 10 }} />
                                </span>
                              </>
                            )}
                          </Flex>
                        </Flex>
                      </Flex>
                    </div>
                  );
                })()
                ) : (
                  /* ================= 用户气泡 (右侧绿色/高亮) ================= */
                  <Flex justify="flex-end" align="flex-start" gap={10} style={{ width: "100%" }}>
                    <Flex vertical align="flex-end" gap={4} style={{ maxWidth: "82%" }}>
                      {/* 气泡正文（含悬浮快捷工具条） */}
                      <div className="im-bubble-row im-bubble-row-user">
                        <div
                          className="im-bubble-user"
                          style={{
                            backgroundColor: wechatGreenBg,
                            color: wechatGreenText,
                            border: wechatGreenBorder,
                            boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
                          }}
                        >
                          <div style={{ whiteSpace: "pre-wrap" }}>{renderHighlightedText(msg.content, searchKeyword)}</div>
                        </div>

                        {/* 悬浮微型快捷操作条 */}
                        <div className="im-bubble-actions">
                          <Tooltip title="一键复制提问">
                            <Button
                              type="text"
                              size="small"
                              icon={<CopyOutlined style={{ fontSize: 12 }} />}
                              onClick={(e) => {
                                e.stopPropagation();
                                copyText(msg.id, msg.content);
                              }}
                            />
                          </Tooltip>
                          <Tooltip title="重新填入输入框">
                            <Button
                              type="text"
                              size="small"
                              icon={<EditOutlined style={{ fontSize: 12 }} />}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRefillUser(msg);
                              }}
                            />
                          </Tooltip>
                        </div>
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
                              background: isDark ? "rgba(255,255,255,0.06)" : "var(--ant-color-fill-quaternary)",
                              fontSize: 11,
                              borderRadius: 4,
                            }}
                          >
                            <ThunderboltOutlined style={{ color: "var(--ant-color-warning)" }} />
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
                                background: "var(--ant-color-fill-quaternary)",
                                border: "1px solid var(--ant-color-border-secondary)",
                                fontSize: 12,
                              }}
                            >
                              <div style={{ marginBottom: 4 }}>
                                <Text type="secondary" style={{ fontSize: 11 }}>整理后实际执行 Prompt：</Text>
                                <div
                                  style={{
                                    background: "var(--ant-color-bg-container)",
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
                        <Tooltip title={`完整 ID: ${msg.id} (点击复制)`}>
                          <span
                            style={{ cursor: "pointer", fontFamily: "var(--ab-font-mono, monospace)" }}
                            onClick={() => copyText(`id-${msg.id}`, msg.id)}
                          >
                            {copiedId === `id-${msg.id}` ? "已复制 ID" : `#${msg.id.slice(0, 8)}`}
                          </span>
                        </Tooltip>
                        <span>·</span>
                        <span
                          style={{ cursor: "pointer" }}
                          onClick={() => copyText(msg.id, msg.content)}
                        >
                          {copiedId === msg.id ? "已复制内容" : "复制"}
                        </span>
                        <span>·</span>
                        <Tooltip title="将此条消息内容填入下方输入框，方便修改微调或重新发送">
                          <span
                            style={{
                              cursor: "pointer",
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 3,
                            }}
                            onClick={() => handleRefillUser(msg)}
                          >
                            <EditOutlined style={{ fontSize: 11 }} />
                            填入输入框
                          </span>
                        </Tooltip>
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
          })}
        </>
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

      {/* 悬浮回到底部按钮（带新消息智能提示） */}
      {userScrolledUp && (
        <button
          type="button"
          className={`im-scroll-bottom-btn${hasNewMessages ? " has-new" : ""}`}
          onClick={() => scrollToBottom(true)}
          title={hasNewMessages ? "有新消息到达，点击查看" : "回到底部"}
          aria-label={hasNewMessages ? "有新消息，点击回到底部" : "回到底部"}
        >
          <DownOutlined />
          <span>{hasNewMessages ? "有新消息 ↓" : "回到底部"}</span>
          {hasNewMessages && <span className="im-new-msg-dot" />}
        </button>
      )}

      {/* 3. 底部拟真输入基座（内置增强提示词按钮与 @ 点名能力） */}
      <IMMessageInput
        onSend={props.onSend}
        sending={props.sending}
        placeholder={
          props.conversation.type === "group"
            ? "在群聊中输入消息或指令... (可 @指定专家，未指定时由 Jev 智能调度)"
            : isDirect
            ? "给 Hermes 智能体发送指令... (支持一键增强提示词，Enter 发送)"
            : `发送消息至 ${channelLabel(props.conversation.channel)}...`
        }
        isGroupChat={props.conversation.type === "group"}
        availableBots={props.availableBots}
        prefill={localPrefill ?? props.prefill}
        onClearPrefill={() => {
          setLocalPrefill(null);
          props.onClearPrefill?.();
        }}
      />

      {/* 4. 存为知识卡片确认弹窗 */}
      <Modal
        title={
          <Flex align="center" gap={8}>
            <BookOutlined style={{ color: "var(--ant-color-primary)" }} />
            <span>沉淀为本地知识卡片</span>
          </Flex>
        }
        open={saveKnowledgeModalOpen}
        onCancel={() => setSaveKnowledgeModalOpen(false)}
        onOk={handleConfirmSaveKnowledge}
        confirmLoading={savingKnowledge}
        okText="确认存入知识库"
        cancelText="取消"
        width={560}
        destroyOnHidden
      >
        <Flex vertical gap={14} style={{ marginTop: 12 }}>
          <Text type="secondary" style={{ fontSize: 13 }}>
            将当前智能体的回复一键写入本地知识库资料收集箱，自动生成 Markdown 知识文档以供 RAG 问答与星图检索。
          </Text>

          <Flex vertical gap={6}>
            <Text strong style={{ fontSize: 13 }}>
              卡片标题
            </Text>
            <Input
              value={knowledgeTitle}
              onChange={(e) => {
                const newTitle = e.target.value;
                setKnowledgeTitle(newTitle);
                // 同步调整推荐文件名
                const safeTitle = newTitle.replace(/[\\/:*?"<>|]/g, "_").slice(0, 20);
                if (safeTitle) {
                  setKnowledgeFilename((prev) => {
                    const parts = prev.split("-");
                    if (parts.length >= 3) {
                      return `知识卡片-${safeTitle}-${parts.slice(2).join("-")}`;
                    }
                    return `知识卡片-${safeTitle}.md`;
                  });
                }
              }}
              placeholder="请输入知识卡片标题"
            />
          </Flex>

          <Flex vertical gap={6}>
            <Text strong style={{ fontSize: 13 }}>
              保存文件名
            </Text>
            <Input
              value={knowledgeFilename}
              onChange={(e) => setKnowledgeFilename(e.target.value)}
              placeholder="请输入保存文件名 (如 知识卡片-标题.md)"
            />
          </Flex>

          <Flex vertical gap={6}>
            <Flex justify="space-between" align="center">
              <Text strong style={{ fontSize: 13 }}>
                知识卡片正文 (Markdown)
              </Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                可直接按需增删或补充笔记
              </Text>
            </Flex>
            <Input.TextArea
              rows={8}
              value={knowledgeContent}
              onChange={(e) => setKnowledgeContent(e.target.value)}
              style={{ fontFamily: "var(--ab-font-mono, monospace)", fontSize: 13 }}
            />
          </Flex>
        </Flex>
      </Modal>
    </div>
  );
}
