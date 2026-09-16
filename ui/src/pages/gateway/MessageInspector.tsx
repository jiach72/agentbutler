import { useMemo, useState } from "react";
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Flex,
  Pagination,
  Popconfirm,
  Segmented,
  Select,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from "antd";
import { AdvancedEvidence } from "../../components/AdvancedEvidence.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { Empty } from "../../components/Empty.js";
import { formatRelative } from "../../lib/format.js";
import {
  ACTIONABLE_MESSAGE_STATES,
  ACTIONABLE_TIME_OPTIONS,
  isActionableMessage,
  isMessageWithinHours,
  messageSummary,
} from "./attention.js";
import type { ActionableTimeFilter } from "./attention.js";
import {
  dismissMessageId,
  dismissMessageIds,
  readDismissedMessageIds,
} from "./actionableDismiss.js";
import {
  MESSAGE_STATE_LABELS,
  channelLabel,
  formatTimestamp,
  statusTone,
  taskEventLabel,
  transformTraceLabel,
} from "./helpers.js";
import type {
  MessageBridgeView,
  MessageItemView,
  MessageStateFilter,
  MessageTaskView,
} from "./helpers.js";

interface MessageInspectorProps {
  messageBridge: MessageBridgeView | null;
  coverageEntries: Array<[string, string]>;
  messageCounts: Record<string, number>;
  messageItems: MessageItemView[];
  messagesReachable: boolean;
  selectedMessage: MessageItemView | null;
  onSelectMessage: (messageId: string | null) => void;
  taskData: MessageTaskView | null;
  taskLoading: boolean;
  pendingOnly?: boolean;
  activeStateFilter?: MessageStateFilter;
  onStateFilterChange?: (filter: MessageStateFilter) => void;
  onRedeliver?: (messageId: string) => void;
  redeliverBusy?: boolean;
  onExpedite?: (messageId: string) => void;
  expediteBusy?: boolean;
  onDismiss?: (messageId: string) => void;
  defaultTimeFilter?: ActionableTimeFilter;
}

export const MESSAGE_CHIP_STATES = [
  "captured",
  "policy_pending",
  "held_dnd",
  "held_pacing",
  "ready",
  "delivering",
  "retry_wait",
  "delivered",
  "delivery_unknown",
  "policy_error",
  "dead_letter",
  "absorbed",
  "cancelled",
] as const;

type DetailProps = Pick<
  MessageInspectorProps,
  | "taskData"
  | "taskLoading"
  | "onRedeliver"
  | "redeliverBusy"
  | "onExpedite"
  | "expediteBusy"
  | "onDismiss"
> & { message: MessageItemView };

