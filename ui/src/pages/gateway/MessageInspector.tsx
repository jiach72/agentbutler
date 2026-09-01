/**
 * 消息明细面板：数据面通道/覆盖状态 + 消息列表 + 所选消息详情（含技术编号二级折叠）。
 */
import { AdvancedDetails } from "../../components/AdvancedDetails.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { ReloadOutlined } from "@ant-design/icons";
import { Button } from "antd";
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
  onReconnect: () => void;
}

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
  onReconnect,
}: MessageInspectorProps) {
  return (
    <>
      <section className="gateway-dataplane" aria-labelledby="gateway-dataplane-title">
        <div className="gateway-dataplane-head">
          <div>
            <span className="product-kicker">消息处理</span>
            <h2 id="gateway-dataplane-title">发送前会先经过这里</h2>
          </div>
          <div className="gateway-bridge-meta">
            <span title={messageBridge?.bridgeVersion ?? "接管组件既未就绪"}>
              接管组件{" "}
              {messageBridge?.bridgeVersion === null || messageBridge?.bridgeVersion === undefined
                ? "未就绪"
                : "已就绪"}
            </span>
            <span title={messageBridge?.policyVersion ?? "未启用规则"}>
              消息规则{" "}
              {messageBridge?.policyVersion === null || messageBridge?.policyVersion === undefined
                ? "未启用"
                : "已启用"}
            </span>
            <span>最近处理 {formatRelative(messageBridge?.lastCycleAt)}</span>
          </div>
        </div>

        <div className="gateway-channel-row" aria-label="消息通道状态">
          {Object.entries(messageBridge?.channels ?? {}).length === 0 ? (
            <span className="gateway-muted-copy">尚未收到通道状态</span>
          ) : (
            Object.entries(messageBridge?.channels ?? {}).map(([channel, status]) => {
              const badge = statusTone(status);
              const detail = messageBridge?.channelDetails?.[channel];
              return (
                <span className="gateway-channel" key={channel}>
                  <i className={status === "ok" ? "is-ok" : "is-warn"} />
                  {channelLabel(channel)}
                  <StatusBadge tone={badge.tone} label={badge.label} />
                  {detail?.unavailableReason && <small title={detail.unavailableFix ?? undefined}>{detail.unavailableReason}</small>}
                </span>
              );
            })
          )}
        </div>
        {messageBridge !== null && Object.values(messageBridge.channelDetails ?? {}).some((item) => item.status !== "ok") && (
          <div className="gateway-channel-actions">
            <Button icon={<ReloadOutlined />} onClick={onReconnect}>
              重新连接通道
            </Button>
            <span className="gateway-muted-copy">不可用原因已标注在对应通道旁</span>
          </div>
        )}

        <div className="gateway-coverage-grid" aria-label="运行路径覆盖">
          {coverageEntries.length === 0 ? (
            <div className="empty-state">消息接管后，这里会显示真实经过处理的消息路径。</div>
          ) : (
            coverageEntries.map(([path, status]) => (
              <div className={`gateway-coverage-item is-${status}`} key={path}>
                <i />
                <span>{COVERAGE_LABELS[path] ?? "其他路径"}</span>
                <small>{statusTone(status).label}</small>
              </div>
            ))
          )}
        </div>
      </section>

      <div className="gateway-section-heading gateway-message-heading">
        <div>
          <h2 className="section-title">最近发送的消息</h2>
          <p className="hint">
            选择一条消息，可以查看它是否按时送达、被合并或暂存过；不会显示演示数据。
          </p>
        </div>
        <div className="message-state-strip" aria-label="消息关键状态计数">
          {(["captured", "held_dnd", "ready", "delivered", "dead_letter"] as const).map((state) => (
            <span key={state}>
              {MESSAGE_STATE_LABELS[state]}
              <strong>{messageCounts[state] ?? 0}</strong>
            </span>
          ))}
        </div>
      </div>

      <div className="gateway-message-workspace">
        <section className="message-feed" aria-label="消息列表">
          <div className="message-feed-head">
            <span>最近 {messageItems.length} 条</span>
            <small>按时间从新到旧</small>
          </div>
          {messageItems.length === 0 ? (
            <div className="message-feed-empty">
              <strong>{messagesReachable ? "还没有消息记录" : "暂时读不到消息"}</strong>
              <span>真实消息经过管家后会出现在这里；不会生成演示数据。</span>
            </div>
          ) : (
            <div className="message-feed-list">
              {messageItems.map((msg) => {
                const badge = statusTone(msg.state);
                const isSelected = selectedMessage?.messageId === msg.messageId;
                return (
                  <button
                    type="button"
                    className={`message-feed-row${isSelected ? " is-selected" : ""}`}
                    aria-pressed={isSelected}
                    key={msg.messageId}
                    onClick={() => onSelectMessage(msg.messageId)}
                  >
                    <span className="message-feed-row-top">
                      <StatusBadge tone={badge.tone} label={badge.label} />
                      <time>{formatRelative(msg.updatedAt)}</time>
                    </span>
                    <strong>{msg.content || "（空消息内容）"}</strong>
                    <span className="message-feed-row-meta">{channelLabel(msg.channel)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <aside className="message-inspector" aria-label="所选消息详情">
          {selectedMessage === null ? (
            <div className="message-inspector-empty">
              <span>消息详情</span>
              <strong>选择一条消息查看完整轨迹</strong>
              <p>这里会显示发送状态、是否被合并、是否暂存以及最终结果。</p>
            </div>
          ) : (
            <>
              <div className="message-inspector-head">
                <div>
                  <span className="product-kicker">第 {selectedMessage.sequence} 条消息</span>
                  <h3>{MESSAGE_STATE_LABELS[selectedMessage.state] ?? "其他状态"}</h3>
                </div>
                <StatusBadge {...statusTone(selectedMessage.priority)} />
              </div>

              <div className="message-content-block">
                {selectedMessage.content || "（空消息内容）"}
              </div>

              {(selectedMessage.transformTrace.includes("task:awaiting-terminal") ||
                selectedMessage.metadata.summaryStatus !== undefined ||
                selectedMessage.metadata.summaryError !== undefined) && (
                <div className="message-summary-status" role="status" aria-live="polite">
                  <strong>
                    {selectedMessage.transformTrace.includes("task:awaiting-terminal")
                      ? "等待任务完成"
                      : selectedMessage.metadata.summaryStatus === "success"
                        ? "已生成任务总结"
                        : selectedMessage.metadata.summaryStatus === "fallback"
                          ? "已发送原始结果"
                          : "正在生成总结"}
                  </strong>
                  {typeof selectedMessage.metadata.summaryError === "string" && (
                    <span>总结未使用：{selectedMessage.metadata.summaryError}</span>
                  )}
                </div>
              )}

              <dl className="message-facts">
                <div>
                  <dt>会话 / 通道</dt>
                  <dd>
                    {shortId(selectedMessage.sessionId)} · {channelLabel(selectedMessage.channel)}
                  </dd>
                </div>
                <div>
                  <dt>发送方式</dt>
                  <dd>
                    {transportLabel(selectedMessage.transport)} ·{" "}
                    {messageKindLabel(selectedMessage.messageKind)}
                  </dd>
                </div>
                <div>
                  <dt>收到 / 送达</dt>
                  <dd>
                    {formatTimestamp(selectedMessage.capturedAt)} /{" "}
                    {formatTimestamp(selectedMessage.deliveredAt)}
                  </dd>
                </div>
                <div>
                  <dt>尝试次数</dt>
                  <dd>{selectedMessage.attemptCount}</dd>
                </div>
              </dl>

              <AdvancedDetails summary="技术编号">
                <div className="message-tech-body">
                  <dl className="message-facts message-tech-facts">
                    <div>
                      <dt>消息编号</dt>
                      <dd title={selectedMessage.messageId}>
                        {shortId(selectedMessage.messageId, 18)}
                      </dd>
                    </div>
                    <div>
                      <dt>任务编号</dt>
                      <dd title={selectedMessage.runId ?? undefined}>
                        {shortId(selectedMessage.runId, 18)}
                      </dd>
                    </div>
                    <div>
                      <dt>相关消息编号</dt>
                      <dd title={selectedMessage.inboundMessageId ?? undefined}>
                        {shortId(selectedMessage.inboundMessageId, 18)}
                      </dd>
                    </div>
                    <div>
                      <dt>平台消息编号</dt>
                      <dd title={selectedMessage.providerMessageId ?? undefined}>
                        {shortId(selectedMessage.providerMessageId ?? undefined, 18)}
                      </dd>
                    </div>
                  </dl>
                </div>
              </AdvancedDetails>

              {(selectedMessage.lastError !== null || selectedMessage.lastPolicyError !== null) && (
                <div className="message-error-block">
                  <strong>需要处理</strong>
                  <span>{selectedMessage.lastPolicyError ?? selectedMessage.lastError}</span>
                </div>
              )}

              <div className="message-inspector-section">
                <h4>消息处理步骤</h4>
                {selectedMessage.transformTrace.length === 0 ? (
                  <span className="gateway-muted-copy">没有记录处理步骤</span>
                ) : (
                  <ol className="message-trace">
                    {selectedMessage.transformTrace.map((step, index) => (
                      <li key={`${step}:${String(index)}`}>
                        <i />
                        <span title={step}>{transformTraceLabel(step)}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>

              <div className="message-inspector-section">
                <h4>相关任务进度</h4>
                {selectedMessage.runId === undefined || selectedMessage.runId === null ? (
                  <span className="gateway-muted-copy">
                    这条消息没有关联正在运行的 AI 任务
                  </span>
                ) : taskLoading ? (
                  <span className="gateway-muted-copy">正在读取任务事件…</span>
                ) : taskData === null || taskData.runId !== selectedMessage.runId ? (
                  <span className="gateway-muted-copy">没有找到相关任务进度</span>
                ) : (
                  <ol className="task-timeline">
                    {taskData.events.map((event) => (
                      <li key={`${event.runId}:${String(event.sequence)}`}>
                        <i />
                        <div>
                          <strong>{event.summary ?? taskEventLabel(event.kind)}</strong>
                          <span>{taskEventLabel(event.kind)} · 管家已记录</span>
                          <time>{formatTimestamp(event.occurredAt)}</time>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </>
          )}
        </aside>
      </div>
    </>
  );
}
