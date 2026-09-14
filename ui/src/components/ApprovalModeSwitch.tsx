/**
 * 侧栏底部的放行模式开关（客户诉求：「同样的操作要一条条处理」）。
 *
 * 两种模式：
 * · 逐条确认（ask，默认）：每条高危动作都开单、推卡片、等你应答；
 * · 全部允许（allow-all）：自动放行，不再打断你，但**审计、事件中心、审批单
 *   一条都不少**——不打扰，不等于不留痕。
 *
 * 顺带把「当前待处理 N 条 → 全部批准」放在同一处：积压不用进审批页也能一次清掉。
 * 数据与顶栏横幅同源（/api/approvals?status=pending&limit=1），这里顺带读服务端
 * 返回的 mode，一次请求拿列表统计与模式，不多发。
 *
 * 边界诚实：读不到模式时不显示开关的勾选态也不谎称安全，只显示"读取中"。
 */
import { CheckCircleOutlined, ExclamationCircleFilled } from "@ant-design/icons";
import { App, Button, Popconfirm, Switch } from "antd";
import { useCallback, useEffect, useState } from "react";
import { usePolling } from "../hooks/usePolling.js";
import { loadJson, postJson, putJson } from "../lib/api.js";

type ApprovalMode = "ask" | "allow-all";

interface ApprovalsPayload {
  summary?: { pending?: number };
  mode?: ApprovalMode;
}

interface BulkResult {
  total?: number;
  succeeded?: number;
  failed?: Array<{ id: string; reason: string }>;
}

const MODE_LABEL: Record<ApprovalMode, string> = {
  ask: "逐条确认",
  "allow-all": "全部允许",
};

const MODE_NOTE: Record<ApprovalMode, string> = {
  ask: "每条高危动作都会问你一次",
  "allow-all": "自动放行，每条仍记入审计与事件中心",
};

export function ApprovalModeSwitch() {
  const { message } = App.useApp();
  const [mode, setMode] = useState<ApprovalMode | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void loadJson<ApprovalsPayload>("/api/approvals?status=pending&limit=1", 8_000).then((result) => {
      if (!result.ok) return;
      setPending(typeof result.data.summary?.pending === "number" ? result.data.summary.pending : 0);
      const next = result.data.mode;
      // 未知/缺失一律按逐条确认处理：宁可多问一次，也不擅自放行。
      setMode(next === "allow-all" ? "allow-all" : "ask");
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);
  usePolling(refresh, 30_000);

  const allowAll = mode === "allow-all";

  const switchMode = async (next: ApprovalMode): Promise<void> => {
    setBusy(true);
    const result = await putJson("/api/approvals/mode", { mode: next }, 8_000);
    setBusy(false);
    if (!result.ok) {
      message.error("切换失败，请稍后重试");
      return;
    }
    setMode(next);
    message.success(
      next === "allow-all"
        ? "已切到全部允许：高危动作会自动放行，审计与事件中心照常记录"
        : "已切回逐条确认：每条高危动作都会问你一次",
    );
    refresh();
  };

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

  return (
    <div className={`sidebar-approval-mode${allowAll ? " is-warn" : ""}`}>
      <div className="sidebar-approval-mode-head">
        <span className="sidebar-approval-mode-icon" aria-hidden="true">
          {allowAll ? <ExclamationCircleFilled /> : <CheckCircleOutlined />}
        </span>
        <span className="sidebar-approval-mode-copy">
          <span className="sidebar-approval-mode-title">
            高危动作
            <small>{mode === null ? "读取中" : MODE_LABEL[mode]}</small>
          </span>
        </span>
        {/* 开（切到全部允许）要二次确认；关（切回逐条确认）是更安全方向，直接生效。 */}
        <Popconfirm
          title="切到全部允许？"
          description="之后每条高危动作都会自动放行，不再逐条问你。动作照常记入审计与事件中心，事后可以逐条查。"
          okText="切到全部允许"
          cancelText="取消"
          disabled={allowAll || mode === null}
          onConfirm={() => void switchMode("allow-all")}
        >
          <Switch
            size="small"
            checked={allowAll}
            loading={busy}
            disabled={mode === null}
            aria-label="全部允许模式"
            onChange={(checked) => {
              // 开启交给 Popconfirm 确认；这里只处理关闭。
              if (!checked) void switchMode("ask");
            }}
          />
        </Popconfirm>
      </div>
      <p className="sidebar-approval-mode-note">
        {mode === null ? "正在读取放行模式" : MODE_NOTE[mode]}
      </p>
      {pending !== null && pending > 0 && (
        <div className="sidebar-approval-mode-pending">
          <span>{pending} 条待处理</span>
          <Popconfirm
            title={`确认批准当前 ${pending} 条？`}
            description="已结算或已超时的条目会自动跳过。"
            okText="全部批准"
            cancelText="取消"
            onConfirm={() => void approveAll()}
          >
            <Button size="small" type="primary" loading={busy}>
              全部批准
            </Button>
          </Popconfirm>
        </div>
      )}
    </div>
  );
}
