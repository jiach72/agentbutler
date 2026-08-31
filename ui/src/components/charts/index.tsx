/**
 * 图表渲染出口：懒加载 @ant-design/charts 的具体图形（G2 v5），
 * 图表代码进入异步 chunk，不增加首屏包体；Suspense 占位与空态复用页面原语。
 */
import { Suspense, lazy } from "react";
import type { ReactNode } from "react";
import { Spin } from "antd";

/** G2 v5 的配置对象是开放式结构，这里以宽松 props 透传，具体字段见 chartTheme.ts。 */
type PlotProps = Record<string, unknown>;

const CHART_ANIMATION = {
  enter: { type: "fadeIn", duration: 240 },
  update: { duration: 180 },
  leave: { duration: 160 },
};

function withChartDefaults(props: PlotProps): PlotProps {
  return {
    ...props,
    autoFit: props.autoFit ?? true,
    animate: props.animate ?? CHART_ANIMATION,
  };
}

const ColumnPlot = lazy(() =>
  import("@ant-design/charts").then((m) => ({ default: m.Column as React.FC<PlotProps> })),
);
const LinePlot = lazy(() =>
  import("@ant-design/charts").then((m) => ({ default: m.Line as React.FC<PlotProps> })),
);
const AreaPlot = lazy(() =>
  import("@ant-design/charts").then((m) => ({ default: m.Area as React.FC<PlotProps> })),
);
const BarPlot = lazy(() =>
  import("@ant-design/charts").then((m) => ({ default: m.Bar as React.FC<PlotProps> })),
);
const ScatterPlot = lazy(() =>
  import("@ant-design/charts").then((m) => ({ default: m.Scatter as React.FC<PlotProps> })),
);

export function ChartSkeleton({ height = 200 }: { height?: number }) {
  return (
    <div className="chart-loading" style={{ height }} role="status" aria-label="图表加载中">
      <div className="chart-skeleton" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
      <Spin size="small" />
    </div>
  );
}

function PlotFallback({ height }: { height: number }) {
  return <ChartSkeleton height={height} />;
}

export function TrendColumn(props: PlotProps) {
  return (
    <Suspense fallback={<PlotFallback height={Number(props.height ?? 200)} />}>
      <ColumnPlot {...withChartDefaults(props)} />
    </Suspense>
  );
}

export function TrendLine(props: PlotProps) {
  return (
    <Suspense fallback={<PlotFallback height={Number(props.height ?? 200)} />}>
      <LinePlot {...withChartDefaults(props)} />
    </Suspense>
  );
}

export function TrendArea(props: PlotProps) {
  return (
    <Suspense fallback={<PlotFallback height={Number(props.height ?? 200)} />}>
      <AreaPlot {...withChartDefaults(props)} />
    </Suspense>
  );
}

export function TrendBar(props: PlotProps) {
  return (
    <Suspense fallback={<PlotFallback height={Number(props.height ?? 200)} />}>
      <BarPlot {...withChartDefaults(props)} />
    </Suspense>
  );
}

export function TrendScatter(props: PlotProps) {
  return (
    <Suspense fallback={<PlotFallback height={Number(props.height ?? 200)} />}>
      <ScatterPlot {...withChartDefaults(props)} />
    </Suspense>
  );
}

/** 趋势卡片：标题 + 摘要 + 右侧附加控件（时间范围等），正文放图或空态。 */
export function TrendCard({
  title,
  summary,
  extra,
  children,
}: {
  title: string;
  summary?: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="chart-card">
      <header className="chart-card-head">
        <div>
          <h3>{title}</h3>
          {summary !== undefined && <p>{summary}</p>}
        </div>
        {extra}
      </header>
      {children}
    </section>
  );
}

/** 空数据占位：新装用户没有历史时给出期望，而不是空白坐标系。 */
export function ChartEmpty({ hint }: { hint: string }) {
  return <div className="empty-state chart-state" role="status">{hint}</div>;
}
