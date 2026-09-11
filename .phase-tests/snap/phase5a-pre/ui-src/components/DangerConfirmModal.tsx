/**
 * 统一的危险操作确认层：基于 antd Modal（自带焦点圈禁、ESC、滚动锁）。
 *
 * 规范依据 docs/brand/03 §3.7「危险确认弹窗」——
 * **必填四项**：做了什么 / 影响范围 / 能否撤回 / 耗时。
 * 高危操作（清空、回滚、重置）额外要求**手动勾选确认框**。
 *
 * 设计取舍：
 *   · 影响、能否撤回、耗时做成**必填 prop**，缺一项就过不了类型检查 ——
 *     规范说"必填"，靠约定不如靠类型系统强制。
 *   · 确认按钮文案写具体动作（"确认清空"），不写"确定"。
 *   · 打开时焦点落在「取消」而不是确认键（§6 弹窗焦点管理）。
 */
import { ExclamationCircleFilled } from "@ant-design/icons";
import { Alert, Checkbox, Modal } from "antd";
import { useEffect, useState } from "react";

export interface DangerConfirmModalProps {
  open: boolean;
  /** 做了什么 —— 具体动作与对象，如「这会清空 128 条记忆」。 */
  title: string;
  /** 补充说明（可选），放在标题下的正文。 */
  children?: React.ReactNode;
  /** 影响范围（必填）：会发生什么。 */
  impact: React.ReactNode;
  /** 能否撤回（必填）：明确写清可否恢复、怎么恢复。 */
  reversible: React.ReactNode;
  /** 耗时（必填）：大概多久，期间是否不可用。 */
  duration: React.ReactNode;
  /** 执行步骤预告（可选）。 */
  steps?: string[];
  /**
   * 高危操作（清空 / 回滚 / 重置）必填：渲染手动勾选框，
   * 未勾选时确认按钮保持禁用，避免"一键即走"。
   */
  acknowledge?: string;
  /** 确认按钮文案，写具体动作而不是"确定"。 */
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
  reversible,
  duration,
  steps,
  acknowledge,
  confirmLabel,
  cancelLabel = "先不操作",
  busy = false,
  onCancel,
  onConfirm,
}: DangerConfirmModalProps) {
  const [acknowledged, setAcknowledged] = useState(false);

  // 每次打开都从"未勾选"开始，避免上一次的勾选被顺手带进来。
  useEffect(() => {
    if (open) setAcknowledged(false);
  }, [open]);

  const needAck = typeof acknowledge === "string" && acknowledge !== "";
  const blocked = busy || (needAck && !acknowledged);

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
      mask={{ closable: false }}
      keyboard={!busy}
      closable={!busy}
      width={560}
      centered
      okText={busy ? "正在执行…" : confirmLabel}
      cancelText={cancelLabel}
      okButtonProps={{ danger: true, disabled: blocked, loading: busy }}
      cancelButtonProps={{ disabled: busy, autoFocus: true }}
      onOk={() => {
        void onConfirm();
      }}
    >
      <div className="danger-modal-copy">{children}</div>

      {/* 必填四项之「影响范围」 */}
      <Alert
        className="danger-impact-alert"
        type="warning"
        showIcon
        title="影响说明"
        description={impact}
      />

      {/* 必填四项之「能否撤回」与「耗时」 */}
      <dl className="danger-facts">
        <dt>能否撤回</dt>
        <dd>{reversible}</dd>
        <dt>耗时</dt>
        <dd>{duration}</dd>
      </dl>

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

      {/* 高危操作：手动勾选确认 */}
      {needAck && (
        <div className="danger-acknowledge">
          <Checkbox
            checked={acknowledged}
            disabled={busy}
            onChange={(e) => setAcknowledged(e.target.checked)}
          >
            {acknowledge}
          </Checkbox>
        </div>
      )}
    </Modal>
  );
}