export function MessageDetail({
  message,
  taskData,
  taskLoading,
  onRedeliver,
  redeliverBusy,
  onExpedite,
  expediteBusy,
  onDismiss,
}: DetailProps) {
  return (
    <Flex vertical gap={16} style={{ minWidth: 0, overflowWrap: "anywhere" }}>
      <StatusBadge {...statusTone(message.state)} />
      <Typography.Paragraph style={{ whiteSpace: "pre-wrap", margin: 0 }}>
        {message.content || "（空消息内容）"}
      </Typography.Paragraph>
      <Descriptions
        size="small"
        column={1}
        items={[
          { key: "channel", label: "通道", children: channelLabel(message.channel) },
          { key: "captured", label: "收到时间", children: formatTimestamp(message.capturedAt) },
          { key: "delivered", label: "送达时间", children: formatTimestamp(message.deliveredAt) },
        ]}
      />
      {message.state === "delivery_unknown" && (
        <Alert
          type="warning"
          showIcon
          title="这条消息的发送结果未知"
          description="请先在接收通道核实是否收到，请勿重复发送。恢复连接后重新检查送达记录；结果未知不等于发送失败。"
          action={
            onDismiss && (
              <Button size="small" onClick={() => onDismiss(message.messageId)}>
                已核实并忽略
              </Button>
            )
          }
        />
      )}
      {message.state === "dead_letter" && (
        <Alert
          type="warning"
          showIcon
          title="这条消息发送失败，已被搁置"
          description="先检查通道连接。确认重新投递后，消息会按当前规则再次发送给对方。"
          action={
            <Flex gap={8} wrap>
              {onRedeliver && (
                <Button danger loading={redeliverBusy} onClick={() => onRedeliver(message.messageId)}>
                  重新投递
                </Button>
              )}
              {onDismiss && (
                <Button size="small" onClick={() => onDismiss(message.messageId)}>
                  忽略此条
                </Button>
              )}
            </Flex>
          }
        />
      )}
      {message.state === "policy_error" && (
        <Alert
          type="warning"
          showIcon
          title="消息规则未能完成处理"
          description="检查通知规则和通道连接，修正后刷新发送结果。"
          action={
            <Flex gap={8} wrap>
              <Button href="/gateway?tab=rules">检查通知规则</Button>
              {onDismiss && (
                <Button size="small" onClick={() => onDismiss(message.messageId)}>
                  忽略此条
                </Button>
              )}
            </Flex>
          }
        />
      )}
      {["held_dnd", "held_pacing", "ready"].includes(message.state) && onExpedite && (
        <Alert
          type="info"
          showIcon
          title="这条消息正在排队"
          description="立即发送会跳过剩余等待，按队列顺序尽快投递。"
          action={
            <Button loading={expediteBusy} onClick={() => onExpedite(message.messageId)}>
              立即发送
            </Button>
          }
        />
      )}
      <AdvancedEvidence>
        <Descriptions
          size="small"
          column={1}
          items={[
            { key: "message", label: "消息编号", children: message.messageId },
            { key: "session", label: "会话编号", children: message.sessionId },
            { key: "run", label: "任务编号", children: message.runId ?? "未关联" },
            {
              key: "inbound",
              label: "相关消息编号",
              children: message.inboundMessageId ?? "未关联",
            },
            {
              key: "provider",
              label: "平台消息编号",
              children: message.providerMessageId ?? "未返回",
            },
            { key: "state", label: "原始状态", children: message.state },
            {
              key: "transport",
              label: "发送方式",
              children: `${message.transport} · ${message.messageKind}`,
            },
            { key: "attempts", label: "尝试次数", children: message.attemptCount },
          ]}
        />
        {[message.lastError, message.lastPolicyError, message.metadata.summaryError]
          .filter((error): error is string => typeof error === "string")
          .map((error, index) => (
            <Typography.Paragraph key={index} style={{ whiteSpace: "pre-wrap" }}>
              {error}
            </Typography.Paragraph>
          ))}
        <Typography.Title level={5}>消息处理步骤</Typography.Title>
        <Timeline
          items={message.transformTrace.map((step, index) => ({
            key: index,
            children: <span title={step}>{transformTraceLabel(step)}</span>,
          }))}
        />
        <Typography.Title level={5}>相关任务进度</Typography.Title>
        {taskLoading ? (
          <Typography.Text>正在读取任务事件</Typography.Text>
        ) : taskData === null || taskData.runId !== message.runId ? (
          <Typography.Text>没有关联的任务记录</Typography.Text>
        ) : (
          <Timeline
            items={taskData.events.map((event) => ({
              key: event.sequence,
              children: (
                <span>
                  {event.summary ?? taskEventLabel(event.kind)} ·{" "}
                  {formatTimestamp(event.occurredAt)}
                </span>
              ),
            }))}
          />
        )}
      </AdvancedEvidence>
    </Flex>
  );
}

