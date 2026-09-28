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
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  DeleteOutlined,
  PlusOutlined,
  RobotOutlined,
  SearchOutlined,
  CompassOutlined,
  WechatOutlined,
  ApiOutlined,
  MessageOutlined,
  TeamOutlined,
  UserOutlined,
  PushpinOutlined,
  PushpinFilled,
  ClearOutlined,
} from "@ant-design/icons";
import type { IMConversation } from "./imTypes.js";
import { DEFAULT_DIRECT_CONVERSATION_ID } from "./imSessionStore.js";

const { Text } = Typography;

export interface IMConversationListProps {
  conversations: IMConversation[];
  activeId: string;
  onSelectConversation: (id: string) => void;
  onCreateDirectSession: () => void;
  onCreateGroupSession?: () => void;
  onDeleteDirectSession: (id: string) => void;
  onTogglePin?: (id: string) => void;
}

function getConversationAvatar(conv: IMConversation) {
  if (conv.type === "group") {
    return (
      <Avatar
        size={36}
        style={{
          background: "linear-gradient(135deg, var(--ab-brand), var(--ab-warn))",
          boxShadow: "0 2px 8px -1px color-mix(in srgb, var(--ab-warn) 25%, transparent)",
          flexShrink: 0,
        }}
        icon={<TeamOutlined style={{ fontSize: 18, color: "var(--ab-on-primary, #ffffff)" }} />}
      />
    );
  }

  if (conv.botId === "inspector") {
    return (
      <Avatar
        size={36}
        style={{
          background: "linear-gradient(135deg, var(--ab-primary-press), var(--ab-primary))",
          boxShadow: "0 2px 8px -1px color-mix(in srgb, var(--ab-primary) 25%, transparent)",
          flexShrink: 0,
          fontSize: 16,
        }}
        icon={<SearchOutlined />}
      />
    );
  }

  if (conv.botId === "scout") {
    return (
      <Avatar
        size={36}
        style={{
          background: "linear-gradient(135deg, var(--ab-primary-press), var(--ab-primary))",
          boxShadow: "0 2px 8px -1px color-mix(in srgb, var(--ab-primary) 25%, transparent)",
          flexShrink: 0,
          fontSize: 16,
        }}
        icon={<CompassOutlined />}
      />
    );
  }

  if (conv.channel === "hermes" || conv.channel === "api-server" || conv.botId === "butler") {
    return (
      <Avatar
        size={36}
        style={{
          background: "linear-gradient(135deg, var(--ab-primary-press), var(--ab-primary))",
          boxShadow: "0 2px 8px -1px color-mix(in srgb, var(--ab-primary) 25%, transparent)",
          flexShrink: 0,
        }}
        icon={<RobotOutlined style={{ fontSize: 18, color: "var(--ab-on-primary, #ffffff)" }} />}
      />
    );
  }
  if (conv.channel === "weixin") {
    return (
      <Avatar
        size={36}
        style={{
          background: "linear-gradient(135deg, var(--ab-ok), color-mix(in srgb, var(--ab-ok) 75%, black))",
          boxShadow: "0 2px 8px -1px color-mix(in srgb, var(--ab-ok) 25%, transparent)",
          flexShrink: 0,
        }}
        icon={<WechatOutlined style={{ fontSize: 18, color: "var(--ab-on-primary, #ffffff)" }} />}
      />
    );
  }
  if (conv.channel === "a2a") {
    return (
      <Avatar
        size={36}
        style={{
          background: "linear-gradient(135deg, var(--ab-primary), var(--ab-brand))",
          boxShadow: "0 2px 8px -1px color-mix(in srgb, var(--ab-primary) 25%, transparent)",
          flexShrink: 0,
        }}
        icon={<ApiOutlined style={{ fontSize: 18, color: "var(--ab-on-primary, #ffffff)" }} />}
      />
    );
  }
  return (
    <Avatar
      size={36}
      style={{
        background: "linear-gradient(135deg, var(--ab-text-3), var(--ab-text-2))",
        boxShadow: "0 2px 8px -1px color-mix(in srgb, var(--ab-text-2) 20%, transparent)",
        flexShrink: 0,
      }}
      icon={<MessageOutlined style={{ fontSize: 18, color: "#ffffff" }} />}
    />
  );
}

