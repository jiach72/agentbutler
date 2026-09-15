/**
 * 侧栏底部的待处理审批卡片：显示 N 条待处理 + 一键「全部批准」。
 *
 * 批量批准（审批 UI 的批量操作）逐条走正常 decide 流程——批准/拒绝/超时
 * 全部进审计流与事件中心，一条不少。积压不用进审批页也能一次清掉。
 *
 * 数据与顶栏横幅同源（/api/approvals?status=pending&limit=1），一次请求拿列表统计。
 * 边界诚实：读不到数据时不显示待处理条数，不装作没有积压。
 */
import { useCallback, useEffect, useState } from "react";
import { App, Button, Popconfirm } from "antd";
import { usePolling } from "../hooks/usePolling.js";
import { loadJson, postJson } from "../lib/api.js";

interface ApprovalsPayload {
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
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void loadJson<ApprovalsPayload>("/api/approvals?status=pending&limit=1", 8_000).then((result) => {
      if (!result.ok) return;
      setPending(typeof result.data.summary?.pending === "number" ? result.data.summary.pending : 0);
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
      message.error("批量批准失败，请到审批页逐条处理");
      return;
    }
    const data = (result.data ?? {}) as BulkResult;
    const succeeded = data.succeeded ?? 0;
    const skipped = data.failed?.length ?? 0;
    message.success(
      skipped > 0
        ? `已批准 ${succeeded} 条，${skipped} 条跳过（已结算或已超时）`
        : `已批准 ${succeeded} 条`,
    );
    refresh();
  };

  if (pending === null || pending <= 0) return null;

  return (
    <div className="sidebar-approval-mode">
      <div className="sidebar-approval-mode-pending">
        <span>{pending} 条待处理</span>
        <Popconfirm
          title={`确认批准当前 ${pending} 条？`}
          description="已结算或已超时的条目会自动跳过。每条批准都会记入审计与事件中心。"
          okText="全部批准"
          cancelText="取消"
          onConfirm={() => void approveAll()}
        >
          <Button size="small" type="primary" loading={busy}>
            全部批准
          </Button>
        </Popconfirm>
      </div>
    </div>
  );
}
