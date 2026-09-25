/**
 * 即时通讯工作台：底部拟真输入基座（IMMessageInput）。
 * - 紧随用户原型：内置「增强提示词」Sparkle 按钮（与参考截图红框 100% 对齐）；
 * - 智能平滑回写与一键撤回（Undo Capsule）；
 * - 多行自适应高度输入框，Enter 快捷发送，Shift+Enter 换行；
 * - 快捷运维指令 Chips 与加载状态。
 */
import { useState, useEffect } from "react";
import {
  Button,
  Flex,
  Input,
  Modal,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  ArrowUpOutlined,
  CloseOutlined,
  EyeOutlined,
  UndoOutlined,
  RobotOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { enhancePrompt } from "./promptEnhancer.js";
import type { BotProfile } from "./imTypes.js";
import { EtherealIcon } from "../../../components/EtherealIcon.js";

const { TextArea } = Input;
const { Text } = Typography;

export interface IMMessageInputProps {
  onSend: (text: string) => Promise<void>;
  sending: boolean;
  disabled?: boolean;
  placeholder?: string;
  isGroupChat?: boolean;
  availableBots?: BotProfile[];
}

const QUICK_CHIPS = [
  "检查系统健康与网关状态",
  "汇总待处理告警与死信",
  "查看通道连接与运行时详情",
  "总结近 24 小时消息吞吐",
];

export function IMMessageInput(props: IMMessageInputProps) {
  const [inputText, setInputText] = useState("");
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [undoState, setUndoState] = useState<{
    original: string;
    enhanced: string;
    changes: string[];
  } | null>(null);
  const [diffModalOpen, setDiffModalOpen] = useState(false);

  // 15 秒后自动关闭撤销胶囊
  useEffect(() => {
    if (!undoState) return;
    const timer = setTimeout(() => {
      setUndoState(null);
    }, 15_000);
    return () => clearTimeout(timer);
  }, [undoState]);

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
    const text = inputText.trim();
    if (!text || props.sending || props.disabled) return;

    setUndoState(null);
    setInputText("");
    await props.onSend(text);
  };

  // 键盘事件：Enter 发送，Shift+Enter 换行
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const hasText = inputText.trim().length > 0;
  const hasMention = /@([a-zA-Z0-9_\u4e00-\u9fa5]+)/.test(inputText);

  return (
    <div className="im-input-dock">
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
                  onClick={() => {
                    setInputText((prev) => (prev ? `@${bot.name} ${prev}` : `@${bot.name} `));
                  }}
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

      {/* 快捷运维指令 Chips */}
      <Flex wrap="wrap" gap={6} align="center">
        <Text type="secondary" style={{ fontSize: 11, marginRight: 2 }}>
          快捷指令:
        </Text>
        {QUICK_CHIPS.map((chip) => (
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

      {/* 多行输入文本框 */}
      <TextArea
        value={inputText}
        onChange={(e) => setInputText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={props.placeholder || "输入消息或指令... (Enter 发送，Shift+Enter 换行)"}
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
        <Text type="secondary" style={{ fontSize: 11 }}>
          {inputText.length > 0 ? `${inputText.length} 字` : "支持 Markdown 与快捷指令"}
        </Text>

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
          <Button
            type="primary"
            shape="circle"
            icon={<ArrowUpOutlined />}
            aria-label="发送消息"
            title="发送消息"
            loading={props.sending}
            disabled={!hasText || props.disabled || props.sending}
            onClick={handleSend}
            style={{
              backgroundColor: hasText ? "var(--ant-color-primary)" : undefined,
              boxShadow: hasText ? "0 2px 6px rgba(22, 119, 255, 0.3)" : undefined,
            }}
          />
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
    </div>
  );
}
