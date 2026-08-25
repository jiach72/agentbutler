import { useCallback, useEffect, useMemo, useState } from "react";
import { DangerConfirmModal } from "../components/DangerConfirmModal.js";
import { fetchJson, postJson } from "../lib/api.js";

interface SecurityBaselinePayload {
  listenHost: string;
  auth: boolean;
  warnings: string[];
}

interface AlertsPayload {
  reachable: boolean;
}

interface RunbookSummary {
  id: string;
  label: string;
  description: string;
  breakerTripped: boolean;
  lastRun?: { at: string; success: boolean };
}

interface RunbooksPayload {
  reachable: boolean;
  runbooks: RunbookSummary[];
}

interface InvariantView {
  id: string;
  title: string;
  status: "pass" | "warn" | "fail" | "unknown";
  detail: string;
  rule: string;
}

interface SecretFileView {
  rel: string;
  path: string;
  mode: string;
  secure: boolean;
  sizeBytes: number;
  modifiedAt: string;
}

interface SecurityPayload {
  watchReachable: boolean;
  checkedAt: string | null;
  invariants: InvariantView[];
  secrets: SecretFileView[];
  totalSecretFiles: number;
  insecureSecretFiles: number;
  message: string;
}

interface BackupItem {
  id: number;
  kind: "full" | "memory" | "event";
  label: string | null;
  target: string;
  path: string;
  sizeBytes: number;
  status: string;
  createdAt: string;
}

interface BackupsPayload {
  watchReachable: boolean;
  items: BackupItem[];
  status: null | {
    enabled: boolean;
    lastFullAt: string | null;
    lastMemoryAt: string | null;
    hourlyTickMs: number;
    retention?: { full: number; memory: number; event: number };
  };
}

interface ButlerSelfPayload {
  reachable: boolean;
  snapshots: Array<{ id: string; at: string; version: string; reason: string }>;
  snapshotRetention?: number;
}

interface AuditItem {
  id: number;
  ts: string;
  actor: string;
  action: string;
  target: string;
  detail: unknown;
}

interface AuditPayload {
  items: AuditItem[];
  degraded?: string[];
}

type SettingsConfirmAction =
  | { kind: "reset"; runbook: RunbookSummary }
  | { kind: "restore"; backup: BackupItem };

function snapshotStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    created: "已创建",
    completed: "已完成",
    restored: "已还原",
    reverted: "已回滚",
    pending: "等待中",
    failed: "失败",
    expired: "已过期",
    ok: "可用",
  };
  return labels[status] ?? "已记录";
}

function backupKindLabel(kind: BackupItem["kind"]): string {
  if (kind === "memory") return "记忆增量";
  if (kind === "event") return "操作前备份";
  return "每日全量";
}

const DEFAULT_BACKUP_RETENTION = { full: 14, memory: 24, event: 10 };
const DEFAULT_SNAPSHOT_RETENTION = 3;

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

const ACTOR_LABELS: Record<string, string> = {
  backup: "自动备份",
  runbook: "自动修复",
  upgrade: "版本更新",
  gateway: "消息设置",
  evolution: "进化守门",
  memory: "记忆管理",
  "butler-watch": "管家巡检",
  "butler-core": "管家内核",
  prompt: "提示词管理",
};

function actorLabel(actor: string): string {
  return ACTOR_LABELS[actor] ?? "管家";
}

function auditActionLabel(action: string): string {
  const labels: Record<string, string> = {
    "backup-full": "每日全量备份",
    "backup-memory": "记忆增量备份",
    "backup-event": "操作前自动备份",
    "backup-restore": "从备份还原",
    "runbook-start": "开始自动修复",
    "runbook-step": "修复步骤",
    "runbook-completed": "修复完成",
    "upgrade-start": "开始升级",
    "upgrade-done": "升级完成",
    "upgrade-failed": "升级失败",
    "upgrade-rollback": "升级回滚",
    "circuit-breaker-reset": "解除崩溃保护",
  };
  return labels[action] ?? action;
}

function invariantAggregate(invariants: InvariantView[]): { status: string; label: string } {
  if (invariants.length === 0) return { status: "partial", label: "建设中" };
  if (invariants.some((item) => item.status === "fail")) {
    return { status: "warn", label: "需处理" };
  }
  if (invariants.every((item) => item.status === "pass")) {
    return { status: "pass", label: "已满足" };
  }
  return { status: "partial", label: "部分核验" };
}

