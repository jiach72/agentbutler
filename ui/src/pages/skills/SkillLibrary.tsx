/**
 * 技能库面板：筛选（关键字/分类/来源）+ 分组折叠列表。
 * 仅在主数据就绪后渲染；空结果才显示 Empty，不再把加载失败伪装成空态。
 */
import { useMemo, useState } from "react";
import { Empty, Input, Select } from "antd";
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

interface SkillLibraryProps {
  skills: SkillsPayload["skills"];
}

export function SkillLibrary({ skills }: SkillLibraryProps) {
  const [skillFilter, setSkillFilter] = useState("");
  const [skillCategory, setSkillCategory] = useState("");
  const [skillSource, setSkillSource] = useState("");

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
    <>
      <div className="skills-section-head">
        <div>
          <span className="skills-kicker">技能库</span>
          <h2>{formatNumber(skills.total)} 个技能</h2>
        </div>
        <span className={`skills-mode is-${skills.mode}`}>{modeLabel(skills.mode)}</span>
      </div>

      <div className="skills-charts">
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
      </div>

      <div className="skills-filter-row">
        <label className="skills-filter">
          <span>筛选技能</span>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="名称或版本"
            value={skillFilter}
            onChange={(event) => setSkillFilter(event.target.value)}
          />
        </label>
        <label className="skills-filter">
          <span>按分类筛选</span>
          <Select
            value={skillCategory || undefined}
            placeholder="全部分类"
            allowClear
            options={toSelectOptions(categories)}
            onChange={(value) => setSkillCategory(value ?? "")}
          />
        </label>
        <label className="skills-filter">
          <span>按来源筛选</span>
          <Select
            value={skillSource || undefined}
            placeholder="全部来源"
            allowClear
            options={toSelectOptions(sources, (value) => SOURCE_LABELS[value] ?? value)}
            onChange={(value) => setSkillSource(value ?? "")}
          />
        </label>
      </div>

      <div className="skills-driver-note">
        <strong>{modeLabel(skills.mode)}</strong>
        <span>{skillsNotice(skills.mode)}</span>
      </div>

      {skills.mode === "directory-fallback" && <DirectoryFallback directory={skills.directory} />}

      <div className="skills-list">
        {visibleSkills.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配当前筛选条件的技能" />
        ) : (
          <LibraryGroupList
            groups={groups}
            contentClassName="skill-group-items"
            defaultOpenCount={0}
            renderItem={(skill, index) => (
              <article className="skills-row" key={`${skill.name}:${skill.version}:${index}`}>
                <div className="skills-row-main">
                  <span className="skills-row-name">
                    <strong>{skill.name}</strong>
                    <em>{SOURCE_LABELS[skill.source] ?? skill.source}</em>
                  </span>
                  <small className="skill-description">{skill.description ?? "暂无简介"}</small>
                </div>
                <div className="skills-row-meta">
                  <span className="skills-usage" title="累计调用（热度）">
                    {skill.usage === undefined ? "调用未知" : `${formatNumber(skill.usage)} 次`}
                  </span>
                  <span>{skill.lastUsedAt ? "最近 " + formatTime(skill.lastUsedAt) : "最近使用未知"}</span>
                  <code>{skill.version}</code>
                  <span className={skill.enabled ? "is-enabled" : "is-disabled"}>
                    {skill.enabled ? "已启用" : "已停用"}
                  </span>
                  <span
                    className={"asset-risk-dot is-" + (skill.riskStatus ?? "unscanned")}
                    title={riskDetail(skill)}
                  >
                    {riskLabel(skill.riskStatus)}
                  </span>
                </div>
              </article>
            )}
          />
        )}
      </div>
    </>
  );
}
