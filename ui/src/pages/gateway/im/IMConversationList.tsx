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
} from "@ant-design/icons";
import type { IMConversation } from "./imTypes.js";
import { DEFAULT_DIRECT_CONVERSATION_ID } from "./imSessionStore.js";

const { Text } = Typography;

export interface IMConversationListProps {
  conversations: IMConversation[];
  activeId: string;
  onSelectConversation: (id: string) => void;
  onCreateDirectSession: () => void;
  onDeleteDirectSession: (id: string) => void;
}

function getChannelAvatar(channel: string) {
  if (channel === "hermes" || channel === "api-server") {
    return (
      <Avatar
        size={36}
        style={{ backgroundColor: "#1677ff", flexShrink: 0 }}
        icon={<RobotOutlined style={{ fontSize: 18, color: "#ffffff" }} />}
      />
    );
  }
  if (channel === "weixin") {
    return (
      <Avatar
        size={36}
        style={{ backgroundColor: "#07c160", flexShrink: 0 }}
        icon={<WechatOutlined style={{ fontSize: 18, color: "#ffffff" }} />}
      />
    );
  }
  if (channel === "a2a") {
    return (
      <Avatar
        size={36}
        style={{ backgroundColor: "#722ed1", flexShrink: 0 }}
        icon={<ApiOutlined style={{ fontSize: 18, color: "#ffffff" }} />}
      />
    );
  }
  return (
    <Avatar
      size={36}
      style={{ backgroundColor: "#8c8c8c", flexShrink: 0 }}
      icon={<MessageOutlined style={{ fontSize: 18, color: "#ffffff" }} />}
    />
  );
}

export function IMConversationList(props: IMConversationListProps) {
  const [filterType, setFilterType] = useState<"all" | "direct" | "external">("all");
  const [searchKeyword, setSearchKeyword] = useState("");

  const filteredList = useMemo(() => {
    return props.conversations.filter((c) => {
      if (filterType === "direct" && c.type !== "direct") return false;
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

  return (
    <div className="im-sidebar">
      {/* 顶栏操作区：搜索 + 新建对话 */}
      <div className="im-sidebar-header">
        <Flex justify="space-between" align="center" gap={8}>
          <Text strong style={{ fontSize: 14 }}>
            会话与通道
          </Text>
          <Tooltip title="新建直连对话 (像 Hermes Web UI 一样直连)">
            <Button
              type="primary"
              size="small"
              icon={<PlusOutlined />}
              onClick={props.onCreateDirectSession}
            >
              新对话
            </Button>
          </Tooltip>
        </Flex>

        <Input
          size="small"
          placeholder="搜索会话或消息"
          prefix={<SearchOutlined style={{ color: "var(--ant-color-text-quaternary)" }} />}
          value={searchKeyword}
          onChange={(e) => setSearchKeyword(e.target.value)}
          allowClear
        />

        <Segmented
          size="small"
          block
          value={filterType}
          onChange={(val) => setFilterType(val as "all" | "direct" | "external")}
          options={[
            { label: "全部", value: "all" },
            { label: "Hermes直连", value: "direct" },
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
                    {getChannelAvatar(conv.channel)}
                    {isDirect && (
                      <span
                        className="im-pulse-dot"
                        style={{
                          position: "absolute",
                          right: -1,
                          bottom: -1,
                          border: "2px solid var(--ant-color-bg-container)",
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
                        style={{ fontSize: 13, color: isActive ? "var(--ant-color-primary)" : undefined }}
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
