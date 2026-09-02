import { CheckCircleOutlined, ExclamationCircleOutlined, ReloadOutlined, SyncOutlined } from "@ant-design/icons";
import { Badge, Button, Card, Col, Flex, Progress, Row, Tabs, Typography } from "antd";
import { useMemo, type ReactNode } from "react";
import { Sparkline } from "../../components/charts/Sparkline.js";
import { formatBytes, formatDecimal } from "../../lib/format.js";
import type {
  AgentProcessSample,
  ConnectionsPayload,
  DiscoveredLlmConfigView,
  HealthPayload,
  HostMetricsPayload,
  InspectionHistoryPayload,
  InspectionView,
  InspectStatusView,
  LlmStatusView,
} from "./types.js";
import { buildLocalReadiness, type ReadinessTone } from "./readiness.js";
import {
  formatDuration,
  formatUptime,
  instanceLabel,
  instanceShortName,
  recentInspectionDurationMs,
  usedPercentOf,
} from "./helpers.js";

const { Text, Title } = Typography;

interface ReadinessSectionProps {
  connections: ConnectionsPayload | null;
  llmStatus: LlmStatusView | null;
  discoveredModels: DiscoveredLlmConfigView[] | null;
  refreshing: boolean;
  onRefresh: () => void;
  /** watch 主机指标快照（不可达为 null → 卡内次要提示）。 */
  hostMetrics?: HostMetricsPayload | null;
  /** /api/health 各服务健康检查延迟。 */
  serviceHealth?: HealthPayload | null;
  /** 巡检状态（最近耗时优先取 criticalProbe.lastDurationMs）。 */
  inspectStatus?: InspectStatusView | null;
  /** 巡检按日历史（14 天耗时走势）。 */
  inspectionHistory?: InspectionHistoryPayload | null;
  /** 最近巡检列表（探针耗时缺省时回退计算均值）。 */
  latestInspections?: InspectionView[];
}

const toneBadgeStatus = {
  ok: "success",
  warn: "warning",
  error: "error",
  idle: "default",
} as const;

function ReadinessIcon({ tone }: { tone: ReadinessTone }) {
  const color =
    tone === "ok"
      ? "var(--ant-color-success)"
      : tone === "warn"
        ? "var(--ant-color-warning)"
        : tone === "error"
          ? "var(--ant-color-error)"
          : "var(--ant-color-text-quaternary)";
  if (tone === "ok") return <CheckCircleOutlined aria-hidden="true" style={{ color }} />;
  if (tone === "idle") return <SyncOutlined spin aria-hidden="true" style={{ color }} />;
  return <ExclamationCircleOutlined aria-hidden="true" style={{ color }} />;
}

/** 信息卡头部：标题 + 可选右侧元素（与既有三卡样式一致）。 */
function InfoCardHeader({ title }: { title: string }) {
  return (
    <Text strong style={{ flex: 1, minWidth: 0 }}>
      {title}
    </Text>
  );
}

/** 左标签右值的单行指标。 */
function MetricRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Flex justify="space-between" align="center" gap={8}>
      <Text type="secondary" style={{ minWidth: 0 }}>
        {label}
      </Text>
      {children}
    </Flex>
  );
}

/** 带进度条的占用行：percent 不可用时只显示占位文案，不渲染误导性的 0%。 */
function MeterRow({ label, percent, detail }: { label: string; percent: number | null; detail: string }) {
  return (
    <Flex vertical gap={2}>
      <MetricRow label={label}>
        <Text>{detail}</Text>
      </MetricRow>
      {percent === null ? (
        <Text type="secondary" style={{ fontSize: 12 }}>
          暂无法读取
        </Text>
      ) : (
        <Progress percent={percent} size="small" showInfo={false} aria-label={`${label}占用`} />
      )}
    </Flex>
  );
}

/** 单个 agent 进程占用行：CPU% 与 RSS（采样失败显示占位符而非 0）。 */
function AgentProcessRow({ agent }: { agent: AgentProcessSample }) {
  return (
    <MetricRow label={`${instanceLabel(agent.instanceId)} 进程`}>
      <Text>
        CPU {agent.cpuPercent === null ? "—" : `${formatDecimal(agent.cpuPercent)}%`}
        <Text type="secondary"> · </Text>
        RSS {agent.rssBytes === null ? "—" : formatBytes(agent.rssBytes)}
      </Text>
    </MetricRow>
  );
}

