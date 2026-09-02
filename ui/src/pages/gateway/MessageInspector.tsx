/**
 * 消息明细面板：数据面覆盖状态 + 消息列表 + 所选消息详情（含技术编号二级折叠）。
 * 通道卡片与「重新连接通道」入口已迁移至 ChannelGrid。
 */
import { AdvancedDetails } from "../../components/AdvancedDetails.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { Alert, Button, Card, Col, Descriptions, Empty, Flex, Row, Timeline, Typography } from "antd";
import { formatRelative } from "../../lib/format.js";
import {
  COVERAGE_LABELS,
  MESSAGE_STATE_LABELS,
  channelLabel,
  formatTimestamp,
  messageKindLabel,
  shortId,
  statusTone,
  taskEventLabel,
  transformTraceLabel,
  transportLabel,
} from "./helpers.js";
import type {
  MessageBridgeView,
  MessageItemView,
  MessageTaskView,
} from "./helpers.js";

interface MessageInspectorProps {
  messageBridge: MessageBridgeView | null;
  coverageEntries: Array<[string, string]>;
  messageCounts: Record<string, number>;
  messageItems: MessageItemView[];
  messagesReachable: boolean;
  selectedMessage: MessageItemView | null;
  onSelectMessage: (messageId: string) => void;
  taskData: MessageTaskView | null;
  taskLoading: boolean;
}

/** 列表与详情两栏的固定高度：超出部分卡片内部滚动，避免长列表把页面拉长。 */
const MESSAGE_LIST_HEIGHT = 560;

/** tone → 圆点颜色（全部走 antd CSS 变量，不硬编码色值）。 */
const TONE_DOT_COLOR: Record<string, string> = {
  ok: "var(--ant-color-success)",
  warn: "var(--ant-color-warning)",
  error: "var(--ant-color-error)",
  muted: "var(--ant-color-text-quaternary)",
};

const chipStyle = {
  border: "1px solid var(--ant-color-border-secondary)",
  borderRadius: 8,
  padding: "4px 10px",
} as const;

