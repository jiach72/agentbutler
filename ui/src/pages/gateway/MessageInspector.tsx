import { useState } from "react";
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Flex,
  Pagination,
  Select,
  Timeline,
  Typography,
} from "antd";
import { AdvancedEvidence } from "../../components/AdvancedEvidence.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { Empty } from "../../components/Empty.js";
import { formatRelative } from "../../lib/format.js";
import { ACTIONABLE_MESSAGE_STATES, isActionableMessage, messageSummary } from "./attention.js";
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
  "taskData" | "taskLoading" | "onRedeliver" | "redeliverBusy" | "onExpedite" | "expediteBusy"
> & { message: MessageItemView };

export function MessageDetail({
  message,
  taskData,
  taskLoading,
  onRedeliver,
  redeliverBusy,
  onExpedite,
  expediteBusy,
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
        />
      )}
      {message.state === "dead_letter" && (
        <Alert
          type="warning"
          showIcon
          title="这条消息发送失败，已被搁置"
          description="先检查通道连接。确认重新投递后，消息会按当前规则再次发送给对方。"
          action={
            onRedeliver && (
              <Button danger loading={redeliverBusy} onClick={() => onRedeliver(message.messageId)}>
                重新投递
              </Button>
            )
          }
        />
      )}
      {message.state === "policy_error" && (
        <Alert
          type="warning"
          showIcon
          title="消息规则未能完成处理"
          description="检查通知规则和通道连接，修正后刷新发送结果。"
          action={<Button href="/gateway?tab=rules">检查通知规则</Button>}
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
  const messageItems = pendingOnly
    ? props.messageItems.filter(isActionableMessage)
    : props.messageItems;
  const [page, setPage] = useState(1);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(messageItems.length / 8)));
  const states = pendingOnly ? ACTIONABLE_MESSAGE_STATES : MESSAGE_CHIP_STATES;
  return (
    <Flex vertical gap={16}>
      <Flex wrap gap={12} justify="space-between" align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          {pendingOnly ? "需要处理的消息" : "消息记录"}
        </Typography.Title>
        {!pendingOnly && (
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
        <Empty mascot={false} title={pendingOnly ? "没有需要处理的消息" : "没有符合条件的记录"} />
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
        {selectedMessage !== null && <MessageDetail {...props} message={selectedMessage} />}
      </Drawer>
    </Flex>
  );
}