/** 「Agent 主机状态」卡内容：机器 CPU/内存/磁盘/uptime/GPU + agent 进程占用。 */
function HostMetricsCardBody({ metrics }: { metrics: HostMetricsPayload | null }) {
  if (metrics === null) {
    return (
      <Text type="secondary">主机指标暂不可用（管家检查通道离线或正在采样）。</Text>
    );
  }
  const machine = metrics.machine;
  const memUsed =
    machine.memTotalBytes !== null && machine.memFreeBytes !== null
      ? machine.memTotalBytes - machine.memFreeBytes
      : null;
  const gpu = machine.gpu;
  return (
    <Flex vertical gap={8}>
      <MeterRow
        label="CPU"
        percent={machine.cpuPercent}
        detail={machine.cpuPercent === null ? "—" : `${formatDecimal(machine.cpuPercent)}%`}
      />
      <MeterRow
        label="内存"
        percent={usedPercentOf(memUsed, machine.memTotalBytes)}
        detail={`${memUsed === null ? "—" : formatBytes(memUsed)} / ${machine.memTotalBytes === null ? "—" : formatBytes(machine.memTotalBytes)}`}
      />
      <MeterRow
        label="磁盘（/）"
        percent={usedPercentOf(machine.diskUsedBytes, machine.diskTotalBytes)}
        detail={`${machine.diskUsedBytes === null ? "—" : formatBytes(machine.diskUsedBytes)} / ${machine.diskTotalBytes === null ? "—" : formatBytes(machine.diskTotalBytes)}`}
      />
      <MetricRow label="运行时长">
        <Text>{formatUptime(machine.uptimeSeconds)}</Text>
      </MetricRow>
      {gpu !== null && (
        <MetricRow label={`GPU（${gpu.name}）`}>
          <Text>
            利用率 {gpu.utilPercent === null ? "—" : `${formatDecimal(gpu.utilPercent)}%`}
            <Text type="secondary"> · </Text>
            显存 {formatBytes(gpu.memUsedMb * 1024 * 1024)}
          </Text>
        </MetricRow>
      )}
      {metrics.agents.length === 0 ? (
        <Text type="secondary">未发现可采样的 agent 进程。</Text>
      ) : metrics.agents.length > 1 ? (
        <Tabs
          size="small"
          items={metrics.agents.map((agent) => ({
            key: agent.instanceId,
            label: instanceShortName(agent.instanceId),
            children: <AgentProcessRow agent={agent} />,
          }))}
        />
      ) : (
        <AgentProcessRow agent={metrics.agents[0]!} />
      )}
    </Flex>
  );
}

/** 「管家运行指标」卡内容：巡检耗时 / 连接延迟 / 14 天走势 / 服务健康延迟。 */
function ButlerMetricsCardBody({
  inspectStatus,
  latestInspections,
  connections,
  serviceHealth,
  inspectionHistory,
}: {
  inspectStatus: InspectStatusView | null;
  latestInspections: InspectionView[];
  connections: ConnectionsPayload | null;
  serviceHealth: HealthPayload | null;
  inspectionHistory: InspectionHistoryPayload | null;
}) {
  const durationMs = recentInspectionDurationMs(inspectStatus, latestInspections);
  const connectionRows = connections?.connections ?? [];
  const services = serviceHealth?.services ?? null;
  const trendValues = (inspectionHistory?.items ?? [])
    .map((day) => day.avgDurationMs)
    .filter((ms): ms is number => typeof ms === "number" && Number.isFinite(ms));
  const hasAnything =
    durationMs !== null || connectionRows.length > 0 || services !== null || trendValues.length > 0;
  if (!hasAnything) {
    return <Text type="secondary">运行指标暂不可用（管家服务离线或尚未产生数据）。</Text>;
  }
  return (
    <Flex vertical gap={8}>
      <MetricRow label="巡检最近耗时">
        <Text>{formatDuration(durationMs)}</Text>
      </MetricRow>
      <Flex vertical gap={4}>
        <Text type="secondary">连接响应延迟</Text>
        {connectionRows.length === 0 ? (
          <Text type="secondary">暂无实例</Text>
        ) : (
          connectionRows.map((connection) => (
            <MetricRow key={connection.instanceId} label={instanceLabel(connection.instanceId)}>
              <Text>{formatDuration(connection.latencyMs)}</Text>
            </MetricRow>
          ))
        )}
      </Flex>
      <MetricRow label="巡检 14 天走势">
        {trendValues.length === 0 ? (
          <Text type="secondary">暂无走势数据</Text>
        ) : (
          <Sparkline
            values={trendValues}
            label="近 14 天巡检平均耗时（毫秒）"
            width={120}
          />
        )}
      </MetricRow>
      <Flex vertical gap={4}>
        <Text type="secondary">服务健康检查延迟</Text>
        {services === null ? (
          <Text type="secondary">暂无数据</Text>
        ) : (
          <>
            <MetricRow label="告警网关（gateway）">
              <Text>{formatDuration(services.gateway.latencyMs)}</Text>
            </MetricRow>
            <MetricRow label="检查通道（watch）">
              <Text>{formatDuration(services.watch.latencyMs)}</Text>
            </MetricRow>
          </>
        )}
      </Flex>
    </Flex>
  );
}

