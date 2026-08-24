import type { CSSProperties } from "react";

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
  const style = { "--page-progress-value": `${percent}%` } as CSSProperties;

  return (
    <section
      className={`page-progress${compact ? " is-compact" : ""}${indeterminate ? " is-indeterminate" : ""}`}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="page-progress-copy">
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <div
        className="page-progress-track"
        role="progressbar"
        aria-label={title}
        {...(indeterminate
          ? {}
          : { "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": percent })}
        style={style}
      >
        <i />
      </div>
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
