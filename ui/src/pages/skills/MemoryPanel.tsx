/**
 * 记忆面板：统计、健康、写入活跃度、按月分布与检索预览。
 * 检索只影响本面板：searching 仅预览区提示，失败单独报错，不牵动技能/插件列表。
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Button,
  Col,
  Empty,
  Flex,
  Input,
  List,
  Row,
  Statistic,
  Tag,
  Typography,
} from "antd";
import { DegradedBanner } from "../../components/DegradedBanner.js";
import { ChartEmpty, TrendColumn } from "../../components/charts/index.js";
import { chartThemeFor, primaryFill, quietAxes } from "../../components/charts/chartTheme.js";
import { useTheme } from "../../theme/ThemeProvider.js";
import type { MemorySelfCheckView, SkillsPayload } from "./helpers.js";
import { channelLabel, formatNumber, formatTime, PREVIEW_LIMIT } from "./helpers.js";
import { DirectoryFallback } from "./DirectoryFallback.js";
import { MemoryHealthCard } from "./MemoryHealthCard.js";

const { Text, Title } = Typography;

/** 写入活跃度 → Alert 语义色。 */
function activityAlertType(status: string): "success" | "warning" | "info" {
  if (status === "active") return "success";
  if (status === "stalled") return "warning";
  return "info";
}

const ACTIVITY_LABEL: Record<string, string> = {
  active: "写入活跃",
  stalled: "可能停写",
  external: "记忆由外部服务接管",
  empty: "尚无记忆",
};

interface MemoryPanelProps {
  /** 生效数据：检索成功用检索结果，其余回退到最近一次完整数据。 */
  data: SkillsPayload | null;
  searching: boolean;
  searchError: string | null;
  activeKeyword: string;
  refreshing: boolean;
  selfCheck: { busy: boolean; result: MemorySelfCheckView | null };
  backupBusy: boolean;
  onSearch: (keyword: string) => void;
  onRefresh: () => void;
  onSelfCheck: () => void;
  onBackup: () => void;
}

