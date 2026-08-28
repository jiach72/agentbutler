import { Link } from "react-router-dom";
import { Alert } from "antd";
import { useEffect, useRef } from "react";
import { DangerConfirmModal } from "../components/DangerConfirmModal.js";
import { RecoveryPanel } from "./dashboard/RecoveryPanel.js";
import { useRecoveryFlow } from "./dashboard/useRecoveryFlow.js";

export function RecoveryPage() {
  const recovery = useRecoveryFlow();
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void recovery.diagnose(false);
  }, [recovery.diagnose]);
  return (
    <section className="page product-page recovery-page">
      <header className="page-heading product-heading">
        <div>
          <span className="product-eyebrow">诊断与修复</span>
          <h1>诊断结果</h1>
          <p className="hint">查看检查结果、问题依据和可执行处理。</p>
        </div>
      </header>
      <Alert type="info" showIcon message="查看日志依据" description={<Link to="/logs">打开系统日志</Link>} />
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
