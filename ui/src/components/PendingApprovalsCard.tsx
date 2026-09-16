/**
 * 侧栏底部的待处理审批卡片：显示 N 条待处理 + 一键「全部已知 / 全部放行」。
 *
 * 批量处理逐条走正常 decide 流程——批准/拒绝/超时
 * 全部进审计流与事件中心，一条不少。积压不用进审批页也能一次清掉。
 *
 * 区分事前放行（待放行/全部放行）与事后核验（待核验/全部已知）。
 */
import { useCallback, useEffect, useState } from "react";
import { App, Button, Popconfirm } from "antd";
import { usePolling } from "../hooks/usePolling.js";
import { loadJson, postJson } from "../lib/api.js";
import { isAuditApproval } from "../pages/approvals/helpers.js";

interface ApprovalsPayload {
  items?: Array<{ id: string; detail?: unknown }>;
  summary?: { pending?: number };
}

interface BulkResult {
  total?: number;
  succeeded?: number;
  failed?: Array<{ id: string; reason: string }>;
}

export function PendingApprovalsCard() {
  const { message } = App.useApp();
  const [pending, setPending] = useState<number | null>(null);
  const [hasGate, setHasGate] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void loadJson<ApprovalsPayload>("/api/approvals?status=pending&limit=20", 8_000).then((result) => {
      if (!result.ok) return;
      const count = typeof result.data.summary?.pending === "number" ? result.data.summary.pending : 0;
      setPending(count);
      const items = result.data.items ?? [];
      setHasGate(items.some((it) => !isAuditApproval(it)));
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);
  usePolling(refresh, 30_000);

  const approveAll = async (): Promise<void> => {
    setBusy(true);
    const result = await postJson("/api/approvals/bulk-decide", { all: true, decision: "approve" }, 15_000);
    setBusy(false);
    if (!result.ok) {
      message.error(hasGate ? "批量放行失败，请到审批页处理" : "批量确认失败，请到审批页处理");
      return;
    }
    const data = (result.data ?? {}) as BulkResult;
    const succeeded = data.succeeded ?? 0;
    const skipped = data.failed?.length ?? 0;
    message.success(
      skipped > 0
        ? hasGate
          ? `已批量放行 ${succeeded} 条，${skipped} 条跳过（已结算或已超时）`
          : `已批量确认 ${succeeded} 条为已知，${skipped} 条跳过（已结算或已超时）`
        : hasGate
          ? `已批量放行 ${succeeded} 条动作`
          : `已批量确认 ${succeeded} 条异动为已知`,
    );
    refresh();
  };

  if (pending === null || pending <= 0) return null;

  return (
    <div className="sidebar-approval-mode">
      <div className="sidebar-approval-mode-pending">
        <span>{pending} 条{hasGate ? "待放行" : "待核验"}</span>
        <Popconfirm
          title={hasGate ? `确认全部放行当前 ${pending} 条动作？` : `确认将当前 ${pending} 条异动全部标记为已知？`}
          description={
            hasGate
              ? "将放行处于阻塞等待中的动作。已结算或超时的条目会自动跳过。"
              : "动作已由 Hermes 执行，点击全部已知将这些异动确认归档并记入审计。已结算或超时的条目会自动跳过。"
          }
          okText={hasGate ? "全部放行" : "全部已知"}
          cancelText="取消"
          onConfirm={() => void approveAll()}
        >
          <Button size="small" type="primary" loading={busy}>
            {hasGate ? "全部放行" : "全部已知"}
          </Button>
        </Popconfirm>
      </div>
    </div>
  );
}
