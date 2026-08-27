/**
 * 设置页主编排：七路数据源逐源 FetchState（并行加载、独立降级与重试），
 * 30 秒轻量轮询让备份/审计在管家自动动作后出现；危险操作统一走确认弹窗。
 */
import { useCallback, useEffect, useState } from "react";
import { App, Tabs } from "antd";
import { DangerConfirmModal } from "../../components/DangerConfirmModal.js";
import { loadJson, postJson, type LoadResult } from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";
import { formatTime } from "../../lib/format.js";
import { AuditLog } from "./AuditLog.js";
import { BackupCenter } from "./BackupCenter.js";
import {
  backupKindLabel,
  createInitialSources,
  type AlertsPayload,
  type AuditPayload,
  type BackupItem,
  type BackupsPayload,
  type ButlerSelfPayload,
  type RunbookSummary,
  type RunbooksPayload,
  type SecurityBaselinePayload,
  type SecurityPayload,
  type SettingsConfirmAction,
  type SettingsSourceKey,
  SOURCE_KEYS,
  type SourcesState,
} from "./helpers.js";
import { DiagnosticsCenter } from "./DiagnosticsCenter.js";
import { SecurityBaseline } from "./SecurityBaseline.js";
import { PreferencesPanel } from "../preferences/PreferencesPage.js";

