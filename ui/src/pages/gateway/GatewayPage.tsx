/**
 * 消息通知工作台（编排层）：数据刷新（轮询 + 事件流）、降级横幅与子面板组装。
 *
 * - /api/messages/overview 提供 Bridge、SQLite Outbox、coverage 与真实消息投影；
 * - /api/messages/tasks/:runId 提供所选消息的任务生命周期；
 * - /api/gateway 保留限流画像、补丁登记状态与管家告警队列；
 * - 每 10 秒轮询一次（后台标签页自动暂停），事件流命中时节流补刷。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReloadOutlined } from "@ant-design/icons";
import { App, Badge, Button, Card, Flex, Spin, Typography } from "antd";
import { AdvancedDetails } from "../../components/AdvancedDetails.js";
import { DangerConfirmModal } from "../../components/DangerConfirmModal.js";
import { DegradedBanner } from "../../components/DegradedBanner.js";
import { PageHeader } from "../../components/PageHeader.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { useEventStream } from "../../hooks/useEventStream.js";
import { usePolling } from "../../hooks/usePolling.js";
import { fetchJson, postJson } from "../../lib/api.js";
import { validateGatewayPatches, validatePatchParamAgainstSchema } from "../../lib/patchRules.js";
import { AlertQueuePanel } from "./AlertQueuePanel.js";
import { ChannelGrid } from "./ChannelGrid.js";
import { ConnectionHealth } from "./ConnectionHealth.js";
import { DeliveryTrendCard } from "./DeliveryTrendCard.js";
import { MessageInspector } from "./MessageInspector.js";
import { PatchBoard } from "./PatchBoard.js";
import { PromptOptimizationPanel } from "./PromptOptimizationPanel.js";
import { RateLimitsTable } from "./RateLimitsTable.js";
import { RelayControlCard } from "./RelayControlCard.js";
import {
  COVERAGE_LABELS,
  PARAM_LABELS,
  REFRESH_INTERVAL_MS,
  effectivePatchParams,
  instanceKeyOf,
  patchActionError,
  patchBusyKey,
  seedDrafts,
  statusTone,
} from "./helpers.js";
import type {
  DriftReport,
  GatewayPatch,
  GatewayPayload,
  MessageOverviewPayload,
  MessageTaskView,
  PatchDrafts,
  PendingPatchAction,
  ConfigChangeSetView,
} from "./helpers.js";

const EVENT_PREFIXES = ["message-", "patch-", "gateway-", "delivery-", "alert-", "dnd-"];

function paramLabel(key: string): string {
  return PARAM_LABELS[key] ?? key;
}

export function GatewayPage() {
  const { message } = App.useApp();
  const [data, setData] = useState<GatewayPayload | null>(null);
  const [messageData, setMessageData] = useState<MessageOverviewPayload | null>(null);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [taskData, setTaskData] = useState<MessageTaskView | null>(null);
  const [taskLoading, setTaskLoading] = useState(false);
  const [drafts, setDrafts] = useState<PatchDrafts>({});
  const [driftReports, setDriftReports] = useState<Record<string, DriftReport>>({});
  const [selectedInstance, setSelectedInstance] = useState("");
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set());
  const [pendingPatchAction, setPendingPatchAction] = useState<PendingPatchAction | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [promptFlash, setPromptFlash] = useState(false);
  const promptFlashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flashPromptSection = () => {
    setPromptFlash(true);
    if (promptFlashTimer.current !== undefined) clearTimeout(promptFlashTimer.current);
    promptFlashTimer.current = setTimeout(() => setPromptFlash(false), 2200);
  };

  useEffect(
    () => () => {
      if (promptFlashTimer.current !== undefined) clearTimeout(promptFlashTimer.current);
    },
    [],
  );

  const acquireBusy = useCallback((key: string) => {
    setBusyKeys((prev) => new Set(prev).add(key));
  }, []);

  const releaseBusy = useCallback((key: string) => {
    setBusyKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [payload, messages] = await Promise.all([
      fetchJson<GatewayPayload>("/api/gateway"),
      fetchJson<MessageOverviewPayload>("/api/messages/overview?limit=60"),
    ]);
    if (payload !== null) {
      setData(payload);
      setDrafts((current) => seedDrafts(current, payload.patches ?? []));
    }
    if (messages !== null) {
      setMessageData(messages);
      setSelectedMessageId((current) => {
        if (current !== null && messages.messages.items.some((item) => item.messageId === current)) {
          return current;
        }
        return messages.messages.items[0]?.messageId ?? null;
      });
    }
    if (payload !== null || messages !== null) setLastUpdated(new Date());
    setLoadError(payload === null || messages === null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  usePolling(() => void refresh(), REFRESH_INTERVAL_MS);
  useEventStream({ prefixes: EVENT_PREFIXES, onSignal: () => void refresh() });

  const patches = data?.patches ?? [];
  const rateLimit = data?.rateLimit ?? null;
  const alerts = data?.alerts ?? null;
  const messageItems = messageData?.messages.items ?? [];
  const messageCounts = messageData?.messages.counts ?? messageData?.status?.counts ?? {};
  const messageBridge = messageData?.status?.bridge ?? null;
  const messagesReachable = messageData === null || messageData.reachable;
  const selectedMessage =
    messageItems.find((item) => item.messageId === selectedMessageId) ?? messageItems[0] ?? null;

  useEffect(() => {
    const runId = selectedMessage?.runId;
    if (runId === undefined || runId === null || runId === "") {
      setTaskData(null);
      setTaskLoading(false);
      return;
    }
    let active = true;
    setTaskData(null);
    setTaskLoading(true);
    void fetchJson<MessageTaskView>(`/api/messages/tasks/${encodeURIComponent(runId)}`).then(
      (task) => {
        if (!active) return;
        setTaskData(task);
        setTaskLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [selectedMessage?.runId]);

  /** 全部补丁的解析后参数：草稿为空时回退已生效值，再回退默认值。 */
  const resolvedByPatch = useMemo(() => {
    const map: Record<string, Record<string, number>> = {};
    for (const patch of patches) {
      const entry: Record<string, number> = {};
      const effective = effectivePatchParams(patch);
      for (const [name, schema] of Object.entries(patch.params)) {
        const draft = drafts[patch.id]?.[name];
        entry[name] = draft ?? effective?.[name] ?? schema.default;
      }
      map[patch.id] = entry;
    }
    return map;
  }, [patches, drafts]);

  /** 跨补丁不变式结果（含「静默后首条延迟不能超过发送间隔」），UI 只消费展示。 */
  const patchErrors = useMemo(
    () =>
      validateGatewayPatches(
        Object.entries(resolvedByPatch).map(([id, params]) => ({ id, params })),
        paramLabel,
      ),
    [resolvedByPatch],
  );

  const updateDraft = (patchId: string, param: string, value: number | null) => {
    setDrafts((current) => ({
      ...current,
      [patchId]: { ...current[patchId], [param]: value },
    }));
  };

  const useSuggestion = (suggestion: { patchId: string; param: string; suggested: number }) => {
    updateDraft(suggestion.patchId, suggestion.param, suggestion.suggested);
    message.success(`${paramLabel(suggestion.param)}已写入草稿；确认后再应用，不会自动修改源码`);
  };

  const runPatchAction = async (patch: GatewayPatch, action: "apply" | "reapply" | "detect") => {
    const instKey = instanceKeyOf(selectedInstance);
    const key = patchBusyKey(action, patch.id, instKey);
    if (busyKeys.has(key)) return;

    if (action === "detect") {
      acquireBusy(key);
      const body = selectedInstance.trim() === "" ? {} : { instanceId: selectedInstance.trim() };
      try {
        const result = await postJson(
          `/api/gateway/patches/${encodeURIComponent(patch.id)}/detect`,
          body,
          10_000,
        );
        if (result.status === 200 && result.data !== null && typeof result.data === "object") {
          const report = (result.data as Record<string, unknown>)["report"];
          if (report !== null && typeof report === "object") {
            setDriftReports((current) => ({ ...current, [patch.id]: report as DriftReport }));
            message.success(`漂移检测完成：${(report as DriftReport).status}`);
          } else {
            message.error("漂移检测响应缺少 report");
          }
        } else {
          message.error(patchActionError(result.status, result.data));
        }
      } finally {
        releaseBusy(key);
      }
      return;
    }

    const resolved = resolvedByPatch[patch.id];
    for (const [name, schema] of Object.entries(patch.params)) {
      const error = validatePatchParamAgainstSchema(name, resolved[name], schema, paramLabel);
      if (error !== null) {
        message.error(error);
        return;
      }
    }
    const crossError = patchErrors[patch.id];
    if (crossError !== undefined) {
      message.error(crossError);
      return;
    }
    const previewBody = selectedInstance.trim() === "" ? { params: resolved } : { params: resolved, instanceId: selectedInstance.trim() };
    const previewResult = await postJson(`/api/gateway/patches/${encodeURIComponent(patch.id)}/preview`, previewBody, 10_000);
    const preview = previewResult.status === 200 && previewResult.data !== null && typeof previewResult.data === "object"
      ? (previewResult.data as { preview?: ConfigChangeSetView }).preview
      : undefined;
    if (preview === undefined) {
      message.error("无法生成配置变更预览，已阻止写入");
      return;
    }
    setPendingPatchAction({
      patch,
      action,
      params: resolved,
      busyKey: key,
      preview,
      ...(selectedInstance.trim() === "" ? {} : { instanceId: selectedInstance.trim() }),
    });
  };

  const executePendingPatchAction = async (pending: PendingPatchAction): Promise<void> => {
    const verb = pending.action === "apply" ? "应用" : "重打";
    acquireBusy(pending.busyKey);
    try {
      const body: { params: Record<string, number>; instanceId?: string } = { params: pending.params };
      if (pending.instanceId !== undefined) body.instanceId = pending.instanceId;
      const result = await postJson(
        `/api/gateway/patches/${encodeURIComponent(pending.patch.id)}/${pending.action}`,
        body,
        10_000,
      );
      if (result.status === 200) {
        const outcome =
          result.data !== null && typeof result.data === "object"
            ? String((result.data as Record<string, unknown>)["result"] ?? "ok")
            : "ok";
        message.success(`${pending.patch.title} ${verb}成功（${outcome}）`);
        await refresh();
      } else {
        message.error(patchActionError(result.status, result.data));
      }
    } finally {
      releaseBusy(pending.busyKey);
      setPendingPatchAction(null);
    }
  };

  if (data === null && messageData === null && loading) {
    return (
      <section className="gateway-page">
        <Flex vertical gap={24}>
          <PageHeader eyebrow="消息通知" title="消息通知" />
          <Card>
            <Flex vertical align="center" gap={12} style={{ padding: "40px 0" }}>
              <Spin />
              <Typography.Text type="secondary">正在读取消息状态、发送记录和通知规则…</Typography.Text>
            </Flex>
          </Card>
        </Flex>
      </section>
    );
  }

  const overallBadge = statusTone(rateLimit?.overall ?? "unknown");
  const channelBadge =
    alerts === null
      ? { tone: "muted" as const, label: "未知" }
      : !alerts.reachable
        ? { tone: "error" as const, label: "离线" }
        : { tone: "ok" as const, label: "就绪" };
  const pendingAlerts = alerts?.counts["pending"] ?? 0;
  const failedAlerts = alerts?.counts["failed"] ?? 0;
  const coverageEntries = Object.entries(messageBridge?.coverage ?? {}).filter(
    ([path]) => COVERAGE_LABELS[path] !== undefined,
  );
  const bridgeReady =
    messageBridge?.connected === true && messageBridge.attached && messageBridge.outboxWritable;
  const reconnectMessages = async () => {
    try {
      await postJson("/api/messages/reconnect", {}, 10_000);
      message.success("已请求重新连接，稍后刷新查看结果");
      await refresh();
    } catch {
      message.error("重新连接请求未送达，请稍后重试");
    }
  };

  return (
    <section className="gateway-page">
      <Flex vertical gap={24}>
        <PageHeader
          eyebrow="消息通知"
          title="消息通知"
          description="记录消息发送结果，合并重复内容，并按免打扰规则调度；所有通知保留可追溯记录。"
          extra={
            <Flex wrap="wrap" justify="flex-end" align="center" gap={8}>
              <Badge status={loading ? "processing" : "success"} text={loading ? "正在同步" : "10 秒实时刷新"} />
              <Typography.Text type="secondary">
                更新于 {lastUpdated?.toLocaleTimeString("zh-CN", { hour12: false }) ?? "—"}
              </Typography.Text>
              <Button
                type="primary"
                icon={<ReloadOutlined />}
                disabled={loading}
                onClick={() => void refresh()}
              >
                {loading ? "刷新中" : "刷新"}
              </Button>
              <Button href="#prompt-optimization" onClick={flashPromptSection}>
                查看消息优化
              </Button>
            </Flex>
          }
        />

        {loadError && (
          <DegradedBanner severity="warn" message="部分服务暂时连不上，当前显示上一次成功数据" />
        )}
        {messageData !== null && !messageData.reachable && (
          <DegradedBanner
            severity="critical"
            message="暂时读不到消息记录"
            description="服务恢复后将自动重试，已排队消息会继续保留。"
          />
        )}
        {(messageData?.degraded.length ?? 0) > 0 && messageData?.reachable === true && (
          <DegradedBanner severity="warn" message="部分消息记录暂时不完整，服务恢复后将自动补齐" />
        )}
        {messageBridge !== null && !bridgeReady && (
          <DegradedBanner
            severity="critical"
            message="消息接管还没准备好：请确认本机 AI 正在运行，稍后刷新重试。"
          />
        )}
        {data?.watchReachable === false && (
          <DegradedBanner
            severity="warn"
            message="管家服务暂时连不上：消息频率和通知设置需要等服务恢复后查看。"
          />
        )}
        {alerts !== null && !alerts.reachable && (
          <DegradedBanner
            severity="warn"
            message="通知服务暂时离线：正在排队中的提醒暂不可见，稍后会自动恢复。"
          />
        )}

        {messageData?.status?.relay !== undefined && messageData.status.relay !== null && (
          <RelayControlCard
            relay={messageData.status.relay}
            onChanged={() => void refresh()}
          />
        )}

        <ChannelGrid refreshedAt={lastUpdated} onReconnect={() => void reconnectMessages()} />

        <ConnectionHealth
          messageBridge={messageBridge}
          bridgeReady={bridgeReady}
          messageCounts={messageCounts}
        />

        <DeliveryTrendCard />

        <AdvancedDetails
          summary={
            <>
              <strong>消息明细</strong>
              <small>发送前处理、通道状态和每一条消息的详细记录</small>
            </>
          }
        >
          <Flex vertical gap={16}>
            <MessageInspector
              messageBridge={messageBridge}
              coverageEntries={coverageEntries}
              messageCounts={messageCounts}
              messageItems={messageItems}
              messagesReachable={messagesReachable}
              selectedMessage={selectedMessage}
              onSelectMessage={setSelectedMessageId}
              taskData={taskData}
              taskLoading={taskLoading}
            />
          </Flex>
        </AdvancedDetails>

        <AdvancedDetails
          summary={
            <>
              <strong>高级设置</strong>
              <small>频率规则、消息参数和通知队列；普通用户通常不需要动</small>
            </>
          }
        >
          <Flex vertical gap={16}>
            <Flex wrap="wrap" gap={16} align="center" aria-label="观察面状态">
              <Typography.Text type="secondary">
                发送频率 <StatusBadge {...overallBadge} />
              </Typography.Text>
              <Typography.Text type="secondary">近 24 小时 {rateLimit?.last24h ?? "—"} 次</Typography.Text>
              <Typography.Text type="secondary">
                备用告警 <StatusBadge {...channelBadge} />
              </Typography.Text>
              <Typography.Text type="secondary">
                {pendingAlerts} 待投递 · {failedAlerts} 失败
              </Typography.Text>
            </Flex>

            <RateLimitsTable rateLimit={rateLimit} onUseSuggestion={useSuggestion} />

            <PatchBoard
              patches={patches}
              drafts={drafts}
              driftReports={driftReports}
              watchUnreachable={data?.watchReachable === false}
              instanceValue={selectedInstance}
              patchErrors={patchErrors}
              busyKeys={busyKeys}
              onInstanceChange={setSelectedInstance}
              onUpdateDraft={updateDraft}
              onRunAction={(patch, action) => void runPatchAction(patch, action)}
            />

            <AlertQueuePanel alerts={alerts} />
          </Flex>
        </AdvancedDetails>

        <div
          id="prompt-optimization"
          style={{
            borderRadius: 12,
            outline: promptFlash ? "2px solid var(--ant-color-primary)" : "2px solid transparent",
            outlineOffset: 8,
            transition: "outline-color 0.4s ease",
          }}
        >
          <PromptOptimizationPanel />
        </div>
        {pendingPatchAction !== null && (
          <DangerConfirmModal
            open
            title={pendingPatchAction.action === "apply" ? "确认应用消息调整" : "确认恢复官方默认"}
            busy={busyKeys.has(pendingPatchAction.busyKey)}
            confirmLabel={pendingPatchAction.action === "apply" ? "确认应用" : "确认恢复"}
            onCancel={() => setPendingPatchAction(null)}
            onConfirm={() => executePendingPatchAction(pendingPatchAction)}
            steps={[
              "再次校验配置不变式和补丁锚点",
              "首次应用前保留官方原文备份",
              "写入已登记的 Hermes 源文件并记录审计",
            ]}
          >
            <Typography.Paragraph>
              将对「{pendingPatchAction.patch.title}」执行
              {pendingPatchAction.action === "apply" ? "应用" : "恢复官方默认"}，目标文件为
              <Typography.Text code>{pendingPatchAction.patch.target}</Typography.Text>。
            </Typography.Paragraph>
            <Typography.Paragraph type="danger">
              这是实际的源码写入操作。漂移、手工实现或配置不变式不满足时，服务端会拒绝执行；本次确认前不会修改任何文件。
            </Typography.Paragraph>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              参数：
              {Object.entries(pendingPatchAction.params)
                .map(([name, value]) => paramLabel(name) + "=" + String(value))
                .join(" · ")}
              {pendingPatchAction.instanceId === undefined
                ? "；实例：自动选择"
                : "；实例：" + pendingPatchAction.instanceId}
            </Typography.Paragraph>
            {pendingPatchAction.preview !== undefined && (
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                <Typography.Text strong>将要修改：</Typography.Text>
                {pendingPatchAction.preview.changes.length === 0
                  ? "参数没有变化"
                  : pendingPatchAction.preview.changes.map((change) => `${change.path}：${String(change.before)} → ${String(change.after)}`).join("；")}
              </Typography.Paragraph>
            )}
          </DangerConfirmModal>
        )}
      </Flex>
    </section>
  );
}
