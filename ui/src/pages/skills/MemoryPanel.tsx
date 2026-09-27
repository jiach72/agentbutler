/**
 * 记忆面板：统计、健康、写入活跃度、按月分布与检索预览。
 * 检索只影响本面板：searching 仅预览区提示，失败单独报错，不牵动技能/插件列表。
 */
import { useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Flex,
  Input,
  Popconfirm,
  Row,
  Statistic,
  Tag,
  Typography,
} from "antd";
import {
  CopyOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  LineChartOutlined,
  SearchOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { DegradedBanner } from "../../components/DegradedBanner.js";
import { ChartEmpty, TrendColumn } from "../../components/charts/index.js";
import { chartThemeFor, primaryFill, quietAxes } from "../../components/charts/chartTheme.js";
import { useTheme } from "../../theme/ThemeProvider.js";
import type { MemorySelfCheckView, SkillsPayload } from "./helpers.js";
import { channelLabel, formatNumber, formatTime, memoryBackendLabel, PREVIEW_LIMIT } from "./helpers.js";
import { DirectoryFallback } from "./DirectoryFallback.js";
import { Empty } from "../../components/Empty.js";
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
  /** 一键修复（重试外部记忆后端失败的后台操作）。 */
  onRebuildIndex?: () => void;
  rebuildBusy?: boolean;
  memoryWritesEnabled?: boolean | null;
  /** 一键遗忘特定记忆 */
  onForget?: (entryId: string) => Promise<boolean>;
  /** 跳转至记忆系统中心标签页 */
  onGoToSystems?: () => void;
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
  onRebuildIndex,
  rebuildBusy,
  memoryWritesEnabled,
  onForget,
  onGoToSystems,
}: MemoryPanelProps) {
  const { message } = App.useApp();
  const [memoryInput, setMemoryInput] = useState("");
  const [forgettingId, setForgettingId] = useState<string | null>(null);

  const copyMemoryText = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      message.success("记忆内容已复制到剪贴板");
    }).catch(() => {
      message.info("已选中记忆内容");
    });
  };

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
    <Flex vertical gap={16} className="memory-panel">
      <Flex
        justify="space-between"
        align="flex-start"
        gap={12}
        wrap="wrap"
        className="memory-panel-heading"
      >
        <Flex vertical>
          <Flex align="center" gap={8}>
            <DatabaseOutlined aria-hidden="true" />
            <Title level={4} component="h2" style={{ marginBottom: 0 }}>
              记忆库
            </Title>
          </Flex>
          <Text type="secondary">先确认记忆是否健康，再查看写入趋势或检索内容。</Text>
          {data?.memory.backend !== undefined && (
            <Flex align="center" gap={8} wrap="wrap" style={{ marginTop: 4 }}>
              <Tag
                color={(data.memory.backend.backend ?? data.memory.backend.id) === "hermes" ? "default" : "processing"}
                style={{ borderRadius: 6, padding: "2px 8px" }}
                title={data.memory.backend.detail}
              >
                <strong>当前主记忆系统：</strong>
                {memoryBackendLabel(data.memory.backend)}
              </Tag>
              <Button
                type="link"
                size="small"
                style={{ padding: 0 }}
                onClick={() => (onGoToSystems ? onGoToSystems() : (window.location.href = "/memory"))}
              >
                [管理 / 切换后端 →]
              </Button>
            </Flex>
          )}
        </Flex>
        <Flex gap={8} align="center">
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            onClick={() => (onGoToSystems ? onGoToSystems() : (window.location.href = "/skills?tab=systems"))}
          >
            记忆系统中心
          </Button>
          <Button type="default" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? "刷新中" : "刷新"}
          </Button>
        </Flex>
      </Flex>

      <Alert
        type="info"
        showIcon
        icon={<ThunderboltOutlined />}
        style={{
          borderRadius: 8,
        }}
        title={
          <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
            <span>
              <strong>多记忆引擎数据已联动生效：</strong>
              当前正在呈现 <strong>{memoryBackendLabel(data?.memory.backend)}</strong> 的实时条目与检索索引。
              如需更改主要记忆库或部署新引擎，可进入记忆系统中心完成一键配置。
            </span>
            <Button
              size="small"
              type="primary"
              onClick={() => (onGoToSystems ? onGoToSystems() : (window.location.href = "/skills?tab=systems"))}
            >
              打开选型与配置中心 →
            </Button>
          </Flex>
        }
      />

      <Row gutter={[12, 12]} className="memory-stat-grid">
        <Col flex="1 1 150px">
          <Card size="small">
            <Statistic
              title="记忆条目"
              value={formatNumber(data?.memory.stats?.totalEntries ?? 0)}
            />
          </Card>
        </Col>
        <Col flex="1 1 150px">
          <Card size="small">
            <Statistic
              title="长期未使用"
              value={formatNumber(data?.memory.stats?.coldCandidates ?? 0)}
            />
          </Card>
        </Col>
        <Col flex="1 1 150px">
          <Card size="small">
            <Statistic
              title="最近写入"
              value={formatTime(data?.memory.stats?.lastWriteAt ?? null, "尚无写入")}
            />
          </Card>
        </Col>
        <Col flex="1 1 150px">
          <Card size="small">
            <Statistic
              title="累计召回"
              value={formatNumber(data?.memory.stats?.cumulativeRecalls ?? 0)}
            />
          </Card>
        </Col>
        <Col flex="1 1 150px">
          <Card size="small">
            <Statistic title="探针召回命中" value={probeRate} />
          </Card>
        </Col>
      </Row>

      <MemoryHealthCard
        health={data?.memory.health ?? null}
        selfCheck={selfCheck}
        onSelfCheck={onSelfCheck}
        onBackup={onBackup}
        onRebuildIndex={onRebuildIndex}
        rebuildBusy={rebuildBusy}
        backupBusy={backupBusy}
        memoryWritesEnabled={memoryWritesEnabled}
      />

      <Alert
        type={activityAlertType(activityStatus)}
        showIcon
        title={ACTIVITY_LABEL[activityStatus] ?? "状态未知"}
        description={data?.memory.writeActivity.detail ?? "等待管家返回最近写入时间"}
      />

      {data?.memory.mode === "directory-fallback" && (
        <DirectoryFallback directory={data.memory.directory} />
      )}

      <Card size="small" className="memory-trend-card">
        <Flex vertical gap={8}>
          <Flex justify="space-between" align="baseline">
            <Flex align="center" gap={8}>
              <LineChartOutlined aria-hidden="true" />
              <Title level={5} component="h3" style={{ marginBottom: 0 }}>
                按月写入
              </Title>
            </Flex>
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
              style={{ maxWidth: 26, fill: primaryFill(mode), radiusTopLeft: 3, radiusTopRight: 3 }}
              tooltip={{ items: [{ channel: "y", name: "写入条数" }] }}
            />
          )}
        </Flex>
      </Card>

      <Card
        size="small"
        title={
          <Flex align="center" gap={8}>
            <SearchOutlined aria-hidden="true" />
            全文检索记忆
          </Flex>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 10 }}>
          按关键词浏览最近保存的内容，不会修改记忆。
        </Typography.Paragraph>
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
      </Card>

      <Flex justify="space-between" align="baseline" gap={16}>
        <Flex vertical>
          <Text strong>{activeKeyword === "" ? "最近记忆" : `“${activeKeyword}” 的结果`}</Text>
          <Text type="secondary">
            当前显示 {data?.memory.preview.length ?? 0} 条 · 最多显示 {previewLimit} 条
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
              mascot={false}
              title="没有可预览的记忆"
              hint={data?.memory.mode === "driver" ? undefined : "管家服务恢复后，这里会重新显示最近记忆。"}
            />
          ) : null
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {previewEntries.map((entry) => (
              <div
                key={entry.entryId}
                className="p-3.5 rounded-xl bg-surface-container/50 hover:bg-surface-container border border-outline-variant/15 hover:border-outline-variant/30 transition-all flex flex-col justify-between gap-2.5 shadow-2xs group"
              >
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {entry.channel !== undefined ? (
                        <Tag color="blue" style={{ margin: 0, borderRadius: 10, fontSize: 11 }}>
                          {channelLabel(entry.channel)}
                        </Tag>
                      ) : (
                        <Tag style={{ margin: 0, borderRadius: 10, fontSize: 11 }}>全局记忆</Tag>
                      )}
                      {entry.cold === true && (
                        <Tag color="warning" style={{ margin: 0, borderRadius: 10, fontSize: 11 }}>
                          较久未用
                        </Tag>
                      )}
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        {formatTime(entry.writtenAt)}
                      </Text>
                    </div>

                    <div className="flex items-center gap-1 opacity-80 group-hover:opacity-100 transition-opacity">
                      <Button
                        type="text"
                        size="small"
                        icon={<CopyOutlined />}
                        title="复制记忆文本"
                        onClick={() => copyMemoryText(entry.content)}
                        style={{ width: 26, height: 26, padding: 0 }}
                      />
                      {onForget && (
                        <Popconfirm
                          title="遗忘此条记忆？"
                          description="遗忘后此条记忆将被永久删除且无法召回。"
                          okText="确认遗忘"
                          cancelText="取消"
                          okButtonProps={{ danger: true }}
                          disabled={forgettingId === entry.entryId || data?.memory.mode !== "driver"}
                          onConfirm={async () => {
                            setForgettingId(entry.entryId);
                            try {
                              await onForget(entry.entryId);
                            } finally {
                              setForgettingId(null);
                            }
                          }}
                        >
                          <Button
                            type="text"
                            size="small"
                            danger
                            icon={<DeleteOutlined />}
                            loading={forgettingId === entry.entryId}
                            disabled={data?.memory.mode !== "driver"}
                            title="遗忘此条记忆"
                            style={{ width: 26, height: 26, padding: 0 }}
                          />
                        </Popconfirm>
                      )}
                    </div>
                  </div>

                  <div
                    style={{
                      wordBreak: "break-word",
                      whiteSpace: "pre-wrap",
                      fontSize: 13,
                      lineHeight: 1.6,
                      color: "var(--ab-text, inherit)",
                    }}
                  >
                    {entry.content}
                  </div>
                </div>

                <div className="pt-2 border-t border-outline-variant/10 flex items-center justify-between text-[11px] text-on-surface-variant font-mono">
                  <span>ID: {entry.entryId.slice(0, 8)}…</span>
                  <span className="text-primary hover:underline cursor-pointer" onClick={() => copyMemoryText(entry.content)}>
                    点击复制
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Alert
        type="info"
        showIcon={false}
        title="记忆页边界"
        description="这里可以查看技能、插件、记忆与健康状态，也可以运行临时自检、一键遗忘特定记忆和创建本地备份；不会批量清空未确认的全部记忆。"
      />
    </Flex>
  );
}
