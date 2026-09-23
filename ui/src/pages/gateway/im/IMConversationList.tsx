/**
 * 即时通讯工作台：左侧会话列表组件（IMConversationList）。
 * - 置顶 Hermes 直连会话（支持多会话隔离、新建、删除）；
 * - 自动聚合外部通道联系人与群聊（微信、A2A 等）；
 * - 实时搜索、分类筛选（全部 / 直连 / 外部）、错误/死信预警徽标。
 */
import { useMemo, useState } from "react";
import {
  Avatar,
  Badge,
  Button,
  Dropdown,
  Flex,
  Input,
  Popconfirm,
  Segmented,
  Tooltip,
  Typography,
} from "antd";
import {
  DeleteOutlined,
  PlusOutlined,
  RobotOutlined,
  SearchOutlined,
  WechatOutlined,
  ApiOutlined,
  MessageOutlined,
  TeamOutlined,
  UserOutlined,
} from "@ant-design/icons";
import type { IMConversation } from "./imTypes.js";
import { DEFAULT_DIRECT_CONVERSATION_ID, DEFAULT_GROUP_CONVERSATION_ID } from "./imSessionStore.js";

const { Text } = Typography;

export interface IMConversationListProps {
  conversations: IMConversation[];
  activeId: string;
  onSelectConversation: (id: string) => void;
  onCreateDirectSession: () => void;
  onCreateGroupSession?: () => void;
  onDeleteDirectSession: (id: string) => void;
}

function getConversationAvatar(conv: IMConversation) {
  if (conv.type === "group") {
    return (
      <Avatar
        size={36}
        style={{
          background: "linear-gradient(135deg, #f59e0b, #d97706)",
          boxShadow: "0 2px 8px -1px rgba(245, 158, 11, 0.35)",
          flexShrink: 0,
        }}
        icon={<TeamOutlined style={{ fontSize: 18, color: "#ffffff" }} />}
      />
    );
  }

  if (conv.botId === "inspector") {
    return (
      <Avatar
        size={36}
        style={{
          background: "linear-gradient(135deg, #8b5cf6, #6366f1)",
          boxShadow: "0 2px 8px -1px rgba(139, 92, 246, 0.35)",
          flexShrink: 0,
          fontSize: 16,
        }}
      >
        🔍
      </Avatar>
    );
  }

  if (conv.botId === "scout") {
    return (
      <Avatar
        size={36}
        style={{
          background: "linear-gradient(135deg, #06b6d4, #0d9488)",
          boxShadow: "0 2px 8px -1px rgba(6, 182, 212, 0.35)",
          flexShrink: 0,
          fontSize: 16,
        }}
      >
        🔭
      </Avatar>
    );
  }

  if (conv.channel === "hermes" || conv.channel === "api-server" || conv.botId === "butler") {
    return (
      <Avatar
        size={36}
        style={{
          background: "linear-gradient(135deg, #3b82f6, #1d4ed8)",
          boxShadow: "0 2px 8px -1px rgba(37, 99, 235, 0.35)",
          flexShrink: 0,
        }}
        icon={<RobotOutlined style={{ fontSize: 18, color: "#ffffff" }} />}
      />
    );
  }
  if (conv.channel === "weixin") {
    return (
      <Avatar
        size={36}
        style={{
          background: "linear-gradient(135deg, #10b981, #059669)",
          boxShadow: "0 2px 8px -1px rgba(16, 185, 129, 0.35)",
          flexShrink: 0,
        }}
        icon={<WechatOutlined style={{ fontSize: 18, color: "#ffffff" }} />}
      />
    );
  }
  if (conv.channel === "a2a") {
    return (
      <Avatar
        size={36}
        style={{
          background: "linear-gradient(135deg, #8b5cf6, #6d28d9)",
          boxShadow: "0 2px 8px -1px rgba(139, 92, 246, 0.35)",
          flexShrink: 0,
        }}
        icon={<ApiOutlined style={{ fontSize: 18, color: "#ffffff" }} />}
      />
    );
  }
  return (
    <Avatar
      size={36}
      style={{
        background: "linear-gradient(135deg, #64748b, #475569)",
        boxShadow: "0 2px 8px -1px rgba(100, 116, 139, 0.25)",
        flexShrink: 0,
      }}
      icon={<MessageOutlined style={{ fontSize: 18, color: "#ffffff" }} />}
    />
  );
}