export function MessageInspector(props: MessageInspectorProps) {
  const {
    selectedMessage,
    pendingOnly = false,
    activeStateFilter = "all",
    onStateFilterChange,
  } = props;

  const [timeFilter, setTimeFilter] = useState<ActionableTimeFilter>(
    props.defaultTimeFilter ?? "24h",
  );
  const [dismissedVersion, setDismissedVersion] = useState(0);

  const dismissedSet = useMemo(() => readDismissedMessageIds(), [dismissedVersion]);

  const actionableItems = useMemo(
    () => props.messageItems.filter(isActionableMessage),
    [props.messageItems],
  );

  const activeTimeOption =
    ACTIONABLE_TIME_OPTIONS.find((o) => o.value === timeFilter) ?? ACTIONABLE_TIME_OPTIONS[0];

  const messageItems = useMemo(() => {
    if (!pendingOnly) return props.messageItems;
    return actionableItems.filter((item) => {
      if (dismissedSet.has(item.messageId)) return false;
      return isMessageWithinHours(item.updatedAt, activeTimeOption.hours);
    });
  }, [pendingOnly, props.messageItems, actionableItems, dismissedSet, activeTimeOption.hours]);

  const hiddenOlderCount = useMemo(() => {
    if (!pendingOnly || activeTimeOption.hours === Infinity) return 0;
    return actionableItems.filter(
      (item) =>
        !dismissedSet.has(item.messageId) &&
        !isMessageWithinHours(item.updatedAt, activeTimeOption.hours),
    ).length;
  }, [pendingOnly, actionableItems, dismissedSet, activeTimeOption.hours]);

  const handleDismissOne = (messageId: string) => {
    dismissMessageId(messageId);
    setDismissedVersion((v) => v + 1);
    props.onSelectMessage(null);
    props.onDismiss?.(messageId);
  };

  const handleDismissAll = () => {
    dismissMessageIds(messageItems.map((m) => m.messageId));
    setDismissedVersion((v) => v + 1);
    props.onSelectMessage(null);
  };

  const [page, setPage] = useState(1);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(messageItems.length / 8)));
  const states = pendingOnly ? ACTIONABLE_MESSAGE_STATES : MESSAGE_CHIP_STATES;
  return (
    <Flex vertical gap={16}>
      <Flex wrap gap={12} justify="space-between" align="center">
        <Flex align="center" gap={8} wrap>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {pendingOnly ? "需要处理的消息" : "消息记录"}
          </Typography.Title>
          {pendingOnly && hiddenOlderCount > 0 && (
            <Tooltip
              title={`当前时间范围为「${activeTimeOption.label}」，已自动收纳 ${hiddenOlderCount} 条更早的历史异常。可切换为「全部未决」或前往「发送历史」查看。`}
            >
              <Tag
                color="default"
                style={{ margin: 0, cursor: "pointer" }}
                onClick={() => setTimeFilter("all")}
              >
                已收纳 {hiddenOlderCount} 条更早记录
              </Tag>
            </Tooltip>
          )}
        </Flex>
        {pendingOnly ? (
          <Flex align="center" gap={8} wrap>
            <Segmented
              size="small"
              value={timeFilter}
              onChange={(val) => {
                setPage(1);
                setTimeFilter(val as ActionableTimeFilter);
              }}
              options={ACTIONABLE_TIME_OPTIONS.map((opt) => ({
                label: opt.label,
                value: opt.value,
              }))}
            />
            {messageItems.length > 0 && (
              <Popconfirm
                title="确认全部忽略？"
                description="将当前列表中的待处理记录标记为已核实，不再在待处理列表中提醒。"
                okText="全部忽略"
                cancelText="取消"
                onConfirm={handleDismissAll}
              >
                <Button size="small">全部忽略</Button>
              </Popconfirm>
            )}
          </Flex>
        ) : (
          <Select<MessageStateFilter>
            aria-label="消息状态"
            value={activeStateFilter}
            onChange={onStateFilterChange}
            style={{ width: 200, maxWidth: "100%" }}
            options={[
              { value: "all", label: "全部记录" },
              ...states.map((state) => ({
                value: state,
                label: `${MESSAGE_STATE_LABELS[state]} (${props.messageCounts[state] ?? 0})`,
              })),
            ]}
          />
        )}
      </Flex>
      {!props.messagesReachable ? (
        <Empty
          mascot={false}
          title="暂时读不到消息"
          hint="恢复连接后请刷新，当前无法确认待处理数量。"
        />
      ) : messageItems.length === 0 ? (
        <Empty
          mascot={false}
          title={
            pendingOnly
              ? timeFilter === "all"
                ? "没有需要处理的消息"
                : `${activeTimeOption.label}没有需要处理的消息`
              : "没有符合条件的记录"
          }
          hint={
            pendingOnly && hiddenOlderCount > 0
              ? `已有 ${hiddenOlderCount} 条更早的历史记录被收纳，可切换为「全部未决」或前往「发送历史」查阅。`
              : undefined
          }
        />
      ) : (
        <Flex vertical gap={8} aria-label="消息列表">
          {messageItems.slice((currentPage - 1) * 8, currentPage * 8).map((message) => (
            <Button
              key={message.messageId}
              type="text"
              block
              onClick={() => props.onSelectMessage(message.messageId)}
              style={{
                height: "auto",
                minHeight: 72,
                padding: 12,
                whiteSpace: "normal",
                textAlign: "left",
                border: "1px solid var(--ant-color-border-secondary)",
              }}
            >
              <Flex vertical gap={6} style={{ width: "100%", minWidth: 0 }}>
                <Flex justify="space-between" wrap gap={8}>
                  <StatusBadge {...statusTone(message.state)} />
                  <Typography.Text type="secondary">
                    {channelLabel(message.channel)} · {formatRelative(message.updatedAt)}
                  </Typography.Text>
                </Flex>
                <span style={{ overflowWrap: "anywhere" }}>{messageSummary(message.content)}</span>
              </Flex>
            </Button>
          ))}
        </Flex>
      )}
      {messageItems.length > 8 && (
        <Pagination
          size="small"
          current={currentPage}
          pageSize={8}
          total={messageItems.length}
          onChange={setPage}
          showSizeChanger={false}
        />
      )}
      {messageItems.length > 0 && (
        <Typography.Text type="secondary">已载入最近 {messageItems.length} 条记录</Typography.Text>
      )}
      {!pendingOnly && (
        <AdvancedEvidence title="消息链路与覆盖">
          <Descriptions
            size="small"
            column={1}
            items={[
              {
                key: "bridge",
                label: "接管组件版本",
                children: props.messageBridge?.bridgeVersion ?? "未知",
              },
              {
                key: "policy",
                label: "消息规则版本",
                children: props.messageBridge?.policyVersion ?? "未知",
              },
              ...props.coverageEntries.map(([path, status]) => ({
                key: path,
                label: path,
                children: status,
              })),
            ]}
          />
        </AdvancedEvidence>
      )}
      <Drawer
        title="消息详情"
        open={selectedMessage !== null}
        onClose={() => props.onSelectMessage(null)}
        size={640}
        styles={{ wrapper: { maxWidth: "100vw" }, body: { overflowWrap: "anywhere" } }}
      >
        {selectedMessage !== null && (
          <MessageDetail {...props} message={selectedMessage} onDismiss={handleDismissOne} />
        )}
      </Drawer>
    </Flex>
  );
}
