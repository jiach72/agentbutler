/**
 * 实例状态卡片网格：实例概览 + 最近一次检查明细。
 */
import { useMemo } from "react";
import { StatusBadge } from "../../components/StatusBadge.js";
import { formatRelative } from "../../lib/format.js";
import {
  CHECK_LABELS,
  checkBadge,
  formatDetail,
  formatDuration,
  instanceLabel,
  instanceRuntimeLabel,
  instanceStateLabel,
  overallBadge,
  stateDotClass,
} from "./helpers.js";
import type { InstanceView, InspectionView } from "./types.js";

interface InstanceHealthCardProps {
  instances: InstanceView[];
  inspections: InspectionView[];
}

export function InstanceHealthCard({ instances, inspections }: InstanceHealthCardProps) {
  const inspectionByInstance = useMemo(
    () => new Map(inspections.map((item) => [item.instanceId, item])),
    [inspections],
  );

  if (instances.length === 0) {
    return (
      <div className="empty-state">
        还没有发现可管理的实例：管家检查完成后，这里会显示状态。
      </div>
    );
  }

  return (
    <div className="cards-grid">
      {instances.map((instance) => {
        const inspection = inspectionByInstance.get(instance.instanceId) ?? null;
        const overall = overallBadge(inspection?.overall ?? null);
        const confidence = inspection?.confidence ?? instance.confidence;
        return (
          <div className="card instance-card" key={instance.instanceId}>
            <div className="instance-title">
              <span className={`state-dot ${stateDotClass(instance.state)}`} />
              <span className="instance-name">{instanceLabel(instance.instanceId)}</span>
              <StatusBadge tone={overall.tone} label={overall.label} />
            </div>
            <div className="instance-meta">
              <span>{instanceStateLabel(instance.state)}</span>
              <span>{instanceRuntimeLabel(instance.runtime)}</span>
              <span>{instance.version ?? "版本未知"}</span>
              <span>把握 {Math.round((confidence ?? 0) * 100)}%</span>
            </div>
            <div className="card-head">
              上次检查：{formatRelative(inspection?.ts)}
              {inspection?.confidence !== null && inspection?.confidence !== undefined
                ? ` · 把握 ${Math.round(inspection.confidence * 100)}%`
                : ""}
            </div>
            {inspection === null ? (
              <div className="check-empty">尚无检查明细</div>
            ) : (
              <ul className="check-list">
                {inspection.checks.map((check) => {
                  const badge = checkBadge(check.status);
                  return (
                    <li className="check-row" key={check.id}>
                      <span className="check-name" title={check.id}>
                        {CHECK_LABELS[check.id] ?? "其他检查"}
                      </span>
                      <StatusBadge tone={badge.tone} label={badge.label} />
                      <span className="check-detail" title={formatDetail(check.detail)}>
                        {formatDetail(check.detail)}
                      </span>
                      <span className="check-duration">
                        {formatDuration(check.durationMs)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
