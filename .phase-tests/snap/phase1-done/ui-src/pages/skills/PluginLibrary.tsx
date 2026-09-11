/**
 * 插件库面板：分类/来源筛选 + 通用分组折叠列表。
 * options 构建复用 helpers 的去重工具，与技能库共用同一实现。
 */
import { useMemo, useState } from "react";
import { Card, Col, Empty, Flex, Row, Select, Tag, Typography } from "antd";
import { ChartEmpty, TrendBar, TrendCard, TrendColumn } from "../../components/charts/index.js";
import {
  chartThemeFor,
  horizontalBarAxes,
  primaryFill,
  quietAxes,
} from "../../components/charts/chartTheme.js";
import { useTheme } from "../../theme/ThemeProvider.js";
import type { AssetRiskStatus, PluginItem, SkillsPayload } from "./helpers.js";
import {
  categoryOf,
  collectCategories,
  collectSources,
  formatNumber,
  modeLabel,
  riskDetail,
  riskLabel,
  SOURCE_LABELS,
  toSelectOptions,
} from "./helpers.js";

function compactLabel(value: string, max = 12): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** 风险状态 → antd Tag 语义色（unscanned 走默认中性样式）。 */
const RISK_TAG_COLOR: Record<string, "success" | "error" | undefined> = {
  clear: "success",
  blocked: "error",
  unscanned: undefined,
};

interface PluginLibraryProps {
  plugins: SkillsPayload["plugins"];
}

export function PluginLibrary({ plugins }: PluginLibraryProps) {
  const [category, setCategory] = useState("");
  const [source, setSource] = useState("");

  const categories = useMemo(() => collectCategories(plugins.items), [plugins.items]);
  const sources = useMemo(() => collectSources(plugins.items), [plugins.items]);
  const filtered = useMemo(
    () =>
      plugins.items.filter(
        (item: PluginItem) =>
          (category === "" || (item.category?.trim() || "未分类") === category) &&
          (source === "" || item.source === source),
      ),
    [plugins.items, category, source],
  );
  const { mode } = useTheme();
  const chartTheme = useMemo(() => chartThemeFor(mode), [mode]);

  /** 各类别插件数量（用于纵向柱状图）。 */
  const categoryCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of plugins.items) {
      const category = categoryOf(item.category);
      map.set(category, (map.get(category) ?? 0) + 1);
    }
    return [...map.entries()]
      .map(([category, count]) => ({ category: compactLabel(category), count }))
      .sort((a, b) => b.count - a.count);
  }, [plugins.items]);

  /** 按风险扫描状态统计数量（横向条形图）。 */
  const riskCounts = useMemo(() => {
    const order: AssetRiskStatus[] = ["clear", "unscanned", "blocked"];
    const map = new Map<string, number>();
    for (const item of plugins.items) {
      const key = (item.riskStatus ?? "unscanned") as AssetRiskStatus;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return order
      .filter((status) => (map.get(status) ?? 0) > 0)
      .map((status) => ({ status: riskLabel(status), count: map.get(status) ?? 0 }));
  }, [plugins.items]);

  if (plugins.mode === "unavailable") {
    return <Empty description="暂时读不到插件清单；管家服务恢复后可重试。" />;
  }
  if (plugins.items.length === 0) {
    return <Empty description="没有发现插件；插件会按分类显示在这里。" />;
  }
  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center" gap={12} wrap="wrap">
        <Flex align="baseline" gap={8}>
          <Typography.Title level={4} component="h2" style={{ margin: 0 }}>
            插件库
          </Typography.Title>
          <Typography.Text type="secondary">{formatNumber(plugins.total)} 个</Typography.Text>
        </Flex>
        <Tag>{modeLabel(plugins.mode)}</Tag>
      </Flex>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <TrendCard title="插件分类分布" summary="各分类下的插件数量">
            {categoryCounts.length === 0 ? (
              <ChartEmpty hint="还没有已归类的插件。" />
            ) : (
              <TrendColumn
                data={categoryCounts}
                xField="category"
                yField="count"
                theme={chartTheme.g2Theme}
                autoFit
                height={190}
                axis={quietAxes(chartTheme)}
                style={{
                  maxWidth: 34,
                  fill: primaryFill(mode),
                  radiusTopLeft: 3,
                  radiusTopRight: 3,
                }}
                tooltip={{ items: [{ channel: "y", name: "插件数" }] }}
              />
            )}
          </TrendCard>
        </Col>
        <Col xs={24} lg={12}>
          <TrendCard title="风险扫描状态" summary="已扫描 / 未扫描 / 受限分布">
            {riskCounts.length === 0 ? (
              <ChartEmpty hint="暂时没有可统计的风险状态。" />
            ) : (
              <TrendBar
                data={riskCounts}
                xField="count"
                yField="status"
                theme={chartTheme.g2Theme}
                autoFit
                height={190}
                axis={horizontalBarAxes(chartTheme)}
                legend={false}
                tooltip={{ items: [{ channel: "x", name: "插件数" }] }}
              />
            )}
          </TrendCard>
        </Col>
      </Row>

      <Flex gap={12} wrap="wrap">
        <Flex vertical gap={4} style={{ flex: "1 1 200px", minWidth: 200 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            按分类筛选
          </Typography.Text>
          <Select
            value={category || undefined}
            placeholder="全部分类"
            allowClear
            options={toSelectOptions(categories)}
            onChange={(value) => setCategory(value ?? "")}
          />
        </Flex>
        <Flex vertical gap={4} style={{ flex: "1 1 200px", minWidth: 200 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            按来源筛选
          </Typography.Text>
          <Select
            value={source || undefined}
            placeholder="全部来源"
            allowClear
            options={toSelectOptions(sources, (value) => SOURCE_LABELS[value] ?? value)}
            onChange={(value) => setSource(value ?? "")}
          />
        </Flex>
      </Flex>

      <Row gutter={[12, 12]}>
        {filtered.map((plugin, index) => (
          <Col key={`${plugin.name}:${plugin.version}:${index}`} xs={24} sm={12} xl={8}>
            <Card
              size="small"
              title={plugin.name}
              extra={<Tag>{SOURCE_LABELS[plugin.source] ?? plugin.source}</Tag>}
            >
              <Flex vertical gap={8}>
                <Flex align="center" gap={8} wrap="wrap">
                  <Tag color={RISK_TAG_COLOR[plugin.riskStatus ?? "unscanned"]} title={riskDetail(plugin)}>
                    {riskLabel(plugin.riskStatus)}
                  </Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {riskDetail(plugin)}
                  </Typography.Text>
                </Flex>
                {plugin.description !== undefined && (
                  <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                    {plugin.description}
                  </Typography.Paragraph>
                )}
                <Flex justify="space-between" align="center" gap={8} wrap="wrap">
                  <Typography.Text code>{plugin.version}</Typography.Text>
                  <Tag color={plugin.enabled ? "success" : "default"}>
                    {plugin.enabled ? "已启用" : "已停用"}
                  </Tag>
                </Flex>
              </Flex>
            </Card>
          </Col>
        ))}
      </Row>

      {filtered.length === 0 && <Empty description="没有匹配当前分类的插件。" />}
    </Flex>
  );
}