export function MemoryPanel({
  data,
  searching,
  searchError,
  activeKeyword,
  refreshing,
  selfCheck,
  backupBusy,
  onSearch,
  onRefresh,
  onSelfCheck,
  onBackup,
}: MemoryPanelProps) {
  const [memoryInput, setMemoryInput] = useState("");

  const months = useMemo(() => {
    const source = data?.memory.stats?.byMonth ?? [];
    return source.slice(-8).reverse();
  }, [data?.memory.stats?.byMonth]);
  const { mode } = useTheme();
  const chartTheme = useMemo(() => chartThemeFor(mode), [mode]);

  const previewEntries = data?.memory.preview ?? [];
  const previewLimit = data?.memory.previewLimit ?? PREVIEW_LIMIT;
  const activityStatus = data?.memory.writeActivity.status ?? "unknown";

  const probeAttempts = data?.memory.stats?.probeRecallAttempts;
  const probeRate =
    probeAttempts !== undefined && probeAttempts > 0
      ? `${Math.round(((data?.memory.stats?.probeRecallHits ?? 0) / probeAttempts) * 100)}%`
      : "—";

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center">
        <Flex vertical>
          <Title level={4} component="h2" style={{ marginBottom: 0 }}>
            记忆库
          </Title>
          <Text type="secondary">统计与检索预览</Text>
        </Flex>
        <Button type="text" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "刷新中" : "刷新"}
        </Button>
      </Flex>

      <Row gutter={[16, 16]}>
        <Col flex="1 1 150px">
          <Statistic
            title="记忆条目"
            value={formatNumber(data?.memory.stats?.totalEntries ?? 0)}
          />
        </Col>
        <Col flex="1 1 150px">
          <Statistic
            title="长期未使用"
            value={formatNumber(data?.memory.stats?.coldCandidates ?? 0)}
          />
        </Col>
        <Col flex="1 1 150px">
          <Statistic
            title="最近写入"
            value={formatTime(data?.memory.stats?.lastWriteAt ?? null, "尚无写入")}
          />
        </Col>
        <Col flex="1 1 150px">
          <Statistic
            title="累计召回"
            value={formatNumber(data?.memory.stats?.cumulativeRecalls ?? 0)}
          />
        </Col>
        <Col flex="1 1 150px">
          <Statistic title="探针召回命中" value={probeRate} />
        </Col>
      </Row>

      <MemoryHealthCard
        health={data?.memory.health ?? null}
        selfCheck={selfCheck}
        onSelfCheck={onSelfCheck}
        onBackup={onBackup}
        backupBusy={backupBusy}
      />

      <Alert
        type={activityAlertType(activityStatus)}
        showIcon
        message={ACTIVITY_LABEL[activityStatus] ?? "状态未知"}
        description={data?.memory.writeActivity.detail ?? "等待管家返回最近写入时间"}
      />

      {data?.memory.mode === "directory-fallback" && (
        <DirectoryFallback directory={data.memory.directory} />
      )}

      <Flex vertical gap={8}>
        <Flex justify="space-between" align="baseline">
          <Title level={5} component="h3" style={{ marginBottom: 0 }}>
            按月写入
          </Title>
          <Text type="secondary">
            {months.length > 0 ? `最近 ${months.length} 个月` : "历史数据"}
          </Text>
        </Flex>
        {months.length === 0 || months.every((item) => item.count === 0) ? (
          <ChartEmpty hint="还没有按月写入历史；使用服务后，这里会出现记忆趋势。" />
        ) : (
          <TrendColumn
            data={months}
            xField="month"
            yField="count"
            theme={chartTheme.g2Theme}
            autoFit
            height={180}
            axis={quietAxes(chartTheme)}
            style={{
              maxWidth: 26,
              fill: primaryFill(mode),
              radiusTopLeft: 3,
              radiusTopRight: 3,
            }}
            tooltip={{ items: [{ channel: "y", name: "写入条数" }] }}
          />
        )}
      </Flex>

      <Flex vertical gap={4}>
        <Text type="secondary">全文检索记忆</Text>
        <Input.Search
          allowClear
          enterButton="浏览"
          placeholder="输入至少 3 个字"
          value={memoryInput}
          onChange={(event) => setMemoryInput(event.target.value)}
          onSearch={(keyword) => onSearch(keyword)}
          disabled={refreshing || data?.memory.mode !== "driver"}
          loading={searching}
        />
      </Flex>

      <Flex justify="space-between" align="baseline" gap={16}>
        <Flex vertical>
          <Text strong>{activeKeyword === "" ? "最近记忆" : `“${activeKeyword}” 的结果`}</Text>
          <Text type="secondary">
            当前显示 {(data?.memory.preview.length ?? 0)} 条 · 最多显示 {previewLimit} 条
          </Text>
        </Flex>
        <Text type={searchError !== null ? "danger" : searching ? "warning" : "secondary"}>
          {searching ? "检索中…" : searchError !== null ? "检索失败" : "读取状态已就绪"}
        </Text>
      </Flex>

      {searchError !== null && (
        <DegradedBanner
          severity="warn"
          message="这一项暂时读不到"
          description={`记忆检索失败：${searchError}`}
          action={<Button onClick={() => onSearch(activeKeyword)}>重试</Button>}
        />
      )}

      <div aria-live="polite" aria-busy={searching}>
        {previewEntries.length === 0 ? (
          !refreshing && !searching ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                data?.memory.mode === "driver"
                  ? "没有可预览的记忆。"
                  : "没有可预览的记忆；管家服务恢复后可重试。"
              }
            />
          ) : null
        ) : (
          <List
            dataSource={previewEntries}
            renderItem={(entry) => (
              <List.Item>
                <Flex vertical gap={4} style={{ width: "100%" }}>
                  <Flex gap={8} align="center" wrap="wrap">
                    <Text type="secondary">{formatTime(entry.writtenAt)}</Text>
                    {entry.channel !== undefined && <Tag>{channelLabel(entry.channel)}</Tag>}
                    {entry.cold === true && <Tag color="warning">较久未用</Tag>}
                  </Flex>
                  <div>{entry.content}</div>
                </Flex>
              </List.Item>
            )}
          />
        )}
      </div>

      <Alert
        type="info"
        showIcon={false}
        message="当前能做到"
        description="这里仅查看技能、插件、记忆与健康状态；可以运行临时记忆自检，并创建本地记忆备份。"
      />
    </Flex>
  );
}