export function IMConversationList(props: IMConversationListProps) {
  const [filterType, setFilterType] = useState<"all" | "group" | "bot" | "external">("all");
  const [searchKeyword, setSearchKeyword] = useState("");

  const filteredList = useMemo(() => {
    return props.conversations.filter((c) => {
      if (filterType === "group" && c.type !== "group") return false;
      if (filterType === "bot" && c.type !== "direct") return false;
      if (filterType === "external" && c.type !== "external") return false;

      if (searchKeyword.trim() !== "") {
        const kw = searchKeyword.toLowerCase();
        const matchTitle = c.title.toLowerCase().includes(kw);
        const matchChannel = c.channel.toLowerCase().includes(kw);
        const matchLast = c.lastMessage?.content.toLowerCase().includes(kw);
        if (!matchTitle && !matchChannel && !matchLast) return false;
      }
      return true;
    });
  }, [props.conversations, filterType, searchKeyword]);

  const newItems = [
    {
      key: "group",
      label: "新建协同群聊",
      icon: <TeamOutlined />,
      onClick: () => props.onCreateGroupSession?.(),
    },
    {
      key: "direct",
      label: "新建 Bot 对话",
      icon: <UserOutlined />,
      onClick: () => props.onCreateDirectSession(),
    },
  ];

  return (
    <div className="im-sidebar">
      {/* 顶栏操作区：搜索 + 新建对话 */}
      <div className="im-sidebar-header">
        <Flex justify="space-between" align="center" gap={8}>
          <Text strong style={{ fontSize: 14 }}>
            智能体与会话
          </Text>
          <Dropdown menu={{ items: newItems }} placement="bottomRight">
            <Button
              type="primary"
              size="small"
              icon={<PlusOutlined />}
            >
              发起
            </Button>
          </Dropdown>
        </Flex>

        <Input
          size="small"
          placeholder="搜索智能体、群聊或消息"
          prefix={<SearchOutlined style={{ color: "var(--ant-color-text-quaternary)" }} />}
          value={searchKeyword}
          onChange={(e) => setSearchKeyword(e.target.value)}
          allowClear
        />

        <Segmented
          size="small"
          block
          value={filterType}
          onChange={(val) => setFilterType(val as "all" | "group" | "bot" | "external")}
          options={[
            { label: "全部", value: "all" },
            { label: "协同群", value: "group" },
            { label: "专职Bot", value: "bot" },
            { label: "外部通道", value: "external" },
          ]}
        />
      </div>

      {/* 会话列表 */}
      <div className="im-conversation-list">
        {filteredList.length === 0 ? (
          <div style={{ textAlign: "center", padding: "32px 16px", color: "var(--ant-color-text-tertiary)" }}>
            <MessageOutlined style={{ fontSize: 24, marginBottom: 8, opacity: 0.5 }} />
            <div style={{ fontSize: 12 }}>暂无符合条件的会话</div>
          </div>
        ) : (
          filteredList.map((conv) => {
            const isActive = conv.id === props.activeId;
            const isDirect = conv.type === "direct";

            return (
              <div
                key={conv.id}
                className={`im-conversation-item ${isActive ? "active" : ""}`}
                onClick={() => props.onSelectConversation(conv.id)}
              >
                <Flex align="center" gap={10}>
                  {/* 头像与通道徽标 */}
                  <div style={{ position: "relative" }}>
                    {getConversationAvatar(conv)}
                    {(isDirect || conv.type === "group") && (
                      <span
                        className="im-pulse-dot"
                        style={{
                          position: "absolute",
                          right: -1,
                          bottom: -1,
                          border: "2px solid var(--ab-surface)",
                        }}
                      />
                    )}
                  </div>

                  {/* 标题与最后一条消息预览 */}
                  <Flex vertical style={{ minWidth: 0, flex: 1 }} gap={2}>
                    <Flex justify="space-between" align="center">
                      <Text
                        strong
                        ellipsis
                        style={{ fontSize: 13, color: isActive ? "var(--ab-primary)" : "var(--ab-text)" }}
                      >
                        {conv.title}
                      </Text>
                      {conv.lastMessage && (
                        <Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>
                          {conv.lastMessage.timestamp.slice(11, 16)}
                        </Text>
                      )}
                    </Flex>

                    <Flex justify="space-between" align="center" gap={4}>
                      <Text
                        type="secondary"
                        ellipsis
                        style={{ fontSize: 12, color: "var(--ant-color-text-tertiary)" }}
                      >
                        {conv.lastMessage
                          ? `${conv.lastMessage.sender === "ai" ? "AI: " : "用户: "}${conv.lastMessage.content}`
                          : "暂无消息记录"}
                      </Text>

                      {/* 状态微标 */}
                      <Flex align="center" gap={4}>
                        {conv.errorCount > 0 && (
                          <Tooltip title={`${conv.errorCount} 条消息投递异常/死信`}>
                            <Badge count={conv.errorCount} size="small" style={{ backgroundColor: "#ff4d4f" }} />
                          </Tooltip>
                        )}
                        {isDirect && conv.id !== DEFAULT_DIRECT_CONVERSATION_ID && (
                          <Popconfirm
                            title="确定删除此对话？"
                            onConfirm={(e) => {
                              e?.stopPropagation();
                              props.onDeleteDirectSession(conv.id);
                            }}
                            onCancel={(e) => e?.stopPropagation()}
                            okText="删除"
                            cancelText="取消"
                          >
                            <Button
                              type="text"
                              size="small"
                              icon={<DeleteOutlined />}
                              style={{ width: 20, height: 20, padding: 0 }}
                              onClick={(e) => e.stopPropagation()}
                            />
                          </Popconfirm>
                        )}
                      </Flex>
                    </Flex>
                  </Flex>
                </Flex>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
