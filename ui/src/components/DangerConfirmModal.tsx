/**
 * 统一的危险操作确认层：基于 antd Modal（自带焦点圈禁、ESC、滚动锁），
 * 叠加影响说明与执行步骤预告；确认前不触发任何外部副作用。
 */
import { ExclamationCircleFilled } from "@ant-design/icons";
import { Alert, Modal } from "antd";

export interface DangerConfirmModalProps {
  open: boolean;
  title: string;
  children: React.ReactNode;
  impact?: React.ReactNode;
  steps?: string[];
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}

export function DangerConfirmModal({
  open,
  title,
  children,
  impact,
  steps,
  confirmLabel,
  cancelLabel = "先不操作",
  busy = false,
  onCancel,
  onConfirm,
}: DangerConfirmModalProps) {
  return (
    <Modal
      open={open}
      title={
        <span className="danger-modal-title">
          <ExclamationCircleFilled aria-hidden="true" /> {title}
        </span>
      }
      onCancel={() => {
        if (!busy) onCancel();
      }}
      maskClosable={false}
      keyboard={!busy}
      closable={!busy}
      width={560}
      centered
      okText={busy ? "正在执行…" : confirmLabel}
      cancelText={cancelLabel}
      okButtonProps={{ danger: true, disabled: busy, loading: busy }}
      cancelButtonProps={{ disabled: busy }}
      onOk={() => {
        void onConfirm();
      }}
    >
      <div className="danger-modal-copy">{children}</div>
      {impact !== undefined && (
        <Alert
          className="danger-impact-alert"
          type="warning"
          showIcon
          message="影响说明"
          description={impact}
        />
      )}
      {steps !== undefined && steps.length > 0 && (
        <div className="repair-steps">
          <span>管家会按顺序执行：</span>
          <ol>
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      )}
    </Modal>
  );
}