export function MessageInspector({
  messageBridge,
  coverageEntries,
  messageCounts,
  messageItems,
  messagesReachable,
  selectedMessage,
  onSelectMessage,
  taskData,
  taskLoading,
}: MessageInspectorProps) {
  return (
    <>
      <Card
        title={
          <Flex vertical gap={2}>
            <Typography.Text
              type="secondary"
              style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}
            >
              消息处理
            </Typography.Text>
            <Typography.Title level={4} component="h2" style={{ marginBottom: 0 }}>
              发送前会先经过这里
            </Typography.Title>
          </Flex>
        }
        extra={
          <Flex wrap="wrap" justify="flex-end" gap={12}>
            <Typography.Text type="secondary" title={messageBridge?.bridgeVersion ?? "接管组件既未就绪"}>
              接管组件{" "}
              {messageBridge?.bridgeVersion === null || messageBridge?.bridgeVersion === undefined
                ? "未就绪"
                : "已就绪"}
            </Typography.Text>
            <Typography.Text type="secondary" title={messageBridge?.policyVersion ?? "未启用规则"}>
              消息规则{" "}
              {messageBridge?.policyVersion === null || messageBridge?.policyVersion === undefined
                ? "未启用"
                : "已启用"}
            </Typography.Text>
            <Typography.Text type="secondary">
              最近处理 {formatRelative(messageBridge?.lastCycleAt)}
            </Typography.Text>
          </Flex>
        }
      >
        <Flex vertical gap={16}>
          <Flex wrap="wrap" gap={8} aria-label="运行路径覆盖">
            {coverageEntries.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="消息接管后，这里会显示真实经过处理的消息路径。"
              />
            ) : (
              coverageEntries.map(([path, status]) => {
                const badge = statusTone(status);
                return (
                  <Flex key={path} align="center" gap={6} style={chipStyle}>
                    <span
                      aria-hidden
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        display: "inline-block",
                        background: TONE_DOT_COLOR[badge.tone] ?? TONE_DOT_COLOR.muted,
                      }}
                    />
                    <Typography.Text style={{ fontSize: 13 }}>
                      {COVERAGE_LABELS[path] ?? "其他路径"}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {badge.label}
                    </Typography.Text>
                  </Flex>
                );
              })
            )}
          </Flex>
        </Flex>
      </Card>

      <Flex wrap="wrap" justify="space-between" align="flex-end" gap={16}>
        <div>
          <Typography.Title level={4} component="h2" style={{ marginBottom: 4 }}>
            最近发送的消息
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            选择一条消息，可以查看它是否按时送达、被合并或暂存过；不会显示演示数据。
          </Typography.Paragraph>
        </div>
        <Flex wrap="wrap" gap={16} aria-label="消息关键状态计数">
          {(["captured", "held_dnd", "ready", "delivered", "dead_letter"] as const).map((state) => (
            <Typography.Text key={state} type="secondary" style={{ fontSize: 13 }}>
              {MESSAGE_STATE_LABELS[state]}
              <Typography.Text strong>{" "}{messageCounts[state] ?? 0}</Typography.Text>
            </Typography.Text>
          ))}
        </Flex>
      </Flex>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={10}>
          <Card
            size="small"
            aria-label="消息列表"
            title={<Typography.Text>最近 {messageItems.length} 条</Typography.Text>}
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                按时间从新到旧
              </Typography.Text>
            }
            style={{ height: MESSAGE_LIST_HEIGHT, display: "flex", flexDirection: "column" }}
            styles={{ body: { flex: 1, minHeight: 0, overflowY: "auto" } }}
          >
            {messageItems.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <Flex vertical gap={4}>
                    <Typography.Text strong>
                      {messagesReachable ? "还没有消息记录" : "暂时读不到消息"}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      真实消息经过管家后会出现在这里；不会生成演示数据。
                    </Typography.Text>
                  </Flex>
                }
              />
            ) : (
              <Flex vertical gap={8}>
                {messageItems.map((msg) => {
                  const badge = statusTone(msg.state);
                  const isSelected = selectedMessage?.messageId === msg.messageId;
                  return (
                    <Button
                      type="text"
                      block
                      key={msg.messageId}
                      aria-pressed={isSelected}
                      onClick={() => onSelectMessage(msg.messageId)}
                      style={{
                        height: "auto",
                        minHeight: 0,
                        padding: "8px 12px",
                        textAlign: "left",
                        whiteSpace: "normal",
                        border: "1px solid",
                        borderColor: isSelected ? "var(--ant-color-primary-border)" : "transparent",
                        ...(isSelected ? { background: "var(--ant-color-primary-bg)" } : {}),
                      }}
                    >
                      <Flex vertical gap={4} style={{ width: "100%" }}>
                        <Flex justify="space-between" align="center" gap={8}>
                          <StatusBadge tone={badge.tone} label={badge.label} />
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {formatRelative(msg.updatedAt)}
                          </Typography.Text>
                        </Flex>
                        <Typography.Text strong ellipsis style={{ width: "100%" }}>
                          {msg.content || "（空消息内容）"}
                        </Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {channelLabel(msg.channel)}
                        </Typography.Text>
                      </Flex>
                    </Button>
                  );
                })}
              </Flex>
            )}
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card
            size="small"
            aria-label="所选消息详情"
            style={{ height: MESSAGE_LIST_HEIGHT, display: "flex", flexDirection: "column" }}
            styles={{ body: { flex: 1, minHeight: 0, overflowY: "auto" } }}
          >
            {selectedMessage === null ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <Flex vertical gap={4}>
                    <Typography.Text>消息详情</Typography.Text>
                    <Typography.Text strong>选择一条消息查看完整轨迹</Typography.Text>
                    <Typography.Text type="secondary">
                      这里会显示发送状态、是否被合并、是否暂存以及最终结果。
                    </Typography.Text>
                  </Flex>
                }
              />
            ) : (
              <Flex vertical gap={16}>
                <Flex wrap="wrap" justify="space-between" align="flex-start" gap={12}>
                  <Flex vertical gap={2}>
                    <Typography.Text
                      type="secondary"
                      style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}
                    >
                      第 {selectedMessage.sequence} 条消息
                    </Typography.Text>
                    <Typography.Title level={5} component="h3" style={{ marginBottom: 0 }}>
                      {MESSAGE_STATE_LABELS[selectedMessage.state] ?? "其他状态"}
                    </Typography.Title>
                  </Flex>
                  <StatusBadge {...statusTone(selectedMessage.priority)} />
                </Flex>

                <Typography.Paragraph
                  style={{
                    background: "var(--ant-color-fill-tertiary)",
                    padding: 12,
                    borderRadius: 8,
                    marginBottom: 0,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {selectedMessage.content || "（空消息内容）"}
                </Typography.Paragraph>

                {(selectedMessage.transformTrace.includes("task:awaiting-terminal") ||
                  selectedMessage.metadata.summaryStatus !== undefined ||
                  selectedMessage.metadata.summaryError !== undefined) && (
                  <div
                    role="status"
                    aria-live="polite"
                    style={{
                      background: "var(--ant-color-info-bg)",
                      border: "1px solid var(--ant-color-info-border)",
                      borderRadius: 8,
                      padding: "8px 12px",
                    }}
                  >
                    <Typography.Text strong>
                      {selectedMessage.transformTrace.includes("task:awaiting-terminal")
                        ? "等待任务完成"
                        : selectedMessage.metadata.summaryStatus === "success"
                          ? "已生成任务总结"
                          : selectedMessage.metadata.summaryStatus === "fallback"
                            ? "已发送原始结果"
                            : "正在生成总结"}
                    </Typography.Text>
                    {typeof selectedMessage.metadata.summaryError === "string" && (
                      <Typography.Text type="secondary" style={{ display: "block", fontSize: 12 }}>
                        总结未使用：{selectedMessage.metadata.summaryError}
                      </Typography.Text>
                    )}
                  </div>
                )}

                <Descriptions size="small" column={1}>
                  <Descriptions.Item label="会话 / 通道">
                    {shortId(selectedMessage.sessionId)} · {channelLabel(selectedMessage.channel)}
                  </Descriptions.Item>
                  <Descriptions.Item label="发送方式">
                    {transportLabel(selectedMessage.transport)} ·{" "}
                    {messageKindLabel(selectedMessage.messageKind)}
                  </Descriptions.Item>
                  <Descriptions.Item label="收到 / 送达">
                    {formatTimestamp(selectedMessage.capturedAt)} /{" "}
                    {formatTimestamp(selectedMessage.deliveredAt)}
                  </Descriptions.Item>
                  <Descriptions.Item label="尝试次数">{selectedMessage.attemptCount}</Descriptions.Item>
                </Descriptions>

                <AdvancedDetails summary="技术编号">
                  <Descriptions size="small" column={1}>
                    <Descriptions.Item label="消息编号">
                      <Typography.Text title={selectedMessage.messageId}>
                        {shortId(selectedMessage.messageId, 18)}
                      </Typography.Text>
                    </Descriptions.Item>
                    <Descriptions.Item label="任务编号">
                      <Typography.Text title={selectedMessage.runId ?? undefined}>
                        {shortId(selectedMessage.runId, 18)}
                      </Typography.Text>
                    </Descriptions.Item>
                    <Descriptions.Item label="相关消息编号">
                      <Typography.Text title={selectedMessage.inboundMessageId ?? undefined}>
                        {shortId(selectedMessage.inboundMessageId, 18)}
                      </Typography.Text>
                    </Descriptions.Item>
                    <Descriptions.Item label="平台消息编号">
                      <Typography.Text title={selectedMessage.providerMessageId ?? undefined}>
                        {shortId(selectedMessage.providerMessageId ?? undefined, 18)}
                      </Typography.Text>
                    </Descriptions.Item>
                  </Descriptions>
                </AdvancedDetails>

                {(selectedMessage.lastError !== null || selectedMessage.lastPolicyError !== null) && (
                  <Alert
                    type="error"
                    showIcon
                    title="需要处理"
                    description={selectedMessage.lastPolicyError ?? selectedMessage.lastError}
                  />
                )}

                <Flex vertical gap={8}>
                  <Typography.Title level={5} component="h4" style={{ marginBottom: 0 }}>
                    消息处理步骤
                  </Typography.Title>
                  {selectedMessage.transformTrace.length === 0 ? (
                    <Typography.Text type="secondary">没有记录处理步骤</Typography.Text>
                  ) : (
                    <Timeline
                      items={selectedMessage.transformTrace.map((step, index) => ({
                        children: (
                          <Typography.Text title={step} style={{ fontSize: 13 }}>
                            {transformTraceLabel(step)}
                          </Typography.Text>
                        ),
                        key: `${step}:${String(index)}`,
                      }))}
                    />
                  )}
                </Flex>

                <Flex vertical gap={8}>
                  <Typography.Title level={5} component="h4" style={{ marginBottom: 0 }}>
                    相关任务进度
                  </Typography.Title>
                  {selectedMessage.runId === undefined || selectedMessage.runId === null ? (
                    <Typography.Text type="secondary">
                      这条消息没有关联正在运行的 AI 任务
                    </Typography.Text>
                  ) : taskLoading ? (
                    <Typography.Text type="secondary">正在读取任务事件…</Typography.Text>
                  ) : taskData === null || taskData.runId !== selectedMessage.runId ? (
                    <Typography.Text type="secondary">没有找到相关任务进度</Typography.Text>
                  ) : (
                    <Timeline
                      items={taskData.events.map((event) => ({
                        children: (
                          <Flex vertical gap={2}>
                            <Typography.Text strong>
                              {event.summary ?? taskEventLabel(event.kind)}
                            </Typography.Text>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {taskEventLabel(event.kind)} · 管家已记录
                            </Typography.Text>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {formatTimestamp(event.occurredAt)}
                            </Typography.Text>
                          </Flex>
                        ),
                        key: `${event.runId}:${String(event.sequence)}`,
                      }))}
                    />
                  )}
                </Flex>
              </Flex>
            )}
          </Card>
        </Col>
      </Row>
    </>
  );
}
