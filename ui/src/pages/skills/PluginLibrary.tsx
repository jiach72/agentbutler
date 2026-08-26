/**
 * 插件库面板：分类/来源筛选 + 通用分组折叠列表。
 * options 构建复用 helpers 的去重工具，与技能库共用同一实现。
 */
import { useMemo, useState } from "react";
import { Select } from "antd";
import type { PluginItem, SkillsPayload } from "./helpers.js";
import {
  collectCategories,
  collectSources,
  groupByCategory,
  riskDetail,
  riskLabel,
  SOURCE_LABELS,
  toSelectOptions,
} from "./helpers.js";
import { LibraryGroupList } from "./LibraryGroupList.js";

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

  if (plugins.mode === "unavailable") {
    return <div className="skills-empty">暂时读不到插件清单；管家服务恢复后可重试。</div>;
  }
  if (plugins.items.length === 0) {
    return <div className="skills-empty">没有发现插件；插件会按分类显示在这里。</div>;
  }
  return (
    <>
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
            defaultOpenCount={2}
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