export function ReadinessSection({
  connections,
  llmStatus,
  discoveredModels,
  refreshing,
  onRefresh,
  hostMetrics = null,
  serviceHealth = null,
  inspectStatus = null,
  inspectionHistory = null,
  latestInspections = [],
}: ReadinessSectionProps) {
  const readiness = useMemo(
    () => buildLocalReadiness(connections, llmStatus, discoveredModels),
    [connections, discoveredModels, llmStatus],
  );

  return (
    <section aria-labelledby="readiness-heading">
      <Flex vertical gap={16}>
        <Flex wrap="wrap" justify="space-between" align="flex-start" gap={16}>
          <div style={{ minWidth: 0 }}>
            <Text
              type="secondary"
              style={{ display: "block", fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}
            >
              持续就绪
            </Text>
            <Title level={4} id="readiness-heading" style={{ marginBottom: 4 }}>
              本机运行就绪度
            </Title>
            <Text type="secondary" aria-live="polite">
              <Text strong>{readiness.summary}</Text>
              {readiness.detail}
            </Text>
          </div>
          <Flex wrap="wrap" gap={8}>
            {readiness.nextAction !== undefined && (
              <Button type="primary" href={readiness.nextAction.to}>
                {readiness.nextAction.label}
              </Button>
            )}
            <Button icon={<ReloadOutlined />} loading={refreshing} onClick={onRefresh}>
              复查状态
            </Button>
          </Flex>
        </Flex>
        <Row gutter={[16, 16]}>
          {readiness.items.map((item) => (
            <Col xs={24} md={12} xl={8} key={item.id}>
              <Card size="small" style={{ height: "100%" }}>
                <Flex vertical gap={8}>
                  <Flex align="center" gap={8}>
                    <ReadinessIcon tone={item.tone} />
                    <Text strong style={{ flex: 1, minWidth: 0 }}>
                      {item.title}
                    </Text>
                    <Badge status={toneBadgeStatus[item.tone]} text={item.status} />
                  </Flex>
                  <Text type="secondary">{item.detail}</Text>
                  {item.action !== undefined && (
                    <Button type="link" href={item.action.to} style={{ paddingInline: 0 }}>
                      {item.action.label}
                    </Button>
                  )}
                </Flex>
              </Card>
            </Col>
          ))}
        </Row>
        <Row gutter={[16, 16]}>
          <Col xs={24} md={12}>
            <Card size="small" style={{ height: "100%" }}>
              <Flex vertical gap={8}>
                <InfoCardHeader title="Agent 主机状态" />
                <HostMetricsCardBody metrics={hostMetrics} />
              </Flex>
            </Card>
          </Col>
          <Col xs={24} md={12}>
            <Card size="small" style={{ height: "100%" }}>
              <Flex vertical gap={8}>
                <InfoCardHeader title="管家运行指标" />
                <ButlerMetricsCardBody
                  inspectStatus={inspectStatus}
                  latestInspections={latestInspections}
                  connections={connections}
                  serviceHealth={serviceHealth}
                  inspectionHistory={inspectionHistory}
                />
              </Flex>
            </Card>
          </Col>
        </Row>
      </Flex>
    </section>
  );
}
