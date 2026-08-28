/**
 * 记忆面板：统计、健康、写入活跃度、按月分布与检索预览。
 * 检索只影响本面板：searching 仅预览区提示，失败单独报错，不牵动技能/插件列表。
 */
import { useMemo, useState } from "react";
import { Input, Button } from "antd";
import { DegradedBanner } from "../../components/DegradedBanner.js";
import { ChartEmpty, TrendColumn } from "../../components/charts/index.js";
import { chartThemeFor, primaryFill, quietAxes } from "../../components/charts/chartTheme.js";
import { useTheme } from "../../theme/ThemeProvider.js";
import type { MemorySelfCheckView, SkillsPayload } from "./helpers.js";
import {
  channelLabel,
  formatNumber,
  formatTime,
  PREVIEW_LIMIT,
} from "./helpers.js";
import { DirectoryFallback } from "./DirectoryFallback.js";
import { MemoryHealthCard } from "./MemoryHealthCard.js";

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

  return (
    <>
      <div className="skills-section-head">
        <div>
          <span className="skills-kicker">记忆库</span>
          <h2>统计与检索预览</h2>
        </div>
        <Button
          type="text"
          size="small"
          className="skills-refresh"
          onClick={onRefresh}
          disabled={refreshing}
        >
          {refreshing ? "刷新中" : "刷新"}
        </Button>
      </div>

      <div className="memory-stats">
        <div>
          <strong>{formatNumber(data?.memory.stats?.totalEntries ?? 0)}</strong>
          <span>记忆条目</span>
        </div>
        <div>
          <strong>{formatNumber(data?.memory.stats?.coldCandidates ?? 0)}</strong>
          <span>长期未使用</span>
        </div>
        <div>
          <strong>{formatTime(data?.memory.stats?.lastWriteAt ?? null, "尚无写入")}</strong>
          <span>最近写入</span>
        </div>
        <div>
          <strong>{formatNumber(data?.memory.stats?.cumulativeRecalls ?? 0)}</strong>
          <span>累计召回</span>
        </div>
        <div>
          <strong>
            {data?.memory.stats?.probeRecallAttempts !== undefined &&
            data?.memory.stats?.probeRecallAttempts > 0
              ? `${Math.round(
                  ((data.memory.stats.probeRecallHits ?? 0) / data.memory.stats.probeRecallAttempts) *
                    100,
                )}%`
              : "—"}
          </strong>
          <span>探针召回命中</span>
        </div>
      </div>

      <div className="memory-health-wrap">
        <MemoryHealthCard
          health={data?.memory.health ?? null}
          selfCheck={selfCheck}
          onSelfCheck={onSelfCheck}
          onBackup={onBackup}
          backupBusy={backupBusy}
        />
      </div>

      <div className={`memory-activity is-${data?.memory.writeActivity.status ?? "unknown"}`}>
        <i />
        <div>
          <strong>
            {data?.memory.writeActivity.status === "active"
              ? "写入活跃"
              : data?.memory.writeActivity.status === "stalled"
                ? "可能停写"
                : data?.memory.writeActivity.status === "empty"
                  ? "尚无记忆"
                  : "状态未知"}
          </strong>
          <span>{data?.memory.writeActivity.detail ?? "等待管家返回最近写入时间"}</span>
        </div>
      </div>

      {data?.memory.mode === "directory-fallback" && (
        <DirectoryFallback directory={data.memory.directory} />
      )}

      <div className="memory-months">
        <div className="memory-subhead">
          <strong>按月写入</strong>
          <span>{months.length > 0 ? `最近 ${months.length} 个月` : "历史数据"}</span>
        </div>
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
      </div>

      <form
        className="memory-search"
        onSubmit={(event) => {
          event.preventDefault();
          onSearch(memoryInput);
        }}
      >
        <label>
          <span>全文检索记忆</span>
          <Input.Search
            allowClear
            placeholder="输入至少 3 个字"
            value={memoryInput}
            onChange={(event) => setMemoryInput(event.target.value)}
            onSearch={(value) => onSearch(value)}
            enterButton="浏览"
            disabled={refreshing || data?.memory.mode !== "driver"}
            loading={searching}
          />
        </label>
      </form>

      <div className="memory-preview-head">
        <div>
          <strong>{activeKeyword === "" ? "最近记忆" : `“${activeKeyword}” 的结果`}</strong>
          <span>
            当前显示 {(data?.memory.preview.length ?? 0)} 条 · 最多显示{" "}
            {previewLimit} 条
          </span>
        </div>
        <strong>
          {searching ? "检索中…" : searchError !== null ? "检索失败" : "读取状态已就绪"}
        </strong>
      </div>

      {searchError !== null && (
        <DegradedBanner
          severity="warn"
          message="这一项暂时读不到"
          description={`记忆检索失败：${searchError}`}
          action={<Button size="small" onClick={() => onSearch(activeKeyword)}>重试</Button>}
        />
      )}

      <div className="memory-preview" aria-live="polite" aria-busy={searching}>
        {previewEntries.map((entry, index) => (
          <article
            className="memory-entry"
            key={entry.entryId}
            style={{ animationDelay: `${Math.min(index, 10) * 30}ms` }}
          >
            <div>
              <span>{formatTime(entry.writtenAt)}</span>
              {entry.channel !== undefined && (
                <span className="memory-channel">{channelLabel(entry.channel)}</span>
              )}
              {entry.cold === true && <em>较久未用</em>}
            </div>
            <p>{entry.content}</p>
          </article>
        ))}
        {!refreshing && !searching && previewEntries.length === 0 && (
          <div className="skills-empty">
            {data?.memory.mode === "driver"
              ? "没有可预览的记忆。"
              : "没有可预览的记忆；管家服务恢复后可重试。"}
          </div>
        )}
      </div>

      <div className="skills-scope-note">
        <span>当前能做到</span>
        <p>
          这里仅查看技能、插件、记忆与健康状态；可以运行临时记忆自检，并创建本地记忆备份。
        </p>
      </div>
    </>
  );
}
