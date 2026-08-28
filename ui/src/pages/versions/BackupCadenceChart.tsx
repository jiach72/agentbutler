/**
 * 版本页 · 备份节奏：受管实例升级快照与管家自身更新快照的按日分布（30 天），
 * 用堆叠柱回答「管家有没有按时留后路」。
 */
import { useMemo } from "react";
import type { ThemeMode } from "../../theme/tokens.js";
import type { SnapshotView, ButlerSelfSnapshot } from "./types.js";
import {
  ChartEmpty,
  TrendCard,
  TrendColumn,
} from "../../components/charts/index.js";
import {
  chartThemeFor,
  quietAxes,
  semanticSeries,
  topLegend,
} from "../../components/charts/chartTheme.js";

const DAY_MS = 86_400_000;

function dayLabel(d: Date): string {
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface Row {
  date: string;
  bucket: string;
  count: number;
}

export function BackupCadenceChart({
  snapshots,
  selfSnapshots,
  mode,
}: {
  snapshots: SnapshotView[];
  selfSnapshots: ButlerSelfSnapshot[];
  mode: ThemeMode;
}) {
  const chartTheme = useMemo(() => chartThemeFor(mode), [mode]);
  const series = useMemo(
    () =>
      semanticSeries(mode, [
        ["受管备份", "受管备份", "ok"],
        ["自更新快照", "自更新快照", "teal"],
      ]),
    [mode],
  );

  const trend = useMemo(() => {
    const days = 30;
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const counts = new Map<string, Map<string, number>>();
    for (let i = days - 1; i >= 0; i -= 1) {
      counts.set(dayLabel(new Date(now.getTime() - i * DAY_MS)), new Map());
    }
    const add = (at: string | undefined, bucket: string) => {
      if (at === undefined || at === "") return;
      const time = new Date(at);
      if (Number.isNaN(time.getTime())) return;
      const perDay = counts.get(dayLabel(time));
      if (perDay !== undefined) perDay.set(bucket, (perDay.get(bucket) ?? 0) + 1);
    };
    for (const snapshot of snapshots) {
      if (snapshot.status === "ok") add(snapshot.createdAt, "受管备份");
    }
    for (const snapshot of selfSnapshots) add(snapshot.at, "自更新快照");

    let total = 0;
    const rows: Row[] = [];
    for (const [date, perDay] of counts) {
      for (const bucket of ["受管备份", "自更新快照"]) {
        const count = perDay.get(bucket) ?? 0;
        total += count;
        rows.push({ date, bucket, count });
      }
    }
    return { rows, total };
  }, [snapshots, selfSnapshots]);

  if (trend.total === 0) {
    return (
      <ChartEmpty hint="还没有备份记录；首次升级或备份完成后，这里会出现按日的备份节奏图。" />
    );
  }

  return (
    <TrendCard title="备份节奏" summary={`近 30 天自动保存 ${trend.total} 次 · 每次升级前都会先备份`}>
      <TrendColumn
        data={trend.rows}
        xField="date"
        yField="count"
        colorField="bucket"
        transform={[{ type: "stackY" }]}
        theme={chartTheme.g2Theme}
        autoFit
        height={200}
        scale={{ color: { range: series.map((s) => s.color) } }}
        axis={quietAxes(chartTheme)}
        legend={topLegend(chartTheme)}
        style={{ maxWidth: 22, radiusTopLeft: 3, radiusTopRight: 3 }}
      />
    </TrendCard>
  );
}
