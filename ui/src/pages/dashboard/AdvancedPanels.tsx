/**
 * 高级详情内的三块面板：一键处理方案、管家最近检查、经常出现的问题。
 */
import { Button, Card, Descriptions, Empty, Flex, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table/interface.js";
import { DegradedBanner } from "../../components/DegradedBanner.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { formatRelative } from "../../lib/format.js";
import {
  criticalProbeBadge,
  fingerprintBadge,
  formatDuration,
  formatSample,
  instanceLabel,
} from "./helpers.js";
import type { FingerprintView, InspectStatusView, RunbookView, RunbooksPayload } from "./types.js";

const { Text } = Typography;

/** 可以一键处理：修复方案列表，熔断中的方案被过滤。 */
export function RunbooksPanel({
  runbooks,
  onRepair,
}: {
  runbooks: RunbooksPayload | null;
  onRepair: (runbook: RunbookView) => void;
}) {
  const available = (runbooks?.runbooks ?? []).filter(
    (item) => item.breakerTripped !== true,
  );
  return (
    <>
      {runbooks !== null && !runbooks.reachable && (
        <DegradedBanner severity="warn" message="管家暂时连不上：处理方案列表暂不可用" />
      )}
      {runbooks !== null && runbooks.reachable && available.length === 0 && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="管家在线，但还没有可以一键处理的问题。"
        />
      )}
      {runbooks !== null && runbooks.reachable && (
        <Flex vertical gap={8}>
          {available.map((runbook) => (
            <Card size="small" key={runbook.id}>
              <Flex wrap="wrap" justify="space-between" align="center" gap={12}>
                <Flex vertical gap={4} style={{ minWidth: 0 }}>
                  <Flex wrap="wrap" align="center" gap={8}>
                    <Text strong>{runbook.label}</Text>
                    {runbook.breakerTripped === true && (
                      <StatusBadge tone="error" label="已暂停" />
                    )}
                  </Flex>
                  {runbook.description !== undefined && runbook.description !== "" && (
                    <Text type="secondary">{runbook.description}</Text>
                  )}
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    上次执行：
                    {runbook.lastRun
                      ? `${formatRelative(runbook.lastRun.at)}（${runbook.lastRun.success ? "成功" : "失败"}）`
                      : "从未执行"}
                  </Text>
                </Flex>
                <Button onClick={() => onRepair(runbook)}>
                  开始处理
                </Button>
              </Flex>
            </Card>
          ))}
        </Flex>
      )}
    </>
  );
}

/** 管家最近检查：关键记忆探针 SLA 与检查节奏。 */
export function InspectCard({
  inspectStatus,
  onInspect,
}: {
  inspectStatus: InspectStatusView | null;
  onInspect: () => void;
}) {
  if (inspectStatus === null || !inspectStatus.reachable) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="管家服务暂时连不上：看不到最近检查，也无法开始新的检查。"
      />
    );
  }
  const criticalProbe = inspectStatus.criticalProbe;
  const criticalBadge = criticalProbeBadge(criticalProbe);
  return (
    <Flex vertical gap={12}>
      {criticalProbe === undefined ? null : (
        <Flex wrap="wrap" align="center" gap={8} role="status">
          <StatusBadge tone={criticalBadge.tone} label={criticalBadge.label} />
          <Text type="secondary">
            关键记忆探针：每 {criticalProbe.intervalMin} 分钟，SLA {criticalProbe.slaMin} 分钟
          </Text>
          {criticalProbe.lastDurationMs !== null ? (
            <Text type="secondary">最近耗时 {formatDuration(criticalProbe.lastDurationMs)}</Text>
          ) : null}
        </Flex>
      )}
      <Descriptions
        size="small"
        column={2}
        items={[
          { key: "last", label: "上次检查", children: formatRelative(inspectStatus.lastAt) },
          { key: "next", label: "下次预计", children: formatRelative(inspectStatus.nextAt) },
          { key: "interval", label: "多久检查一次", children: `${inspectStatus.intervalMin ?? "—"} 分钟` },
          { key: "now", label: "现在", children: inspectStatus.inFlight ? "正在检查" : "没有在检查" },
        ]}
      />
      <Button onClick={onInspect}>立即检查</Button>
    </Flex>
  );
}

const FINGERPRINT_COLUMNS = (onOpenLogs: () => void): ColumnsType<FingerprintView> => [
  {
    title: "问题内容",
    ellipsis: true,
    render: (_, fp) => (
      <span title={fp.lastSample ?? undefined}>
        {formatSample(fp.lastSample)}
      </span>
    ),
  },
  {
    title: "影响组件",
    width: 110,
    render: (_, fp) => (fp.instance ? instanceLabel(fp.instance) : "未知"),
  },
  {
    title: "首次出现",
    width: 110,
    render: (_, fp) => formatRelative(fp.firstSeen),
  },
  { title: "次数", dataIndex: "count", width: 72, align: "right" },
  {
    title: "状态",
    width: 96,
    render: (_, fp) => {
      const badge = fingerprintBadge(fp.status);
      return <StatusBadge tone={badge.tone} label={badge.label} />;
    },
  },
  {
    title: "最近出现",
    width: 110,
    render: (_, fp) => formatRelative(fp.lastSeen),
  },
  {
    title: "日志",
    width: 88,
    render: () => (
      <Button type="link" style={{ paddingInline: 0 }} onClick={onOpenLogs}>
        查看日志
      </Button>
    ),
  },
];

/** 经常出现的问题：同类错误指纹表。 */
export function FingerprintsTable({
  fingerprints,
  onOpenLogs,
}: {
  fingerprints: FingerprintView[];
  onOpenLogs: () => void;
}) {
  if (fingerprints.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="暂时没有经常出现的问题；如果以后出现，会显示在这里。"
      />
    );
  }
  return (
    <Table<FingerprintView>
      size="small"
      rowKey="signature"
      pagination={false}
      dataSource={fingerprints}
      columns={FINGERPRINT_COLUMNS(onOpenLogs)}
    />
  );
}
