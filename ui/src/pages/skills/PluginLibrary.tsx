/**
 * 插件库面板：分类/来源筛选 + 通用分组折叠列表。
 * options 构建复用 helpers 的去重工具，与技能库共用同一实现。
 */
import { useMemo, useState } from "react";
import { Select } from "antd";
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
  groupByCategory,
  modeLabel,
  riskDetail,
  riskLabel,
  SOURCE_LABELS,
  toSelectOptions,
} from "./helpers.js";
import { LibraryGroupList } from "./LibraryGroupList.js";

function compactLabel(value: string, max = 12): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

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
  const groups = useMemo(() => groupByCategory(filtered), [filtered]);
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
    return <div className="skills-empty">暂时读不到插件清单；管家服务恢复后可重试。</div>;
  }
  if (plugins.items.length === 0) {
    return <div className="skills-empty">没有发现插件；插件会按分类显示在这里。</div>;
  }
  return (
    <>
      <div className="skills-section-head">
        <div>
          <span className="skills-kicker">插件库</span>
          <h2>{formatNumber(plugins.total)} 个插件</h2>
        </div>
        <span className={`skills-mode is-${plugins.mode}`}>{modeLabel(plugins.mode)}</span>
      </div>
      <div className="skills-charts">
        <div className="skills-chart-duo">
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
        </div>
      </div>
      <div className="skills-filter-row">
        <label className="skills-filter">
          <span>按分类筛选</span>
          <Select
            value={category || undefined}
            placeholder="全部分类"
            allowClear
            options={toSelectOptions(categories)}
            onChange={(value) => setCategory(value ?? "")}
          />
        </label>
        <label className="skills-filter">
          <span>按来源筛选</span>
          <Select
            value={source || undefined}
            placeholder="全部来源"
            allowClear
            options={toSelectOptions(sources, (value) => SOURCE_LABELS[value] ?? value)}
            onChange={(value) => setSource(value ?? "")}
          />
        </label>
      </div>
      <div className="plugin-groups">
        {filtered.length > 0 && (
          <LibraryGroupList
            groups={groups}
            contentClassName="plugin-grid"
            defaultOpenCount={0}
            renderItem={(plugin, index) => (
              <article
                className="plugin-card"
                key={`${plugin.name}:${plugin.version}:${index}`}
              >
                <div className="plugin-card-main">
                  <strong>{plugin.name}</strong>
                  <span>{SOURCE_LABELS[plugin.source] ?? plugin.source}</span>
                </div>
                <div
                  className={"asset-risk is-" + (plugin.riskStatus ?? "unscanned")}
                  title={riskDetail(plugin)}
                >
                  <span>{riskLabel(plugin.riskStatus)}</span>
                  <small>{riskDetail(plugin)}</small>
                </div>
                {plugin.description !== undefined && <p>{plugin.description}</p>}
                <div className="plugin-card-meta">
                  <code>{plugin.version}</code>
                  <span className={plugin.enabled ? "is-enabled" : "is-disabled"}>
                    {plugin.enabled ? "已启用" : "已停用"}
                  </span>
                </div>
              </article>
            )}
          />
        )}
      </div>
      {filtered.length === 0 && <div className="skills-empty">没有匹配当前分类的插件。</div>}
    </>
  );
}
