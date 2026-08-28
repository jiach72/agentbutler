import { Link } from "react-router-dom";
import { Alert } from "antd";
import { DangerConfirmModal } from "../components/DangerConfirmModal.js";
import { RecoveryPanel } from "./dashboard/RecoveryPanel.js";
import { useRecoveryFlow } from "./dashboard/useRecoveryFlow.js";

export function RecoveryPage() {
  const recovery = useRecoveryFlow();
  return (
    <section className="page product-page recovery-page">
      <header className="page-heading product-heading">
        <div>
          <span className="product-eyebrow">诊断与分级修复</span>
          <h1>先找原因，再执行修复</h1>
          <p className="hint">修复动作按风险分级，执行期间会显示进度，完成后自动复验。</p>
        </div>
      </header>
      <Alert type="info" showIcon message="需要查看原始证据？" description={<Link to="/logs">前往系统日志执行修复建议</Link>} />
      <RecoveryPanel
        recovery={recovery.recovery}
        busy={recovery.busy}
        job={recovery.job}
        onDiagnose={() => void recovery.diagnose(false)}
        onExecute={(action) => void recovery.execute(action)}
        onRequestConfirm={recovery.requestConfirm}
      />
      <DangerConfirmModal
        open={recovery.confirmAction !== null}
        title={`确认执行「${recovery.confirmAction?.label ?? ""}」`}
        confirmLabel="确认执行"
        cancelLabel="取消"
        busy={recovery.busy}
        impact={recovery.confirmAction ? `影响：${recovery.confirmAction.impact}。预计耗时约 ${recovery.confirmAction.estimatedSeconds} 秒。` : undefined}
        onCancel={recovery.cancelConfirm}
        onConfirm={() => { const action = recovery.confirmAction; if (action) void recovery.execute(action); }}
      >
        {recovery.confirmAction?.description}
      </DangerConfirmModal>
    </section>
  );
}
