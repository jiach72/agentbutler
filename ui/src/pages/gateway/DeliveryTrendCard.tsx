/**
 * 消息通知页 · 送达趋势：从网关终态投影聚合近 7 天的送达结果，
 * 不把当前队列快照冒充成长周期历史。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { ChartEmpty, ChartSkeleton, TrendCard, TrendColumn } from "../../components/charts/index.js";
import {
  chartThemeFor,
  quietAxes,
  semanticSeries,
  topLegend,
} from "../../components/charts/chartTheme.js";
import { useTheme } from "../../theme/ThemeProvider.js";
import { loadJson, type FetchState } from "../../lib/api.js";
import { formatNumber } from "../../lib/format.js";
import type { DeliveryHistoryView } from "../../lib/metrics.js";

interface TrendRow {
  date: string;
  bucket: string;
  count: number;
}

export function DeliveryTrendCard() {
  const { mode } = useTheme();
  const [history, setHistory] = useState<FetchState<DeliveryHistoryView>>({ status: "loading" });

  const load = useCallback(async () => {
    const result = await loadJson<DeliveryHistoryView>("/api/messages/delivery-history?days=7", 8_000);
    setHistory(result.ok ? { status: "ready", data: result.data } : { status: "failed", reason: result.reason });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const chartTheme = useMemo(() => chartThemeFor(mode), [mode]);
  const series = useMemo(
    () =>
      semanticSeries(mode, [
        ["已送达", "已送达", "ok"],
        ["发送失败", "发送失败", "error"],
        ["状态存疑", "状态存疑", "warn"],
      ]),
    [mode],
  );
  const historyData = history.status === "ready" ? history.data : null;
  const rows = useMemo<TrendRow[]>(
    () =>
      (historyData?.items ?? []).flatMap((item) => [
        { date: item.date.slice(5), bucket: "已送达", count: item.delivered },
        { date: item.date.slice(5), bucket: "发送失败", count: item.failed },
        { date: item.date.slice(5), bucket: "状态存疑", count: item.uncertain },
      ]),
    [historyData],
  );

  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const delivered = historyData?.items.reduce((sum, row) => sum + row.delivered, 0) ?? 0;
  const failed = historyData?.items.reduce((sum, row) => sum + row.failed, 0) ?? 0;
  const uncertain = historyData?.items.reduce((sum, row) => sum + row.uncertain, 0) ?? 0;
  const summary =
    history.status === "ready"
      ? `近 ${history.data.days} 天记录 ${formatNumber(total)} 条 · 送达率 ${
          total === 0 ? "—" : `${Math.round((delivered / total) * 100)}%`
        } · ${formatNumber(failed + uncertain)} 条需关注`
      : history.status === "failed"
        ? "送达历史读取失败"
        : "正在读取网关送达历史";

  return (
    <TrendCard
      title="送达趋势"
      summary={summary}
      extra={
        <Button
          type="text"
          icon={<ReloadOutlined />}
          loading={history.status === "loading"}
          aria-label="刷新送达历史"
          onClick={() => void load()}
        >
          刷新
        </Button>
      }
    >
      {history.status === "loading" ? (
        <ChartSkeleton height={210} />
      ) : history.status === "failed" ? (
        <ChartEmpty hint={`送达历史接口不可用：${history.reason}`} />
      ) : !history.data.reachable || total === 0 ? (
        <ChartEmpty
          hint={
            history.data.reachable
              ? "还没有足够的送达历史；消息经过网关后会逐步形成趋势。"
              : "暂时读不到送达历史；网关恢复后会自动重试。"
          }
        />
      ) : (
        <TrendColumn
          data={rows}
          xField="date"
          yField="count"
          colorField="bucket"
          transform={[{ type: "stackY" }]}
          theme={chartTheme.g2Theme}
          autoFit
          height={210}
          scale={{ color: { range: series.map((item) => item.color) } }}
          axis={quietAxes(chartTheme)}
          legend={topLegend(chartTheme)}
          style={{ maxWidth: 24, radiusTopLeft: 3, radiusTopRight: 3 }}
            tooltip={{
            items: [
              {
                channel: "y",
                name: "条数",
                valueFormatter: (value: number) => formatNumber(value),
              },
            ],
          }}
        />
      )}
    </TrendCard>
  );
}