export function SettingsPage() {
  const [baseline, setBaseline] = useState<SecurityBaselinePayload | null>(null);
  const [alerts, setAlerts] = useState<AlertsPayload | null>(null);
  const [runbooks, setRunbooks] = useState<RunbooksPayload | null>(null);
  const [security, setSecurity] = useState<SecurityPayload | null>(null);
  const [backups, setBackups] = useState<BackupsPayload | null>(null);
  const [butlerSelf, setButlerSelf] = useState<ButlerSelfPayload | null>(null);
  const [audit, setAudit] = useState<AuditPayload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<SettingsConfirmAction | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const [diagnostic, setDiagnostic] = useState<{
    busy: boolean;
    text: string | null;
    error: string | null;
  }>({ busy: false, text: null, error: null });

  const refresh = useCallback(() => {
    let stopped = false;
    void Promise.all([
      fetchJson<SecurityBaselinePayload>("/api/security-baseline"),
      fetchJson<AlertsPayload>("/api/alerts"),
      fetchJson<RunbooksPayload>("/api/runbooks", 10_000),
      fetchJson<SecurityPayload>("/api/security", 10_000),
      fetchJson<BackupsPayload>("/api/backups", 10_000),
      fetchJson<ButlerSelfPayload>("/api/butler/self", 10_000),
      fetchJson<AuditPayload>("/api/audit", 10_000),
    ]).then(([nextBaseline, nextAlerts, nextRunbooks, nextSecurity, nextBackups, nextSelf, nextAudit]) => {
      if (stopped) return;
      setBaseline(nextBaseline);
      setAlerts(nextAlerts);
      setRunbooks(nextRunbooks);
      setSecurity(nextSecurity);
      setBackups(nextBackups);
      setButlerSelf(nextSelf);
      setAudit(nextAudit);
    });
    return () => {
      stopped = true;
    };
  }, []);

  useEffect(() => refresh(), [refresh]);

  const invariantAggregateItem = useMemo(
    () => invariantAggregate(security?.invariants ?? []),
    [security],
  );

  const backupStrategyOk = backups?.status?.lastFullAt !== undefined && backups?.status?.lastFullAt !== null;
  const backupRetention = backups?.status?.retention ?? DEFAULT_BACKUP_RETENTION;
  const snapshotRetention = butlerSelf?.snapshotRetention ?? DEFAULT_SNAPSHOT_RETENTION;
  const trippedRunbooks = useMemo(
    () => (runbooks?.runbooks ?? []).filter((item) => item.breakerTripped),
    [runbooks],
  );

  const baselineItems = useMemo(
    () => [
      {
        title: "只允许本机访问",
        status: baseline?.listenHost === "127.0.0.1" ? "pass" : "warn",
        detail: baseline === null ? "正在读取访问方式" : "只允许本机访问，局域网默认拒绝",
      },
      {
        title: "配置自动复核",
        status: invariantAggregateItem.status,
        detail:
          security === null
            ? "正在读取配置规则…"
            : security.watchReachable === false
              ? "管家服务暂时连不上，稍后再试"
              : security.invariants
                  .map((item) => `${item.title}：${item.status === "pass" ? "通过" : item.status === "warn" ? "需留意" : item.status === "fail" ? "未通过" : "未核验"}`)
                  .join("；"),
      },
      {
        title: "密钥文件保护",
        status:
          security === null ? "partial" : security.insecureSecretFiles === 0 ? "pass" : "warn",
        detail:
          security === null
            ? "正在检查密钥文件…"
            : security.insecureSecretFiles === 0
              ? `共检查 ${security.totalSecretFiles} 个密钥文件，权限都正常`
              : `有 ${security.insecureSecretFiles} 个密钥文件权限过宽，建议尽快改为仅本人可读`,
      },
      {
        title: "操作记录只增不改",
        status: audit === null ? "partial" : "pass",
        detail:
          audit === null
            ? "正在读取操作记录…"
            : `已保留 ${audit.items.length} 条操作记录，只记录不修改`,
      },
      {
        title: "自动备份",
        status: backupStrategyOk ? "pass" : "partial",
        detail: backupStrategyOk
          ? "每日全量 + 每小时记忆增量 + 升级/进化前自动备份"
          : "首次备份后自动开启每日全量与每小时记忆增量",
      },
      {
        title: "反复崩溃自动停下",
        status: runbooks === null ? "partial" : runbooks.reachable === false ? "warn" : trippedRunbooks.length === 0 ? "pass" : "warn",
        detail:
          runbooks === null
            ? "正在读取修复保护状态…"
            : runbooks.reachable === false
              ? "管家服务暂时连不上，无法确认熔断状态"
              : trippedRunbooks.length === 0
                ? "当前没有被暂停的自动修复方案"
                : `${trippedRunbooks.length} 个自动修复方案已暂停，需人工确认后解除`,
      },
    ],
    [baseline, security, audit, backupStrategyOk, invariantAggregateItem.status, runbooks, trippedRunbooks],
  );

  function requestResetBreaker(runbook: RunbookSummary) {
    if (busy !== null) return;
    setConfirmAction({ kind: "reset", runbook });
  }

  async function executeResetBreaker(runbook: RunbookSummary) {
    setBusy(`reset-${runbook.id}`);
    setToast(null);
    try {
      const result = await postJson(`/api/runbooks/${encodeURIComponent(runbook.id)}/reset`, {});
      if (result.ok) {
        setToast({ text: `已解除“${runbook.label}”的自动修复保护，并写入操作记录。`, kind: "ok" });
      } else if (result.status === 409) {
        setToast({ text: "这项保护已经解除，页面将刷新。", kind: "ok" });
      } else {
        setToast({ text: "解除保护失败，请先确认管家服务在线。", kind: "err" });
      }
      refresh();
    } catch {
      setToast({ text: "解除保护失败，请稍后再试。", kind: "err" });
    } finally {
      setBusy(null);
      setConfirmAction(null);
    }
  }

  async function runBackup(kind: "full" | "memory") {
    if (busy !== null) return;
    setBusy(kind);
    setToast(null);
    try {
      const result = await postJson("/api/backups", { kind, label: kind === "full" ? "手动全量备份" : "手动记忆备份" });
      if (result.ok) {
        setToast({ text: kind === "full" ? "全量备份完成。" : "记忆备份完成。", kind: "ok" });
      } else {
        setToast({ text: "备份没有执行，请查看提示后重试。", kind: "err" });
      }
      refresh();
    } catch {
      setToast({ text: "备份失败，请稍后再试。", kind: "err" });
    } finally {
      setBusy(null);
    }
  }

  function requestRestoreBackup(item: BackupItem) {
    if (busy !== null) return;
    setConfirmAction({ kind: "restore", backup: item });
  }

  async function executeRestoreBackup(item: BackupItem) {
    setBusy(`restore-${item.id}`);
    setToast(null);
    try {
      const result = await postJson(`/api/backups/${item.id}/restore`, {
        confirmed: true,
      });
      if (result.ok) {
        const data = (result.data ?? {}) as { restored?: number; skipped?: number };
        setToast({
          text: `还原完成：恢复 ${data.restored ?? 0} 个文件${(data.skipped ?? 0) > 0 ? `，跳过 ${data.skipped} 个运行中文件` : ""}。`,
          kind: "ok",
        });
      } else {
        setToast({ text: "还原未执行，请查看提示后重试。", kind: "err" });
      }
      refresh();
    } catch {
      setToast({ text: "还原失败，请稍后再试。", kind: "err" });
    } finally {
      setBusy(null);
      setConfirmAction(null);
    }
  }

  const restoreable = (item: BackupItem): boolean =>
    item.kind === "memory" || item.kind === "full";

  const runDiagnostic = async () => {
    if (diagnostic.busy) return;
    setDiagnostic({ busy: true, text: null, error: null });
    try {
      const res = await fetch("/api/diagnostics/report", {
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        setDiagnostic({ busy: false, text: null, error: "报告生成失败，请稍后再试。" });
        return;
      }
      const text = await res.text();
      setDiagnostic({ busy: false, text, error: null });
    } catch {
      setDiagnostic({ busy: false, text: null, error: "管家服务暂时连不上，请稍后再试。" });
    }
  };

  const downloadDiagnostic = (text: string) => {
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `agent-butler-diagnostic-${new Date().toISOString().slice(0, 10)}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="page product-page settings-page">
      <header className="page-heading product-heading">
        <div>
          <span className="product-eyebrow">安全设置</span>
          <h1>安全与设置</h1>
          <p className="hint">
            查看本机安全状态、告警方式和备份情况；未完成的能力会明确标注，不让你误以为已开启。
          </p>
        </div>
        <span className={`page-live ${security?.watchReachable !== false ? "is-online" : "is-offline"}`}>
          <i />
          {security?.watchReachable !== false ? "安全状态已读取" : "服务暂时连不上"}
        </span>
      </header>

      {toast !== null && (
        <div className={`toast ${toast.kind === "ok" ? "toast-ok" : "toast-err"}`} role="status">
          {toast.text}
        </div>
      )}

      {(baseline?.warnings.length ?? 0) > 0 && (
        <div className="settings-risk" role="status">
          <strong>当前风险提示</strong>
          <span>{baseline!.warnings.join("；")}</span>
        </div>
      )}

      <div className="settings-grid">
        <section className="settings-column card">
          <div className="settings-section-head">
            <div>
              <span className="product-kicker">本机安全</span>
              <h2>本机安全检查</h2>
            </div>
            <span className="badge-pill badge-muted">基础检查</span>
          </div>
          <div className="baseline-list">
            {baselineItems.map((item) => (
              <article className="baseline-row" key={item.title}>
                <i className={`baseline-dot is-${item.status}`} />
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.detail}</span>
                </div>
                <em>
                  {item.status === "pass"
                    ? "已满足"
                    : item.status === "warn"
                      ? "需注意"
                      : "建设中"}
                </em>
              </article>
            ))}
          </div>

          {security !== null && security.invariants.length > 0 && (
            <details className="advanced-details settings-advanced">
              <summary>查看配置规则详情</summary>
              <div className="advanced-details-body">
                {security.invariants.map((item) => (
                  <article className="invariant-row" key={item.id}>
                    <i className={`baseline-dot is-${item.status}`} />
                    <div>
                      <strong>{item.title}</strong>
                      <span>{item.detail}</span>
                    </div>
                    <em>
                      {item.status === "pass"
                        ? "通过"
                        : item.status === "warn"
                          ? "需留意"
                          : item.status === "fail"
                            ? "未通过"
                            : "未核验"}
                    </em>
                  </article>
                ))}
              </div>
            </details>
          )}

          {security !== null && security.secrets.length > 0 && (
            <details className="advanced-details settings-advanced">
              <summary>
                密钥文件权限（{security.insecureSecretFiles === 0 ? "全部正常" : `${security.insecureSecretFiles} 个需处理`}）
              </summary>
              <div className="advanced-details-body">
                <p className="hint">{security.message}</p>
                <ul className="secret-list">
                  {security.secrets.map((secret) => (
                    <li key={secret.rel}>
                      <code>{secret.rel}</code>
                      <span>
                        {secret.secure ? "权限正常" : "权限过宽"} · {secret.mode}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          )}

          <div className="settings-subsection">
            <div className="settings-section-head is-compact">
              <div>
                <span className="product-kicker">自动修复保护</span>
                <h2>反复失败时会停下</h2>
              </div>
              <span className={`badge-pill ${runbooks === null || runbooks.reachable === false ? "badge-muted" : trippedRunbooks.length === 0 ? "badge-healthy" : "badge-warning"}`}>
                {runbooks === null ? "读取中" : runbooks.reachable === false ? "服务离线" : trippedRunbooks.length === 0 ? "运行正常" : `${trippedRunbooks.length} 项已暂停`}
              </span>
            </div>
            {runbooks !== null && runbooks.reachable && trippedRunbooks.length === 0 && (
              <p className="hint">10 分钟内连续失败达到阈值时，管家会暂停对应自动修复，避免无限重启。</p>
            )}
            {runbooks !== null && !runbooks.reachable && (
              <p className="hint">管家服务暂时连不上，无法读取或解除自动修复保护。</p>
            )}
            {runbooks === null && <p className="hint">正在读取自动修复保护状态…</p>}
            {trippedRunbooks.map((runbook) => (
              <article className="route-row" key={runbook.id}>
                <span className="badge-pill badge-warning">已暂停</span>
                <div>
                  <strong>{runbook.label}</strong>
                  <span>{runbook.description || "连续失败后等待人工确认"}</span>
                </div>
                <button
                  className="btn btn-small"
                  disabled={busy !== null}
                  onClick={() => requestResetBreaker(runbook)}
                >
                  {busy === `reset-${runbook.id}` ? "解除中…" : "确认后解除"}
                </button>
              </article>
            ))}
          </div>

          <div className="settings-subsection">
            <div className="settings-section-head is-compact">
              <div>
                <span className="product-kicker">通知方式</span>
                <h2>消息不会悄悄丢掉</h2>
              </div>
            </div>
            <div className="route-row">
              <span className="badge-pill badge-muted">规则</span>
              <div>
                <strong>按当前消息通道发送</strong>
                <span>系统只使用当前通道，不设置备用通知链路</span>
              </div>
            </div>
            <div className="route-row">
              <span className="badge-pill badge-muted">当前</span>
              <div>
                <strong>{alerts?.reachable ? "通知服务在线" : "通知服务暂时连不上"}</strong>
                <span>{alerts?.reachable ? "当前消息通道可用" : "真实发送失败仍会保留记录"}</span>
              </div>
            </div>
          </div>
        </section>

        <section className="settings-column card">
          <div className="settings-section-head">
            <div>
              <span className="product-kicker">备份与还原</span>
              <h2>备份记录</h2>
            </div>
            <span
              className={`badge-pill ${(backups?.items.length ?? 0) > 0 ? "badge-healthy" : "badge-muted"}`}
            >
              {(backups?.items.length ?? 0)} 条
            </span>
          </div>

          <div className="backup-actions">
            <button
              className="btn btn-primary"
              disabled={busy !== null}
              onClick={() => void runBackup("full")}
            >
              {busy === "full" ? "备份中…" : "立即全量备份"}
            </button>
            <button
              className="btn"
              disabled={busy !== null}
              onClick={() => void runBackup("memory")}
            >
              {busy === "memory" ? "备份中…" : "备份记忆"}
            </button>
          </div>

          <div className="backup-policy" aria-label="备份保留策略">
            <div className="backup-policy-head">
              <div>
                <strong>保留策略</strong>
                <span>升级恢复点和日常备份分别计算，不共用同一个数量。</span>
              </div>
            </div>
            <div className="backup-policy-group">
              <div className="backup-policy-group-head">
                <strong>升级快照</strong>
                <span>最多 {snapshotRetention} 份</span>
              </div>
              <p>管家自身升级前创建，用于升级失败时自动回滚。</p>
              <div className="backup-policy-meta">
                <span>当前恢复点</span>
                <strong>
                  {butlerSelf === null
                    ? "读取中…"
                    : butlerSelf.reachable
                      ? `${butlerSelf.snapshots.length} / ${snapshotRetention} 份`
                      : "服务离线"}
                </strong>
              </div>
            </div>
            <div className="backup-policy-group">
              <div className="backup-policy-group-head">
                <strong>日常备份</strong>
                <span>按类型轮转</span>
              </div>
              <p>日常备份不会挤占升级快照；过期记录会自动标记并清理文件。</p>
              <div className="backup-policy-meta">
                <span>每日全量 · {backupRetention.full} 份</span>
                <span>记忆增量 · {backupRetention.memory} 份</span>
                <span>操作前 · {backupRetention.event} 份</span>
              </div>
            </div>
          </div>

          <div className="backup-timeline">
            {(backups?.items ?? []).slice(0, 8).map((item) => (
              <article className="backup-row" key={item.id}>
                <i />
                <div>
                  <strong>{item.label ?? backupKindLabel(item.kind)}</strong>
                  <span>
                    {backupKindLabel(item.kind)} · {formatTime(item.createdAt)} ·{" "}
                    {formatBytes(item.sizeBytes)}
                  </span>
                </div>
                <em>{snapshotStatusLabel(item.status)}</em>
                {restoreable(item) && (
                  <button
                    className="btn btn-small"
                    disabled={busy !== null}
                    onClick={() => requestRestoreBackup(item)}
                  >
                    {busy === `restore-${item.id}` ? "还原中…" : "还原"}
                  </button>
                )}
              </article>
            ))}
            {backups !== null && backups.items.length === 0 && (
              <div className="empty-state">
                还没有备份记录；点击「立即全量备份」开始第一次备份，之后管家每天自动备份。
              </div>
            )}
            {backups === null && <div className="empty-state">正在读取备份记录…</div>}
          </div>

          <div className="settings-subsection">
            <div className="settings-section-head is-compact">
              <div>
                <span className="product-kicker">诊断报告</span>
                <h2>一键生成诊断报告</h2>
              </div>
            </div>
            <p className="hint">
              打包脱敏的日志问题、错误指纹、巡检快照和配置摘要；不含密钥和聊天正文。
            </p>
            <div className="backup-actions">
              <button
                className="btn btn-primary"
                disabled={busy !== null || diagnostic.busy}
                onClick={() => void runDiagnostic()}
              >
                {diagnostic.busy ? "生成中…" : "生成诊断报告"}
              </button>
            </div>
            {diagnostic.error !== null && (
              <p className="diagnostic-error hint" role="status">
                {diagnostic.error}
              </p>
            )}
            {diagnostic.text !== null && (
              <details className="advanced-details settings-advanced" open>
                <summary>查看报告（可下载）</summary>
                <div className="advanced-details-body">
                  <pre className="diagnostic-preview">{diagnostic.text}</pre>
                  <button
                    className="btn btn-small"
                    onClick={() => downloadDiagnostic(diagnostic.text!)}
                  >
                    下载 Markdown
                  </button>
                </div>
              </details>
            )}
          </div>

          <div className="settings-subsection">
            <div className="settings-section-head is-compact">
              <div>
                <span className="product-kicker">操作记录</span>
                <h2>管家做过的操作</h2>
              </div>
            </div>
            <div className="audit-list">
              {(audit?.items ?? []).slice(0, 10).map((item) => (
                <article className="audit-row" key={item.id} title={item.target}>
                  <i />
                  <div>
                    <strong>
                      {actorLabel(item.actor)} · {auditActionLabel(item.action)}
                    </strong>
                    <span>{formatTime(item.ts)}</span>
                  </div>
                </article>
              ))}
              {audit !== null && audit.items.length === 0 && (
                <div className="empty-state">还没有操作记录；管家每次操作都会记在这里。</div>
              )}
              {audit === null && <div className="empty-state">正在读取操作记录…</div>}
            </div>
          </div>

          <div className="settings-boundary">
            <span>目前能做到</span>
            <p>
              本页展示的是真实的安全状态、备份和操作记录；完整密钥库和 26 条配置规则会在后续版本补上，不会提前显示成已开启。
            </p>
          </div>
        </section>
      </div>

      {confirmAction !== null && (
        <DangerConfirmModal
          open
          title={confirmAction.kind === "reset" ? "确认解除自动修复保护" : "确认还原备份"}
          busy={busy !== null}
          confirmLabel={confirmAction.kind === "reset" ? "确认解除保护" : "确认还原"}
          onCancel={() => {
            if (busy === null) setConfirmAction(null);
          }}
          onConfirm={() =>
            confirmAction.kind === "reset"
              ? executeResetBreaker(confirmAction.runbook)
              : executeRestoreBackup(confirmAction.backup)
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
              「{confirmAction.runbook.label}」已因连续失败暂停。请确认根因已经处理；解除后，管家会恢复该方案的自动执行资格。
            </p>
          ) : (
            <p>
              将还原「{confirmAction.backup.label ?? backupKindLabel(confirmAction.backup.kind)}」
              （{formatTime(confirmAction.backup.createdAt)}）到 {confirmAction.backup.target || "当前管家"}。
            </p>
          )}
          <p className="danger-impact">
            {confirmAction.kind === "reset"
              ? "如果根因尚未处理，自动修复可能再次重启或重连服务。"
              : "还原前会自动备份当前状态；运行中的 Hermes 文件可能被跳过，建议先停止 Hermes。"}
          </p>
        </DangerConfirmModal>
      )}
    </section>
  );
}
