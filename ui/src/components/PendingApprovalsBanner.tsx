/**
 * 全局待审批横幅（评审：操作审批不用进页面才能看到）。
 *
 * 有待处理的操作审批时，在顶栏下方常驻一条可点击横幅：数量 + 直达入口。
 * - 30s 轮询 /api/approvals（与审批列表同源，15s 太密、60s 会漏掉短时限单）；
 * - 审批页本身不显示（避免同屏两份入口）；
 * - 点「知道了」只在本次会话内隐藏，直到待处理数量变化再次出现。
 */
import { Alert, Button } from "antd";
import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { loadJson } from "../lib/api.js";
import { usePolling } from "../hooks/usePolling.js";

interface PendingPayload {
  summary: { pending: number };
}

export function PendingApprovalsBanner() {
  const location = useLocation();
  const [pending, setPending] = useState<number | null>(null);
  const [dismissedCount, setDismissedCount] = useState<number | null>(null);

  const refresh = useCallback(() => {
    void loadJson<PendingPayload>("/api/approvals?status=pending&limit=1", 8_000).then((result) => {
      if (result.ok) setPending(result.data.summary.pending);
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);
  usePolling(refresh, 30_000);

  // 审批页自身已有完整入口，不再叠加横幅。
  if (location.pathname.startsWith("/approvals")) return null;
  if (pending === null || pending <= 0) return null;
  if (dismissedCount === pending) return null;

  return (
    <Alert
      className="pending-approvals-banner"
      type="warning"
      showIcon
      message={
        <span>
          有 <strong>{pending}</strong> 条高危操作等待你批准或拒绝（超时将按拒绝拦截）。
        </span>
      }
      action={
        <span style={{ display: "flex", gap: 8 }}>
          <Link to="/approvals">
            <Button size="small" type="primary">
              去处理
            </Button>
          </Link>
          <Button size="small" type="text" onClick={() => setDismissedCount(pending)}>
            知道了
          </Button>
        </span>
      }
    />
  );
}
