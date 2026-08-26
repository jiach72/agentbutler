/**
 * 专业处理区：先诊断再按低/中/高风险分级修复；探针结果与动作卡片。
 */
import { Alert, Badge, Button, Card } from "antd";
import { StatusBadge } from "../../components/StatusBadge.js";
import { formatRelative } from "../../lib/format.js";
import { quickProbeBadge } from "./helpers.js";
import type { RecoveryActionView, RecoveryDiagnosisView } from "./types.js";

interface RecoveryPanelProps {
  recovery: RecoveryDiagnosisView | null;
  busy: boolean;
  onDiagnose: () => void;
  onExecute: (action: RecoveryActionView) => void;
  onRequestConfirm: (action: RecoveryActionView) => void;
}

export function RecoveryPanel({
  recovery,
  busy,
  onDiagnose,
  onExecute,
  onRequestConfirm,
}: RecoveryPanelProps) {
  return (
    <section className="recovery-panel" aria-live="polite">
      <div className="manager-section-head">
        <div>
          <span className="manager-section-kicker">专业处理</span>
          <h2>诊断与分级修复</h2>
        </div>
        <Button size="small" loading={busy} onClick={onDiagnose}>
          重新诊断
        </Button>
      </div>
      {recovery === null ? (
        <Alert
          type="info"
          showIcon
          message="先诊断再处理"
          description="系统会先确认根因，再按低、中、高风险给出动作；不会默认直接重启实例。"
        />
      ) : (
        <>
          <Alert
            type={recovery.severity === "error" ? "error" : recovery.severity === "warn" ? "warning" : "success"}
            showIcon
            message={recovery.rootCause}
            description={`诊断时间：${formatRelative(recovery.checkedAt)} · 事件 ${recovery.incidentId}`}
          />
          <div className="recovery-probes">
            {recovery.probes.map((probe) => {
              const badge = quickProbeBadge(probe.status);
              return (
                <StatusBadge
                  key={probe.id}
                  tone={badge.tone}
                  title={probe.detail}
                  label={`${probe.label}：${badge.label}`}
                />
              );
            })}
          </div>
          <div className="recovery-actions">
            {recovery.recommendedActions.map((action) => (
              <Card size="small" key={action.id} className="recovery-action-card">
                <div className="recovery-action-head">
                  <strong>{action.label}</strong>
                  <Badge status={action.risk === "high" ? "error" : action.risk === "medium" ? "warning" : "success"} text={action.risk === "high" ? "高风险" : action.risk === "medium" ? "需确认" : "低风险"} />
                </div>
                <p>{action.description}</p>
                <small>{action.impact} · 约 {action.estimatedSeconds} 秒</small>
                <Button
                  size="small"
                  type={action.risk === "high" ? "primary" : "default"}
                  danger={action.risk === "high"}
                  disabled={!action.available || busy}
                  onClick={() => (action.requiresConfirmation ? onRequestConfirm(action) : onExecute(action))}
                >
                  {!action.available ? action.unavailableReason ?? "暂不可用" : action.requiresConfirmation ? "确认执行" : "执行"}
                </Button>
              </Card>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
