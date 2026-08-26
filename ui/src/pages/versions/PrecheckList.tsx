/**
 * 版本页 · 升级前检查：结构化清单 / 纯文本明细 / 静态说明三种形态。
 */
import { StatusBadge } from "../../components/StatusBadge.js";
import { precheckBadge, STATIC_PRECHECKS, stepBadge } from "./helpers.js";
import type { PrecheckDetail, UpgradeStepView } from "./types.js";

interface PrecheckListProps {
  step: UpgradeStepView | null;
  precheck: PrecheckDetail;
}

export function PrecheckList({ step, precheck }: PrecheckListProps) {
  if (step !== null && precheck.items.length > 0) {
    return (
      <div className="card">
        <ul className="check-list">
          {precheck.items.map((item) => {
            const badge = precheckBadge(item.status);
            return (
              <li className="check-row" key={item.id}>
                <span className="check-name">{item.id}</span>
                <StatusBadge tone={badge.tone} label={badge.label} />
                <span className="check-detail" title={item.detail ?? undefined}>
                  {item.detail ?? "—"}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }
  if (step !== null && precheck.lines.length > 0) {
    return (
      <div className="card">
        <div className="hint">{precheck.lines.join("；")}</div>
      </div>
    );
  }
  if (step !== null) {
    return (
      <div className="card">
        <ul className="check-list">
          <li className="check-row">
            <span className="check-name">升级前检查</span>
            <StatusBadge
              tone={stepBadge(step.status).tone}
              label={stepBadge(step.status).label}
            />
            <span className="check-detail">暂未返回明细</span>
          </li>
        </ul>
      </div>
    );
  }
  return (
    <div className="card">
      <ul className="check-list">
        {STATIC_PRECHECKS.map((name) => (
          <li className="check-row" key={name}>
            <span className="check-name">{name}</span>
            <StatusBadge tone="muted" label="待检" />
          </li>
        ))}
      </ul>
      <div className="hint">不需要你手动操作；管家会在升级前自动检查。</div>
    </div>
  );
}
