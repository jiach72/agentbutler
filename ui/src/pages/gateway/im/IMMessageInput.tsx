/**
 * 即时通讯工作台：底部拟真输入基座（IMMessageInput）。
 * - 紧随用户原型：内置「增强提示词」Sparkle 按钮（与参考截图红框 100% 对齐）；
 * - 智能平滑回写与一键撤回（Undo Capsule）；
 * - 多行自适应高度输入框，Enter 快捷发送，Shift+Enter 换行；
 * - 快捷运维指令 Chips 与加载状态。
 */
import { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  App,
  Button,
  Flex,
  Input,
  Modal,
  Segmented,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  ArrowUpOutlined,
  BookOutlined,
  CloseOutlined,
  CommentOutlined,
  CopyOutlined,
  EyeOutlined,
  FileAddOutlined,
  FileTextOutlined,
  SearchOutlined,
  UndoOutlined,
  RobotOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { enhancePrompt } from "./promptEnhancer.js";
import type { BotProfile } from "./imTypes.js";
import { EtherealIcon } from "../../../components/EtherealIcon.js";
import { loadJson } from "../../../lib/api.js";

const { TextArea } = Input;
const { Text } = Typography;

export interface IMMessageInputProps {
  onSend: (text: string) => Promise<void>;
  sending: boolean;
  disabled?: boolean;
  placeholder?: string;
  isGroupChat?: boolean;
  availableBots?: BotProfile[];
  prefill?: string;
  onClearPrefill?: () => void;
  quotedMessage?: { id: string; sender: string; snippet: string } | null;
  onClearQuote?: () => void;
  onNavigate?: (path: string) => void;
}

export interface QuickPromptCategory {
  key: string;
  label: string;
  items: string[];
}

export const QUICK_PROMPT_CATEGORIES: QuickPromptCategory[] = [
  {
    key: "ops",
    label: "运维排障",
    items: [
      "检查系统健康与网关状态",
      "汇总待处理告警与死信",
      "查看通道连接与运行时详情",
      "总结近 24 小时消息吞吐",
    ],
  },
  {
    key: "summary",
    label: "总结汇报",
    items: [
      "总结今日核心工作进展与关键成果",
      "梳理当前待办事项与阻塞问题清单",
      "生成一份今日执行纪要与明日规划",
    ],
  },
  {
    key: "knowledge",
    label: "知识问答",
    items: [
      "📚 基于本地知识库解答常见问题",
      "根据已沉淀的私有文档梳理核心架构",
      "基于本地知识库检索相关资料并总结",
      "分析当前系统潜在隐患并提供优化建议",
    ],
  },
];

export function IMMessageInput(props: IMMessageInputProps) {
  const { message } = App.useApp();
  let routerNavigate: ((to: string) => void) | null = null;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    routerNavigate = useNavigate();
  } catch {
    routerNavigate = null;
  }
  const safeNavigate = (path: string) => {
    if (routerNavigate) {
      routerNavigate(path);
    } else {
      window.location.assign(path);
    }
  };
  const [inputText, setInputText] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("ops");
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [undoState, setUndoState] = useState<{
    original: string;
    enhanced: string;
    changes: string[];
  } | null>(null);
  const [diffModalOpen, setDiffModalOpen] = useState(false);

  // 文本框 DOM 引用（用于精确定位光标与自动聚焦）
  const textAreaRef = useRef<any>(null);

  // 文件拖拽悬浮状态
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  // 指令发送历史记录与上下键回溯
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number>(-1);
  const draftRef = useRef<string>("");
  const [historyNavActive, setHistoryNavActive] = useState(false);
  // @ 联想补全状态与候选列表
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [selectedMentionIdx, setSelectedMentionIdx] = useState<number>(0);

  const matchedBots = useMemo(() => {
    if (mentionQuery === null || !props.availableBots || props.availableBots.length === 0) {
      return [];
    }
    const q = mentionQuery.toLowerCase().trim();
    if (!q) return props.availableBots;
    return props.availableBots.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        b.id.toLowerCase().includes(q) ||
        (b.description && b.description.toLowerCase().includes(q))
    );
  }, [mentionQuery, props.availableBots]);

  // 从联想列表中选中某个 Bot
  const handleSelectMention = (botName: string) => {
    const dom = (textAreaRef.current?.resizableTextArea?.textArea ||
      textAreaRef.current?.input ||
      textAreaRef.current) as HTMLTextAreaElement | undefined;

    const cursorPos = dom && typeof dom.selectionStart === "number" ? dom.selectionStart : inputText.length;
    const beforeCursor = inputText.slice(0, cursorPos);
    const afterCursor = inputText.slice(cursorPos);
    const atIdx = beforeCursor.lastIndexOf("@");

    if (atIdx !== -1) {
      const replacement = `@${botName} `;
      const nextText = beforeCursor.slice(0, atIdx) + replacement + afterCursor;
      setInputText(nextText);
      setMentionQuery(null);
      setTimeout(() => {
        dom?.focus?.();
        const newPos = atIdx + replacement.length;
        dom?.setSelectionRange?.(newPos, newPos);
      }, 10);
    } else {
      handleInsertMention(botName);
      setMentionQuery(null);
    }
  };

  // 文本变化处理（同步检测 @ 触发与关闭）
  const handleTextChange = (val: string, cursorPos: number) => {
    setInputText(val);
    if (historyNavActive) {
      setHistoryNavActive(false);
      historyIndexRef.current = -1;
    }

    if (props.isGroupChat && props.availableBots && props.availableBots.length > 0) {
      const before = val.slice(0, cursorPos);
      const match = before.match(/@([a-zA-Z0-9_\u4e00-\u9fa5]*)$/);
      if (match) {
        setMentionQuery(match[1]);
        setSelectedMentionIdx(0);
      } else {
        setMentionQuery(null);
      }
    } else {
      setMentionQuery(null);
    }
  };

  const currentChips = useMemo(() => {
    const found = QUICK_PROMPT_CATEGORIES.find((c) => c.key === selectedCategory);
    return found ? found.items : QUICK_PROMPT_CATEGORIES[0].items;
  }, [selectedCategory]);

  const handleCopyDraft = async () => {
    if (!inputText) return;
    try {
      await navigator.clipboard.writeText(inputText);
      message.success("草稿内容已复制到剪贴板");
    } catch {
      message.error("复制失败");
    }
  };

  // 外部预填提示词（如从知识库问答一键跳转追问）
  useEffect(() => {
    if (props.prefill && props.prefill.trim()) {
      setInputText(props.prefill);
      props.onClearPrefill?.();
    }
  }, [props.prefill, props.onClearPrefill]);

  // 15 秒后自动关闭撤销胶囊
  useEffect(() => {
    if (!undoState) return;
    const timer = setTimeout(() => {
      setUndoState(null);
    }, 15_000);
    return () => clearTimeout(timer);
  }, [undoState]);

  // 本地知识库引用选择器状态与加载
  const [knowledgePickerOpen, setKnowledgePickerOpen] = useState(false);
  const [knowledgeDocs, setKnowledgeDocs] = useState<
    Array<{ id: string; name: string; size: number; source: string; updatedAt: string }>
  >([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeSearch, setKnowledgeSearch] = useState("");

  const loadKnowledgeDocs = async () => {
    setKnowledgeLoading(true);
    try {
      const res = await loadJson<{
        ok: boolean;
        documents: Array<{ id: string; name: string; size: number; source: string; updatedAt: string }>;
      }>("/api/knowledge/documents", 5_000);
      if (res.ok && Array.isArray(res.data?.documents)) {
        setKnowledgeDocs(res.data.documents);
      }
    } finally {
      setKnowledgeLoading(false);
    }
  };

  const handleOpenKnowledgePicker = () => {
    setKnowledgePickerOpen(true);
    void loadKnowledgeDocs();
  };

  const handleInsertDocReference = (docName: string) => {
    const refTag = `[参考本地知识库: 《${docName}》]`;
    setInputText((prev) => (prev ? `${prev} ${refTag} ` : `${refTag} `));
    setKnowledgePickerOpen(false);
    message.success(`已插入知识库文档引用《${docName}》`);
  };

  const handleAskWithDoc = (docName: string) => {
    const template = `请结合本地知识库文档《${docName}》的内容，解答以下问题：\n`;
    setInputText(template);
    setKnowledgePickerOpen(false);
    message.success(`已填充基于《${docName}》的问答提示词`);
  };

  // 在当前光标位置智能插入 @Bot 并自动聚焦
  const handleInsertMention = (botName: string) => {
    const mentionStr = `@${botName} `;
    const dom = (textAreaRef.current?.resizableTextArea?.textArea ||
      textAreaRef.current?.input ||
      textAreaRef.current) as HTMLTextAreaElement | undefined;

    if (dom && typeof dom.selectionStart === "number") {
      const start = dom.selectionStart;
      const end = dom.selectionEnd;
      const nextText = inputText.slice(0, start) + mentionStr + inputText.slice(end);
      setInputText(nextText);
      setTimeout(() => {
        dom.focus?.();
        const newPos = start + mentionStr.length;
        dom.setSelectionRange?.(newPos, newPos);
      }, 10);
    } else {
      setInputText((prev) => (prev ? `${mentionStr}${prev}` : mentionStr));
    }
  };

  // 拖拽文件进入输入区域
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDraggingOver) {
      setIsDraggingOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDraggingOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    const textFiles = files.filter(
      (f) =>
        f.type.startsWith("text/") ||
        /\.(md|txt|json|csv|yaml|yml|log|js|ts|tsx|jsx|py|sh|sql)$/i.test(f.name),
    );

    if (textFiles.length === 0) {
      message.warning("仅支持拖入文本类文件 (Markdown, TXT, JSON, YAML, 代码等)");
      return;
    }

    const targetFile = textFiles[0];
    try {
      const content = await targetFile.text();
      const snippet = content.slice(0, 12000);
      const isTruncated = content.length > 12000;
      const formatted = `【文件: ${targetFile.name}】\n\`\`\`\n${snippet}${isTruncated ? "\n... (已截断前 12000 字符)" : ""}\n\`\`\`\n`;
      setInputText((prev) => (prev ? `${prev}\n\n${formatted}` : formatted));
      message.success(`已载入文件《${targetFile.name}》内容到输入框`);
    } catch {
      message.error("读取拖拽文件失败");
    }
  };

  // 处理智能提示词增强（点击 Sparkle 按钮）
  const handleEnhancePrompt = async () => {
    const raw = inputText.trim();
    if (!raw || isEnhancing) return;

    setIsEnhancing(true);
    try {
      const res = await enhancePrompt(raw);
      if (res.enhanced && res.enhanced !== raw) {
        setUndoState({
          original: raw,
          enhanced: res.enhanced,
          changes: res.changes,
        });
        setInputText(res.enhanced);
      }
    } finally {
      setIsEnhancing(false);
    }
  };

  // 撤回为原稿
  const handleUndo = () => {
    if (undoState) {
      setInputText(undoState.original);
      setUndoState(null);
    }
  };

  // 发送消息
  const handleSend = async () => {
    const raw = inputText.trim();
    if (!raw || props.sending || props.disabled) return;

    let text = raw;
    if (props.quotedMessage) {
      text = `[针对 ${props.quotedMessage.sender}：“${props.quotedMessage.snippet}”]\n${raw}`;
      props.onClearQuote?.();
    }

    // 记录到历史指令队列（最多保留 50 条，避免连续相同记录）
    const history = historyRef.current;
    if (history.length === 0 || history[history.length - 1] !== raw) {
      history.push(raw);
      if (history.length > 50) history.shift();
    }
    historyIndexRef.current = -1;
    draftRef.current = "";
    setHistoryNavActive(false);
    setMentionQuery(null);

    setUndoState(null);
    setInputText("");
    await props.onSend(text);
  };

  // 键盘事件：Enter 发送，Shift+Enter 换行；ArrowUp/ArrowDown 回溯历史或选择 Bot；Esc 快速清空/退出回溯
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 键盘处理：如果正在展示 @ 候选列表，优先处理方向键与回车确认
    if (matchedBots.length > 0 && mentionQuery !== null) {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedMentionIdx((prev) => (prev > 0 ? prev - 1 : matchedBots.length - 1));
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedMentionIdx((prev) => (prev < matchedBots.length - 1 ? prev + 1 : 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const chosen = matchedBots[selectedMentionIdx] || matchedBots[0];
        if (chosen) {
          handleSelectMention(chosen.name);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionQuery(null);
        return;
      }
    }
    if (e.key === "Escape") {
      if (historyIndexRef.current !== -1) {
        e.preventDefault();
        setInputText(draftRef.current);
        historyIndexRef.current = -1;
        setHistoryNavActive(false);
        return;
      }
      if (inputText) {
        e.preventDefault();
        setInputText("");
        return;
      }
    }

    // 键盘 ↑ 键：向上唤回历史指令
    if (e.key === "ArrowUp") {
      const textarea = e.currentTarget;
      const isAtFirstLineOrEmpty =
        !inputText || (textarea.selectionStart === 0 && textarea.selectionEnd === 0);
      if (isAtFirstLineOrEmpty && historyRef.current.length > 0) {
        e.preventDefault();
        const history = historyRef.current;
        if (historyIndexRef.current === -1) {
          // 首次启动回溯，暂存当前正在输入的草稿
          draftRef.current = inputText;
          const targetIndex = history.length - 1;
          historyIndexRef.current = targetIndex;
          setInputText(history[targetIndex]);
          setHistoryNavActive(true);
        } else if (historyIndexRef.current > 0) {
          const targetIndex = historyIndexRef.current - 1;
          historyIndexRef.current = targetIndex;
          setInputText(history[targetIndex]);
          setHistoryNavActive(true);
        }
        return;
      }
    }

    // 键盘 ↓ 键：向下回退历史指令
    if (e.key === "ArrowDown" && historyIndexRef.current !== -1) {
      const textarea = e.currentTarget;
      const isAtEnd = textarea.selectionEnd === textarea.value.length;
      if (isAtEnd) {
        e.preventDefault();
        const history = historyRef.current;
        if (historyIndexRef.current < history.length - 1) {
          const targetIndex = historyIndexRef.current + 1;
          historyIndexRef.current = targetIndex;
          setInputText(history[targetIndex]);
          setHistoryNavActive(true);
        } else {
          // 已经回到最底层，恢复最初暂存的草稿
          historyIndexRef.current = -1;
          setInputText(draftRef.current);
          setHistoryNavActive(false);
        }
        return;
      }
    }

    if ((e.key === "Enter" && !e.shiftKey) || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      void handleSend();
    }
  };

  const hasText = inputText.trim().length > 0;
  const hasMention = /@([a-zA-Z0-9_\u4e00-\u9fa5]+)/.test(inputText);

  return (
    <div
      className={`im-input-dock ${isDraggingOver ? "is-dragover" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 拖拽文件进入时的悬浮高光遮罩 */}
      {isDraggingOver && (
        <div className="im-dropzone-overlay">
          <FileAddOutlined style={{ fontSize: 24, color: "var(--ab-primary)" }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ab-primary)" }}>
            松开鼠标以将文本/代码文件内容快速载入输入框
          </span>
        </div>
      )}

      {/* 群聊场景：展示可用 Bot @快捷点名与 Jev 智能指派指示器 */}
      {props.isGroupChat && props.availableBots && props.availableBots.length > 0 && (
        <div style={{ marginBottom: 6, paddingBottom: 6, borderBottom: "1px dashed var(--ant-color-border-secondary)" }}>
          <Flex justify="space-between" align="center" wrap="wrap" gap={6}>
            <Flex align="center" gap={4}>
              <Text type="secondary" style={{ fontSize: 11 }}>
                <TeamOutlined aria-hidden="true" /> 点名专家:
              </Text>
              {props.availableBots.map((bot) => (
                <Button
                  key={bot.id}
                  size="small"
                  className="im-action-chip"
                  aria-label={`点名 ${bot.name}`}
                  disabled={props.disabled || props.sending}
                  onClick={() => handleInsertMention(bot.name)}
                >
                  @{bot.name}
                </Button>
              ))}
            </Flex>

            {!hasMention && hasText && (
              <Tag color="cyan" style={{ fontSize: 11, borderRadius: 10, margin: 0 }}>
                <RobotOutlined aria-hidden="true" /> Jev 智能分流中枢生效中
              </Tag>
            )}
          </Flex>
        </div>
      )}

      {/* 优化后一键撤回胶囊 (Undo Capsule) */}
      {undoState && (
        <div className="im-undo-capsule">
          <span style={{ color: "var(--ant-color-primary)", fontWeight: 500, display: "inline-flex", alignItems: "center", gap: 4 }}>
            <EtherealIcon name="sparkle" size={14} /> 已为您增强提示词
          </span>
          <Button
            type="link"
            size="small"
            icon={<UndoOutlined />}
            onClick={handleUndo}
            style={{ padding: 0, height: "auto", fontSize: 12 }}
          >
            撤回原稿
          </Button>
          <span style={{ color: "var(--ant-color-border)" }}>|</span>
          <Button
            type="link"
            size="small"
            icon={<EyeOutlined />}
            onClick={() => setDiffModalOpen(true)}
            style={{ padding: 0, height: "auto", fontSize: 12 }}
          >
            对比改写
          </Button>
          <Button
            type="text"
            size="small"
            icon={<CloseOutlined style={{ fontSize: 10 }} />}
            aria-label="关闭提示词增强提示"
            title="关闭提示词增强提示"
            onClick={() => setUndoState(null)}
            style={{ width: 16, height: 16, padding: 0, marginLeft: 4 }}
          />
        </div>
      )}

      {/* 快捷指令分类与 Chips */}
      <div style={{ marginBottom: 6 }}>
        <Flex wrap="wrap" gap={8} align="center">
          <Segmented
            size="small"
            value={selectedCategory}
            onChange={(val) => setSelectedCategory(val as string)}
            options={QUICK_PROMPT_CATEGORIES.map((c) => ({
              label: c.label,
              value: c.key,
            }))}
            style={{ fontSize: 11 }}
          />
          <Flex wrap="wrap" gap={6} align="center">
            {currentChips.map((chip) => (
              <Button
                key={chip}
                size="small"
                className="im-action-chip"
                disabled={props.disabled || props.sending}
                onClick={() => {
                  setInputText((prev) => (prev ? `${prev}\n${chip}` : chip));
                }}
              >
                {chip}
              </Button>
            ))}
          </Flex>
        </Flex>
      </div>

      {/* 引用回复预览条 (Quoted Message Banner) */}
      {props.quotedMessage && (
        <div className="im-quoted-banner">
          <div className="im-quoted-content">
            <span style={{ color: "var(--ab-primary)", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 4 }}>
              <CommentOutlined style={{ fontSize: 12 }} /> 引用 {props.quotedMessage.sender}:
            </span>
            <span style={{ color: "var(--ab-text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {props.quotedMessage.snippet}
            </span>
          </div>
          <Button
            type="text"
            size="small"
            icon={<CloseOutlined style={{ fontSize: 10 }} />}
            aria-label="取消引用"
            title="取消引用"
            onClick={props.onClearQuote}
            style={{ width: 18, height: 18, padding: 0 }}
          />
        </div>
      )}

      {/* @ 专家联想悬浮浮层 */}
      {matchedBots.length > 0 && mentionQuery !== null && (
        <div className="im-mention-popup">
          <div className="im-mention-popup-header">
            <span>选择要点名的专家智能体 (↑↓ 选择，Enter / Tab 确认，Esc 取消)</span>
          </div>
          <div className="im-mention-list">
            {matchedBots.map((bot, bIdx) => (
              <div
                key={bot.id}
                className={`im-mention-item ${selectedMentionIdx === bIdx ? "selected" : ""}`}
                onClick={() => handleSelectMention(bot.name)}
                onMouseEnter={() => setSelectedMentionIdx(bIdx)}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <RobotOutlined style={{ color: "var(--ab-primary)", fontSize: 13 }} />
                  <span className="im-mention-item-name">@{bot.name}</span>
                </div>
                <span className="im-mention-item-desc">{bot.description || "专职智能体"}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 多行输入文本框 */}
      <TextArea
        ref={textAreaRef}
        value={inputText}
        onChange={(e) => handleTextChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
        onKeyDown={handleKeyDown}
        placeholder={props.placeholder || "输入消息或指令... (Enter 发送，Shift+Enter 换行，↑ 调出历史，@ 点名专家)"}
        autoSize={{ minRows: 2, maxRows: 6 }}
        disabled={props.disabled}
        variant="borderless"
        style={{
          padding: "4px 0",
          fontSize: 14,
          resize: "none",
        }}
      />

      {/* 底部工具栏与操作按钮 */}
      <Flex justify="space-between" align="center" style={{ paddingTop: 4 }}>
        <Flex align="center" gap={8} wrap="wrap">
          {historyNavActive ? (
            <Tag color="blue" style={{ fontSize: 11, borderRadius: 10, margin: 0, padding: "0 8px" }}>
              ↑↓ 历史指令 ({historyIndexRef.current + 1}/{historyRef.current.length}) · Esc 恢复
            </Tag>
          ) : (
            <Text
              type={inputText.length > 2000 ? "warning" : "secondary"}
              style={{ fontSize: 11, display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              {inputText.length > 0 ? (
                <>
                  <span>{inputText.length} 字</span>
                  {inputText.length > 2000 && <span style={{ color: "var(--ab-warn, #faad14)" }}>(篇幅较长)</span>}
                  <span className="im-shortcut-hint">Enter 发送 · Shift+Enter 换行</span>
                </>
              ) : (
                "支持 Markdown、↑ 调出历史与知识库引用"
              )}
            </Text>
          )}

          <Button
            type="text"
            size="small"
            icon={<BookOutlined style={{ color: "var(--ab-primary)", fontSize: 13 }} />}
            onClick={handleOpenKnowledgePicker}
            style={{
              padding: "2px 8px",
              height: 24,
              fontSize: 11,
              borderRadius: 6,
              background: "var(--ab-surface-2)",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
            title="选择并引用本地私有知识库文档"
          >
            <span>引用知识库</span>
          </Button>

          {hasText && (
            <Flex align="center" gap={6}>
              <Button
                type="link"
                size="small"
                icon={<CopyOutlined style={{ fontSize: 11 }} />}
                onClick={handleCopyDraft}
                style={{ padding: 0, height: "auto", fontSize: 11 }}
              >
                复制草稿
              </Button>
              <span style={{ color: "var(--ant-color-border-secondary)", fontSize: 11 }}>|</span>
              <Button
                type="link"
                size="small"
                onClick={() => setInputText("")}
                style={{ padding: 0, height: "auto", fontSize: 11 }}
              >
                清空 (Esc)
              </Button>
            </Flex>
          )}
        </Flex>

        <Flex align="center" gap={10}>
          {/* 提示词增强按钮（高保真还原参考图红框） */}
          <Tooltip title="AI 智能增强提示词（去除口语客套，将草稿结构化规范为专业指令）">
            <button
              type="button"
              className={`im-sparkle-btn ${!hasText ? "disabled" : ""} ${isEnhancing ? "loading" : ""}`}
              onClick={handleEnhancePrompt}
              disabled={!hasText || isEnhancing || props.disabled}
              aria-label="增强提示词"
            >
              <EtherealIcon name="sparkle" size={15} />
            </button>
          </Tooltip>

          {/* 发送按钮 */}
          <Tooltip title={hasText ? "按 Enter 发送 (Shift+Enter 换行)" : "请输入消息内容"}>
            <span>
              <Button
                type="primary"
                shape="circle"
                icon={<ArrowUpOutlined style={{ fontSize: 16 }} />}
                aria-label="发送消息"
                title="发送消息"
                loading={props.sending}
                disabled={!hasText || props.disabled || props.sending}
                onClick={handleSend}
                style={{
                  width: 34,
                  height: 34,
                  minWidth: 34,
                  minHeight: 34,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: hasText ? "var(--ant-color-primary)" : undefined,
                  boxShadow: hasText ? "0 2px 8px rgba(0, 89, 181, 0.25)" : undefined,
                }}
              />
            </span>
          </Tooltip>
        </Flex>
      </Flex>

      {/* 差异对比 Modal */}
      <Modal
        title="提示词增强对比"
        open={diffModalOpen}
        onOk={() => setDiffModalOpen(false)}
        onCancel={() => setDiffModalOpen(false)}
        footer={[
          <Button key="undo" onClick={() => { handleUndo(); setDiffModalOpen(false); }}>
            撤回为原稿
          </Button>,
          <Button key="ok" type="primary" onClick={() => setDiffModalOpen(false)}>
            保留增强结果
          </Button>,
        ]}
        width={560}
      >
        {undoState && (
          <Flex vertical gap={12} style={{ marginTop: 12 }}>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>优化项：</Text>
              <Flex wrap="wrap" gap={4} style={{ marginTop: 4 }}>
                {undoState.changes.map((c) => (
                  <Tag color="blue" key={c} style={{ fontSize: 11 }}>
                    {c}
                  </Tag>
                ))}
              </Flex>
            </div>

            <div>
              <Text strong style={{ fontSize: 13, color: "var(--ant-color-text-secondary)" }}>
                原始输入：
              </Text>
              <div
                style={{
                  background: "var(--ant-color-fill-quaternary)",
                  padding: "8px 12px",
                  borderRadius: 6,
                  marginTop: 4,
                  fontSize: 13,
                  whiteSpace: "pre-wrap",
                }}
              >
                {undoState.original}
              </div>
            </div>

            <div>
              <Text strong style={{ fontSize: 13, color: "var(--ant-color-primary)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                <EtherealIcon name="sparkle" size={14} /> 增强后提示词：
              </Text>
              <div
                style={{
                  background: "var(--ant-color-primary-bg)",
                  border: "1px solid var(--ant-color-primary-border)",
                  padding: "8px 12px",
                  borderRadius: 6,
                  marginTop: 4,
                  fontSize: 13,
                  whiteSpace: "pre-wrap",
                  color: "var(--ant-color-text)",
                  fontWeight: 500,
                }}
              >
                {undoState.enhanced}
              </div>
            </div>
          </Flex>
        )}
      </Modal>

      {/* 本地知识库引用选择器 Modal */}
      <Modal
        title={
          <Flex align="center" gap={8}>
            <BookOutlined style={{ color: "var(--ab-primary)" }} />
            <span>引用本地私有知识库文档</span>
          </Flex>
        }
        open={knowledgePickerOpen}
        onCancel={() => setKnowledgePickerOpen(false)}
        footer={null}
        width={580}
        destroyOnHidden
      >
        <div style={{ marginTop: 12 }}>
          <Input
            placeholder="搜索文档名称或类型..."
            prefix={<SearchOutlined style={{ color: "var(--ant-color-text-quaternary)" }} />}
            value={knowledgeSearch}
            onChange={(e) => setKnowledgeSearch(e.target.value)}
            allowClear
            size="small"
            style={{ marginBottom: 12 }}
          />

          {knowledgeLoading ? (
            <div style={{ textAlign: "center", padding: "24px 0", color: "var(--ant-color-text-secondary)" }}>
              正在加载本地知识库文档...
            </div>
          ) : (() => {
            const filtered = knowledgeDocs.filter((d) =>
              !knowledgeSearch.trim() || d.name.toLowerCase().includes(knowledgeSearch.trim().toLowerCase())
            );

            if (filtered.length === 0) {
              return (
                <div style={{ textAlign: "center", padding: "24px 16px", color: "var(--ant-color-text-tertiary)" }}>
                  <FileTextOutlined style={{ fontSize: 24, marginBottom: 8, opacity: 0.5 }} />
                  <div style={{ fontSize: 13, marginBottom: 8 }}>
                    {knowledgeDocs.length === 0 ? "本地知识库尚未收集文档" : "未找到匹配的文档"}
                  </div>
                  <Button
                    type="link"
                    size="small"
                    onClick={() => {
                      setKnowledgePickerOpen(false);
                      safeNavigate("/knowledge");
                    }}
                  >
                    前往本地知识库上传私有文档 →
                  </Button>
                </div>
              );
            }

            return (
              <div style={{ maxHeight: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                {filtered.map((doc) => (
                  <div
                    key={doc.id}
                    style={{
                      padding: "8px 12px",
                      borderRadius: 8,
                      border: "1px solid var(--ab-border)",
                      background: "var(--ab-surface)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                    }}
                  >
                    <Flex align="center" gap={8} style={{ minWidth: 0, flex: 1 }}>
                      <FileTextOutlined style={{ color: "var(--ab-primary)", fontSize: 15 }} />
                      <div style={{ minWidth: 0 }}>
                        <Text strong ellipsis style={{ fontSize: 13, display: "block" }}>
                          {doc.name}
                        </Text>
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          {doc.size ? `${Math.max(1, Math.round(doc.size / 1024))} KB` : "文档"} · {doc.source || "资料收集箱"}
                        </Text>
                      </div>
                    </Flex>

                    <Flex align="center" gap={6} style={{ flexShrink: 0 }}>
                      <Button
                        size="small"
                        onClick={() => handleInsertDocReference(doc.name)}
                        title="在输入框追加文档引用标签"
                      >
                        引用
                      </Button>
                      <Button
                        type="primary"
                        size="small"
                        onClick={() => handleAskWithDoc(doc.name)}
                        title="基于该文档填充问答模板"
                      >
                        基于此提问
                      </Button>
                    </Flex>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      </Modal>
    </div>
  );
}