export function IMConversationList(props: IMConversationListProps) {
  const [filterType, setFilterType] = useState<"all" | "group" | "bot" | "external">("all");
  const [searchKeyword, setSearchKeyword] = useState("");

  const counts = useMemo(() => {
    let group = 0;
    let bot = 0;
    let external = 0;
    for (const c of props.conversations) {
      if (c.type === "group") group++;
      else if (c.type === "direct") bot++;
      else if (c.type === "external") external++;
    }
    return {
      all: props.conversations.length,
      group,
      bot,
      external,
    };
  }, [props.conversations]);

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
            { label: `全部 (${counts.all})`, value: "all" },
            { label: `协同群 (${counts.group})`, value: "group" },
            { label: `专职Bot (${counts.bot})`, value: "bot" },
            { label: `外部 (${counts.external})`, value: "external" },
          ]}
        />
      </div>

      {/* 会话列表 */}
      <div className="im-conversation-list">
        {filteredList.length === 0 ? (
          <div style={{ textAlign: "center", padding: "32px 16px", color: "var(--ant-color-text-tertiary)" }}>
            <MessageOutlined style={{ fontSize: 24, marginBottom: 8, opacity: 0.5 }} />
            <div style={{ fontSize: 12 }}>暂无符合条件的会话</div>
            {searchKeyword.trim() && (
              <Button
                type="link"
                size="small"
                icon={<ClearOutlined />}
                style={{ marginTop: 8, fontSize: 12 }}
                onClick={() => setSearchKeyword("")}
              >
                清空搜索条件
              </Button>
            )}
          </div>
        ) : (() => {
          const renderItem = (conv: IMConversation) => {
            const isActive = conv.id === props.activeId;
            const isDirect = conv.type === "direct";
            const isGroup = conv.type === "group";

            let roleTag = null;
            if (isGroup) {
              roleTag = (
                <Tag color="blue" style={{ fontSize: 10, lineHeight: "16px", padding: "0 4px", borderRadius: 4, margin: 0 }}>
                  群聊
                </Tag>
              );
            } else if (isDirect) {
              roleTag = (
                <Tag color="purple" style={{ fontSize: 10, lineHeight: "16px", padding: "0 4px", borderRadius: 4, margin: 0 }}>
                  智能体
                </Tag>
              );
            } else if (conv.channel === "weixin") {
              roleTag = (
                <Tag color="green" style={{ fontSize: 10, lineHeight: "16px", padding: "0 4px", borderRadius: 4, margin: 0 }}>
                  微信
                </Tag>
              );
            } else if (conv.channel === "a2a") {
              roleTag = (
                <Tag color="orange" style={{ fontSize: 10, lineHeight: "16px", padding: "0 4px", borderRadius: 4, margin: 0 }}>
                  A2A
                </Tag>
              );
            }

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
                    {(isDirect || isGroup) && (
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
                    <Flex justify="space-between" align="center" gap={4}>
                      <Flex align="center" gap={6} style={{ minWidth: 0, flex: 1 }}>
                        <Text
                          strong
                          ellipsis
                          style={{ fontSize: 13, color: isActive ? "var(--ab-primary)" : "var(--ab-text)" }}
                        >
                          {conv.title}
                        </Text>
                        {conv.isPinned && (
                          <Tooltip title="已置顶">
                            <PushpinFilled style={{ fontSize: 11, color: "var(--ab-primary)", transform: "rotate(45deg)", flexShrink: 0 }} />
                          </Tooltip>
                        )}
                        {roleTag}
                      </Flex>
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

                      {/* 状态微标与快捷操作 */}
                      <Flex align="center" gap={2}>
                        {conv.errorCount > 0 && (
                          <Tooltip title={`${conv.errorCount} 条消息投递异常/死信`}>
                            <Badge count={conv.errorCount} size="small" />
                          </Tooltip>
                        )}
                        {props.onTogglePin && (
                          <Tooltip title={conv.isPinned ? "取消置顶" : "置顶会话"}>
                            <Button
                              type="text"
                              size="small"
                              aria-label={conv.isPinned ? "取消置顶" : "置顶会话"}
                              icon={
                                conv.isPinned ? (
                                  <PushpinFilled style={{ fontSize: 12, color: "var(--ab-primary)" }} />
                                ) : (
                                  <PushpinOutlined style={{ fontSize: 12, color: "var(--ant-color-text-quaternary)" }} />
                                )
                              }
                              style={{ width: 22, height: 22, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 4 }}
                              onClick={(e) => {
                                e.stopPropagation();
                                props.onTogglePin?.(conv.id);
                              }}
                            />
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
                              aria-label="删除对话"
                              icon={<DeleteOutlined style={{ fontSize: 12 }} />}
                              style={{ width: 22, height: 22, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 4 }}
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
          };

          const isSectioned = filterType === "all" && !searchKeyword.trim();
          const pinnedList = isSectioned
            ? filteredList.filter((c) => Boolean(c.isPinned))
            : [];
          const externalList = isSectioned
            ? filteredList.filter((c) => !c.isPinned)
            : [];

          if (isSectioned && pinnedList.length > 0 && externalList.length > 0) {
            return (
              <>
                <div className="im-conversation-section-title">
                  <span>置顶智能体与群组</span>
                  <span>{pinnedList.length}</span>
                </div>
                {pinnedList.map(renderItem)}
                <div className="im-conversation-section-title" style={{ marginTop: 8 }}>
                  <span>外部通道与联系人</span>
                  <span>{externalList.length}</span>
                </div>
                {externalList.map(renderItem)}
              </>
            );
          }

          return filteredList.map(renderItem);
        })()}
      </div>
    </div>
  );
}
