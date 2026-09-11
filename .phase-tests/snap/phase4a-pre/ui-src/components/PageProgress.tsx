/**
 * 页面级进度反馈：进度条用 antd Progress（含 active 状态的不确定动画），
 * 步骤列表保持轻量圆点行（语义色随主题变量）。
 */
import { Progress } from "antd";

export type PageProgressStepState = "done" | "active" | "pending" | "failed";

export interface PageProgressStep {
  label: string;
  state: PageProgressStepState;
}

interface PageProgressProps {
  title: string;
  detail: string;
  steps?: PageProgressStep[];
  indeterminate?: boolean;
  compact?: boolean;
}

export function PageProgress({
  title,
  detail,
  steps = [],
  indeterminate = false,
  compact = false,
}: PageProgressProps) {
  const completed = steps.filter((step) => step.state === "done").length;
  const hasActive = steps.some((step) => step.state === "active");
  const percent =
    steps.length === 0
      ? 0
      : Math.min(100, Math.round(((completed + (hasActive ? 0.5 : 0)) / steps.length) * 100));

  return (
    <section
      className={`page-progress${compact ? " is-compact" : ""}`}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="page-progress-copy">
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <Progress
        percent={indeterminate ? 50 : percent}
        showInfo={false}
        size={["100%", 6]}
        status={indeterminate ? "active" : "normal"}
      />
      {steps.length > 0 && (
        <ol className="page-progress-steps">
          {steps.map((step) => (
            <li className={`is-${step.state}`} key={step.label}>
              <i aria-hidden="true" />
              <span>{step.label}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