export function SettingsPage() {
  const { message } = App.useApp();
  const [sources, setSources] = useState(createInitialSources);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<SettingsConfirmAction | null>(null);
  const [activeTab, setActiveTab] = useState("security");

  const applyResult = useCallback((key: SettingsSourceKey, result: LoadResult<unknown>) => {
    setSources((prev) =>
      ({
        ...prev,
        [key]: result.ok
          ? { status: "ready", data: result.data }
          : { status: "failed", reason: result.reason },
      }) as SourcesState,
    );
  }, []);

  /** 七路数据源逐源请求：并行发起，各自记录 ready / failed。 */
  const loadOne = useCallback(
    async (key: SettingsSourceKey): Promise<void> => {
      switch (key) {
        case "baseline":
          applyResult(key, await loadJson<SecurityBaselinePayload>("/api/security-baseline", 5_000));
          break;
        case "alerts":
          applyResult(key, await loadJson<AlertsPayload>("/api/alerts", 5_000));
          break;
        case "runbooks":
          applyResult(key, await loadJson<RunbooksPayload>("/api/runbooks", 10_000));
          break;
        case "security":
          applyResult(key, await loadJson<SecurityPayload>("/api/security", 10_000));
          break;
        case "backups":
          applyResult(key, await loadJson<BackupsPayload>("/api/backups", 10_000));
          break;
        case "butlerSelf":
          applyResult(key, await loadJson<ButlerSelfPayload>("/api/butler/self", 10_000));
          break;
        case "audit":
          applyResult(key, await loadJson<AuditPayload>("/api/audit", 10_000));
          break;
      }
    },
    [applyResult],
  );

  /** 并行刷新全部数据源；已就绪的数据保持可见，不闪加载态。 */
  const refreshAll = useCallback(() => {
    for (const key of SOURCE_KEYS) void loadOne(key);
  }, [loadOne]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  // 轻量轮询：备份/审计在管家自动动作后能自动出现（后台标签页暂停）。
  usePolling(refreshAll, 30_000);

  /** 单源重试：先把该源切回 loading，再重新请求。 */
  const retrySource = useCallback(
    (key: SettingsSourceKey) => {
      setSources((prev) => ({ ...prev, [key]: { status: "loading" } }) as SourcesState);
      void loadOne(key);
    },
    [loadOne],
  );

  function requestResetBreaker(runbook: RunbookSummary) {
    if (busy !== null) return;
    setConfirmAction({ kind: "reset", runbook });
  }

  async function executeResetBreaker(runbook: RunbookSummary) {
    setBusy(`reset-${runbook.id}`);
    try {
      const result = await postJson(`/api/runbooks/${encodeURIComponent(runbook.id)}/reset`, {});
      if (result.ok) {
        message.success(`已解除“${runbook.label}”的自动修复保护，并写入操作记录。`);
      } else if (result.status === 409) {
        message.success("这项保护已经解除，页面将刷新。");
      } else {
        message.error("解除保护失败，请先确认管家服务在线。");
      }
      refreshAll();
    } catch {
      message.error("解除保护失败，请稍后再试。");
    } finally {
      setBusy(null);
      setConfirmAction(null);
    }
  }

  function onRunBackup(kind: "full" | "memory") {
    if (busy !== null) return;
    void executeRunBackup(kind);
  }

  async function executeRunBackup(kind: "full" | "memory") {
    setBusy(kind);
    try {
      const result = await postJson("/api/backups", {
        kind,
        label: kind === "full" ? "手动全量备份" : "手动记忆备份",
      });
      if (result.ok) {
        message.success(kind === "full" ? "全量备份完成。" : "记忆备份完成。");
      } else {
        message.error("备份没有执行，请查看提示后重试。");
      }
      refreshAll();
    } catch {
      message.error("备份失败，请稍后再试。");
    } finally {
      setBusy(null);
    }
  }

  function onRequestRestore(item: BackupItem) {
    if (busy !== null) return;
    setConfirmAction({ kind: "restore", backup: item });
  }

  async function executeRestoreBackup(item: BackupItem) {
    setBusy(`restore-${item.id}`);
    try {
      const result = await postJson(`/api/backups/${item.id}/restore`, {
        confirmed: true,
      });
      if (result.ok) {
        const data = (result.data ?? {}) as { restored?: number; skipped?: number };
        message.success(
          `还原完成：恢复 ${data.restored ?? 0} 个文件${
            (data.skipped ?? 0) > 0 ? `，跳过 ${data.skipped} 个运行中文件` : ""
          }。`,
        );
      } else {
        message.error("还原未执行，请查看提示后重试。");
      }
      refreshAll();
    } catch {
      message.error("还原失败，请稍后再试。");
    } finally {
      setBusy(null);
      setConfirmAction(null);
    }
  }

  const securityOnline = sources.security.status === "ready"
    ? sources.security.data.watchReachable !== false
    : true;

  return (
    <section className="page product-page settings-page">
      <header className="page-heading product-heading">
        <div>
          <span className="product-eyebrow">应用设置</span>
          <h1>设置</h1>
          <p className="hint">
            管理本机安全、备份与还原、诊断报告，以及界面和通知偏好。
          </p>
        </div>
        <span className={`page-live ${securityOnline ? "is-online" : "is-offline"}`}>
          <i />
          {securityOnline ? "安全状态已读取" : "服务暂时连不上"}
        </span>
      </header>

      <Tabs
        className="settings-tabs"
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: "security",
            label: "本机安全",
            children: (
              <section className="settings-tab-panel">
                {sources.baseline.status === "ready" && sources.baseline.data.warnings.length > 0 && (
                  <div className="settings-risk" role="status">
                    <strong>当前风险提示</strong>
                    <span>{sources.baseline.data.warnings.join("；")}</span>
                  </div>
                )}
                <SecurityBaseline
                  baseline={sources.baseline}
                  alerts={sources.alerts}
                  runbooks={sources.runbooks}
                  security={sources.security}
                  audit={sources.audit}
                  backups={sources.backups}
                  busy={busy}
                  onRetry={retrySource}
                  onRequestReset={requestResetBreaker}
                />
              </section>
            ),
          },
          {
            key: "backups",
            label: "备份与还原",
            children: (
              <section className="settings-tab-panel">
                <BackupCenter
                  backups={sources.backups}
                  butlerSelf={sources.butlerSelf}
                  busy={busy}
                  onRetry={retrySource}
                  onRunBackup={onRunBackup}
                  onRequestRestore={onRequestRestore}
                />
              </section>
            ),
          },
          {
            key: "diagnostics",
            label: "诊断报告",
            children: (
              <section className="settings-tab-panel">
                <DiagnosticsCenter actionBusy={busy !== null} />
                <AuditLog audit={sources.audit} onRetry={() => retrySource("audit")} />
                <div className="settings-boundary">
                  <span>目前能做到</span>
                  <p>
                    本页展示的是真实的安全状态、备份和操作记录；完整密钥库和 26
                    条配置规则会在后续版本补上，不会提前显示成已开启。
                  </p>
                </div>
              </section>
            ),
          },
          {
            key: "preferences",
            label: "常规偏好",
            children: (
              <section className="settings-tab-panel">
                <PreferencesPanel />
              </section>
            ),
          },
        ]}
      />

      {confirmAction !== null && (
        <DangerConfirmModal
          open
          title={confirmAction.kind === "reset" ? "确认解除自动修复保护" : "确认还原备份"}
          busy={busy !== null}
          confirmLabel={confirmAction.kind === "reset" ? "确认解除保护" : "确认还原"}
          onCancel={() => setConfirmAction(null)}
          onConfirm={() =>
            confirmAction.kind === "reset"
              ? executeResetBreaker(confirmAction.runbook)
              : executeRestoreBackup(confirmAction.backup)
          }
          impact={
            confirmAction.kind === "reset"
              ? "如果根因尚未处理，自动修复可能再次重启或重连服务。"
              : "还原前会自动备份当前状态；运行中的 Hermes 文件可能被跳过，建议先停止 Hermes。"
          }
          steps={
            confirmAction.kind === "reset"
              ? [
                  "解除该自动修复方案的熔断状态",
                  "允许后续巡检再次触发它",
                  "继续记录执行结果，失败时仍会再次暂停",
                ]
              : [
                  "先为当前状态创建一份操作前备份",
                  "还原选中的备份文件",
                  "刷新安全状态和操作记录",
                ]
          }
        >
          {confirmAction.kind === "reset" ? (
            <p>
              「{confirmAction.runbook.label}
              」已因连续失败暂停。请确认根因已经处理；解除后，管家会恢复该方案的自动执行资格。
            </p>
          ) : (
            <p>
              将还原「
              {confirmAction.backup.label ?? backupKindLabel(confirmAction.backup.kind)}」（
              {formatTime(confirmAction.backup.createdAt)}）到{" "}
              {confirmAction.backup.target || "当前管家"}。
            </p>
          )}
        </DangerConfirmModal>
      )}
    </section>
  );
}
