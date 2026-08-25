import { useEffect, useId, useRef, type ReactNode } from "react";

export interface DangerConfirmModalProps {
  open: boolean;
  title: string;
  children: ReactNode;
  impact?: ReactNode;
  steps?: string[];
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}

/** 统一的危险操作确认层：确认前不触发任何外部副作用。 */
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
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        if (busy) return;
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])",
      );
      if (focusable === undefined || focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    requestAnimationFrame(() => confirmRef.current?.focus());
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, [busy, onCancel, open]);

  if (!open) return null;

  return (
    <div
      className="danger-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onClick={(event) => {
        if (!busy && event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="danger-modal-card" ref={dialogRef}>
        <div className="danger-modal-icon" aria-hidden="true">!</div>
        <h3 id={titleId}>{title}</h3>
        <div id={descriptionId}>
          <div className="danger-modal-copy">{children}</div>
          {impact !== undefined && <p className="danger-impact">{impact}</p>}
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
        </div>
        <div className="danger-modal-actions">
          <button type="button" className="btn btn-quiet" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={() => void onConfirm()}
          >
            {busy ? "正在执行…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
