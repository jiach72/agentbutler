import { useEffect, useRef } from "react";
import { Flex } from "antd";
import { PageHeader } from "../components/PageHeader.js";
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
    <section className="recovery-page">
      <Flex vertical gap={24}>
        <PageHeader eyebrow="诊断与修复" title="诊断结果" description="查看当前检查结果和可执行处理。" />
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
      </Flex>
    </section>
  );
}
