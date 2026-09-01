/**
 * 技能库面板：筛选（关键字/分类/来源）+ 分组折叠列表。
 * 仅在主数据就绪后渲染；空结果才显示 Empty，不再把加载失败伪装成空态。
 */
import { useMemo, useState } from "react";
import { Alert, Card, Empty, Flex, Input, Select, Tag, Typography, theme } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { ChartEmpty, TrendBar, TrendCard } from "../../components/charts/index.js";
import {
  chartThemeFor,
  horizontalBarAxes,
} from "../../components/charts/chartTheme.js";
import { useTheme } from "../../theme/ThemeProvider.js";
import type { SkillsPayload } from "./helpers.js";
import {
  categoryOf,
  collectCategories,
  collectSources,
  formatNumber,
  formatTime,
  groupByCategory,
  modeLabel,
  riskDetail,
  riskLabel,
  skillsNotice,
  SOURCE_LABELS,
  toSelectOptions,
} from "./helpers.js";
import { DirectoryFallback } from "./DirectoryFallback.js";
import { LibraryGroupList } from "./LibraryGroupList.js";

function compactLabel(value: string, max = 12): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** 风险状态 → antd Tag 语义色（unscanned 走默认中性样式）。 */
const RISK_TAG_COLOR: Record<string, "success" | "error" | undefined> = {
  clear: "success",
  blocked: "error",
  unscanned: undefined,
};

interface SkillLibraryProps {
  skills: SkillsPayload["skills"];
}

export function SkillLibrary({ skills }: SkillLibraryProps) {
  const [skillFilter, setSkillFilter] = useState("");
  const [skillCategory, setSkillCategory] = useState("");
  const [skillSource, setSkillSource] = useState("");
  const { token } = theme.useToken();

  const visibleSkills = useMemo(() => {
    const needle = skillFilter.trim().toLocaleLowerCase();
    const items = skills.items;
    const categoryMatched =
      skillCategory === "" ? items : items.filter((skill) => categoryOf(skill.category) === skillCategory);
    const sourceMatched =
      skillSource === ""
        ? categoryMatched
        : categoryMatched.filter((skill) => skill.source === skillSource);
    if (needle === "") return sourceMatched;
    return sourceMatched.filter((skill) =>
      `${skill.name} ${skill.version} ${skill.source}`.toLocaleLowerCase().includes(needle),
    );
  }, [skills.items, skillFilter, skillCategory, skillSource]);

  const categories = useMemo(() => collectCategories(skills.items), [skills.items]);
  const sources = useMemo(() => collectSources(skills.items), [skills.items]);
  const groups = useMemo(() => groupByCategory(visibleSkills), [visibleSkills]);
  const { mode } = useTheme();
  const chartTheme = useMemo(() => chartThemeFor(mode), [mode]);

  /** 按分类汇总累计调用，作为「分类热度」条形图（仅统计有 usage 的条目）。 */
  const usageByCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of skills.items) {
      if (item.usage === undefined) continue;
      const category = categoryOf(item.category);
      map.set(category, (map.get(category) ?? 0) + item.usage);
    }
    return [...map.entries()]
      .map(([category, count]) => ({ category: compactLabel(category), count }))
      .filter((item) => item.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }, [skills.items]);

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center" gap={12} wrap="wrap">
        <Flex align="baseline" gap={8}>
          <Typography.Title level={4} component="h2" style={{ margin: 0 }}>
            技能库
          </Typography.Title>
          <Typography.Text type="secondary">{formatNumber(skills.total)} 个</Typography.Text>
        </Flex>
        <Tag>{modeLabel(skills.mode)}</Tag>
      </Flex>

      <TrendCard title="按分类调用热度" summary="汇总各分类下技能的累计调用">
        {usageByCategory.length === 0 ? (
          <ChartEmpty hint="还没有可统计的调用数据；使用技能后，这里会出现分类热度。" />
        ) : (
          <TrendBar
            data={usageByCategory}
            xField="count"
            yField="category"
            theme={chartTheme.g2Theme}
            autoFit
            height={Math.max(160, usageByCategory.length * 38)}
            axis={horizontalBarAxes(chartTheme)}
            legend={false}
            tooltip={{ items: [{ channel: "x", name: "累计调用" }] }}
          />
        )}
      </TrendCard>

      <Card size="small">
        <Flex gap={12} wrap="wrap">
          <Flex vertical gap={4} style={{ flex: "1 1 200px", minWidth: 200 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              筛选技能
            </Typography.Text>
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="名称或版本"
              value={skillFilter}
              onChange={(event) => setSkillFilter(event.target.value)}
            />
          </Flex>
          <Flex vertical gap={4} style={{ flex: "1 1 180px", minWidth: 180 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              按分类筛选
            </Typography.Text>
            <Select
              value={skillCategory || undefined}
              placeholder="全部分类"
              allowClear
              options={toSelectOptions(categories)}
              onChange={(value) => setSkillCategory(value ?? "")}
            />
          </Flex>
          <Flex vertical gap={4} style={{ flex: "1 1 180px", minWidth: 180 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              按来源筛选
            </Typography.Text>
            <Select
              value={skillSource || undefined}
              placeholder="全部来源"
              allowClear
              options={toSelectOptions(sources, (value) => SOURCE_LABELS[value] ?? value)}
              onChange={(value) => setSkillSource(value ?? "")}
            />
          </Flex>
        </Flex>
      </Card>

      <Alert
        type={skills.mode === "driver" ? "info" : "warning"}
        showIcon
        message={modeLabel(skills.mode)}
        description={skillsNotice(skills.mode)}
      />

      {skills.mode === "directory-fallback" && <DirectoryFallback directory={skills.directory} />}

      {visibleSkills.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配当前筛选条件的技能" />
      ) : (
        <LibraryGroupList
          groups={groups}
          defaultOpenCount={0}
          renderItem={(skill, index) => (
            <Flex
              key={`${skill.name}:${skill.version}:${index}`}
              justify="space-between"
              align="flex-start"
              gap={16}
              wrap="wrap"
              style={{ padding: "10px 2px", borderBottom: `1px solid ${token.colorBorderSecondary}` }}
            >
              <div style={{ minWidth: 0, flex: "1 1 260px" }}>
                <Flex align="center" gap={8} wrap="wrap">
                  <Typography.Text strong>{skill.name}</Typography.Text>
                  <Tag>{SOURCE_LABELS[skill.source] ?? skill.source}</Tag>
                </Flex>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
                  {skill.description ?? "暂无简介"}
                </Typography.Paragraph>
              </div>
              <Flex align="center" gap={12} wrap="wrap">
                <Typography.Text type="secondary" title="累计调用（热度）">
                  {skill.usage === undefined ? "调用未知" : `${formatNumber(skill.usage)} 次`}
                </Typography.Text>
                <Typography.Text type="secondary">
                  {skill.lastUsedAt ? "最近 " + formatTime(skill.lastUsedAt) : "最近使用未知"}
                </Typography.Text>
                <Typography.Text code>{skill.version}</Typography.Text>
                <Tag color={skill.enabled ? "success" : "default"}>
                  {skill.enabled ? "已启用" : "已停用"}
                </Tag>
                <Tag color={RISK_TAG_COLOR[skill.riskStatus ?? "unscanned"]} title={riskDetail(skill)}>
                  {riskLabel(skill.riskStatus)}
                </Tag>
              </Flex>
            </Flex>
          )}
        />
      )}
    </Flex>
  );
}
