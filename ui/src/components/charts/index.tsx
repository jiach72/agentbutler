/**
 * 图表渲染出口：懒加载 @ant-design/charts 的具体图形（G2 v5），
 * 图表代码进入异步 chunk，不增加首屏包体；Suspense 占位与空态复用页面原语。
 */
import { Suspense, lazy } from "react";
import type { ReactNode } from "react";
import { Spin } from "antd";

/** G2 v5 的配置对象是开放式结构，这里以宽松 props 透传，具体字段见 chartTheme.ts。 */
type PlotProps = Record<string, unknown>;

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

function PlotFallback({ height }: { height: number }) {
  return (
    <div className="chart-loading" style={{ height }} aria-hidden="true">
      <Spin size="small" />
    </div>
  );
}

export function TrendColumn(props: PlotProps) {
  return (
    <Suspense fallback={<PlotFallback height={Number(props.height ?? 200)} />}>
      <ColumnPlot {...props} />
    </Suspense>
  );
}

export function TrendLine(props: PlotProps) {
  return (
    <Suspense fallback={<PlotFallback height={Number(props.height ?? 200)} />}>
      <LinePlot {...props} />
    </Suspense>
  );
}

export function TrendArea(props: PlotProps) {
  return (
    <Suspense fallback={<PlotFallback height={Number(props.height ?? 200)} />}>
      <AreaPlot {...props} />
    </Suspense>
  );
}

export function TrendBar(props: PlotProps) {
  return (
    <Suspense fallback={<PlotFallback height={Number(props.height ?? 200)} />}>
      <BarPlot {...props} />
    </Suspense>
  );
}

export function TrendScatter(props: PlotProps) {
  return (
    <Suspense fallback={<PlotFallback height={Number(props.height ?? 200)} />}>
      <ScatterPlot {...props} />
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
  return <div className="empty-state">{hint}</div>;
}
