/**
 * 系统日志面板：只读查看日志文件、错误聚合与处理建议。
 * 面板自身的加载/分析/修复确认状态全部内聚在本组件内。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { App, Button, Progress } from "antd";
import { DangerConfirmModal } from "../../components/DangerConfirmModal.js";
import { fetchJson, loadJson, postJson } from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";
import { formatBytes, formatNumber } from "../../lib/format.js";
import type { LogAnalyzeView, LogIssueView, LogSourceView, LogTailView } from "./types.js";

interface LogPanelProps {
  open?: boolean;
  onClose?: () => void;
  embedded?: boolean;
}

export function LogPanel({ open = true, onClose = () => undefined, embedded = false }: LogPanelProps) {
  const { message } = App.useApp();
  const [sources, setSources] = useState<LogSourceView[]>([]);
  const [activeLog, setActiveLog] = useState<LogTailView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<LogIssueView[]>([]);
  const [analyzeLoading, setAnalyzeLoading] = useState(false);
  const [confirmFix, setConfirmFix] = useState<LogIssueView | null>(null);
  const [fixBusy, setFixBusy] = useState(false);
  const [fixJob, setFixJob] = useState<{ jobId: string; progress: number; status: string; detail: string; label: string } | null>(null);
  const recheckTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  usePolling(async () => {
    if (fixJob === null || fixJob.status !== "running") return;
    const result = await loadJson<{ jobId: string; progress: number; status: string; detail: string; label: string }>(`/api/logs/fix/${encodeURIComponent(fixJob.jobId)}`, 8_000);
    if (result.ok) {
      setFixJob(result.data);
      if (result.data.status === "done") message.success(`「${result.data.label}」执行完成，正在复检`);
      if (result.data.status === "failed") message.error(`修复未完成：${result.data.detail}`);
    }
  }, fixJob?.status === "running" ? 1000 : null);

  const loadLogTail = useCallback(async (sourceId: string, before?: number | null) => {
    setLoading(true);
    setError(null);
    setActiveLog((current) => (current !== null && current.sourceId !== sourceId ? null : current));
    const query = new URLSearchParams({ limit: "300" });
    if (before !== undefined && before !== null) query.set("before", String(before));
    const payload = await fetchJson<LogTailView>(
      `/api/logs/${encodeURIComponent(sourceId)}?${query.toString()}`,
      8_000,
    );
    if (payload === null) {
      setError("读取日志失败；管家服务可能暂时不可用。");
    } else {
      setActiveLog(payload);
    }
    setLoading(false);
  }, []);

  const loadLogAnalyze = useCallback(async () => {
    setAnalyzeLoading(true);
    const payload = await fetchJson<LogAnalyzeView>("/api/logs/analyze", 8_000);
    setIssues(payload?.issues ?? []);
    setAnalyzeLoading(false);
  }, []);

  // 打开时拉取来源与体检结果；关闭时清空阅读态并撤销未触发的复检。
  useEffect(() => {
    if (!open) {
      setActiveLog(null);
      setError(null);
      if (recheckTimer.current !== undefined) clearTimeout(recheckTimer.current);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void loadLogAnalyze();
    void (async () => {
      const payload = await fetchJson<{ reachable: boolean; sources?: LogSourceView[] }>(
        "/api/logs",
        8_000,
      );
      if (cancelled) return;
      if (payload === null || payload.reachable !== true) {
        setSources([]);
        setError("管家服务暂时连不上，稍后再试。");
      } else {
        setSources(payload.sources ?? []);
        if ((payload.sources ?? []).length === 0) {
          setError("暂未发现日志文件。");
        }
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, loadLogAnalyze]);

  useEffect(
    () => () => {
      if (recheckTimer.current !== undefined) clearTimeout(recheckTimer.current);
    },
    [],
  );

  const runLogFix = async () => {
    if (confirmFix === null || confirmFix.suggestedAction === null) return;
    setFixBusy(true);
    const result = await postJson("/api/logs/fix", {
      action: confirmFix.suggestedAction,
      confirmed: true,
    });
    setFixBusy(false);
    setConfirmFix(null);
    if (result.ok) {
      const payload = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
      if (typeof payload.jobId === "string") setFixJob({ jobId: payload.jobId, progress: 8, status: "running", detail: "已确认，正在准备执行", label: confirmFix.actionLabel ?? "修复服务" });
      message.success(`修复已开始：${confirmFix.actionLabel ?? "重启服务"}。可在进度条中查看执行状态。`);
      if (recheckTimer.current !== undefined) clearTimeout(recheckTimer.current);
      recheckTimer.current = setTimeout(() => void loadLogAnalyze(), 10_000);
    } else if (result.status === 409) {
      message.error("修复暂时被保护机制拦住（熔断），稍后再试。");
    } else {
      message.error("修复没有启动成功，请确认 Hermes 实例是否在线。");
    }
  };

  return (
    <>
      {open && (
        <div
          className={embedded ? "log-page-shell" : "log-drawer-backdrop"}
          role={embedded ? undefined : "dialog"}
          aria-modal={embedded ? undefined : true}
          aria-labelledby="log-drawer-title"
          onClick={(event) => {
            if (embedded) return;
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <div className={embedded ? "log-page-shell-inner" : "log-drawer"}>
            <div className="log-drawer-head">
              <div>
                <span className="log-drawer-eyebrow">只读查看</span>
                <h3 id="log-drawer-title">系统日志</h3>
              </div>
              {!embedded && <Button type="text" size="small" onClick={onClose}>关闭</Button>}
            </div>
            <div className="log-drawer-body">
              {fixJob !== null && <section className="log-fix-progress"><strong>{fixJob.label}</strong><Progress percent={fixJob.progress} status={fixJob.status === "failed" ? "exception" : fixJob.status === "done" ? "success" : "active"} /><small>{fixJob.detail}</small></section>}
              <section className="log-diagnosis">
                <div className="log-diagnosis-head">
                  <strong>日志分析</strong>
                  {analyzeLoading ? (
                    <span className="log-diagnosis-state">正在扫描日志…</span>
                  ) : issues.length === 0 ? (
                    <span className="log-diagnosis-state is-ok">未发现明显错误</span>
                  ) : (
                    <span className="log-diagnosis-state is-warn">
                      发现 {issues.length} 类问题
                    </span>
                  )}
                </div>
                {issues.length === 0 && !analyzeLoading ? (
                  <p className="log-diagnosis-empty">
                    最近一段日志没有匹配到常见错误；你仍然可以在下面直接查看原始日志。
                  </p>
                ) : (
                  <div className="log-issue-list">
                    {issues.map((issue) => (
                      <article className={`log-issue is-${issue.severity}`} key={issue.id}>
                        <div className="log-issue-main">
                          <strong>{issue.title}</strong>
                          <span className="log-issue-count">×{issue.count}</span>
                          <p>{issue.detail}</p>
                          {issue.examples.length > 0 && (
                            <code className="log-issue-example">{issue.examples[0]}</code>
                          )}
                        </div>
                        {issue.suggestedAction !== null && (
                          <Button
                            type="primary"
                            size="small"
                            onClick={() => setConfirmFix(issue)}
                          >
                            一键修复
                          </Button>
                        )}
                      </article>
                    ))}
                  </div>
                )}
              </section>
              <aside className="log-source-list">
                <strong>日志文件</strong>
                {sources.map((source) => (
                  <button
                    type="button"
                    key={source.id}
                    className={`log-source-item${activeLog?.sourceId === source.id ? " is-active" : ""}`}
                    onClick={() => void loadLogTail(source.id)}
                  >
                    <span>{source.id.startsWith("butler:") ? "管家·" + source.id.split(":").pop() : source.id.split(":").pop()}</span>
                    <small>{source.format === "journald" ? "服务日志" : formatBytes(source.sizeBytes)}</small>
                  </button>
                ))}
                {!loading && sources.length === 0 && (
                  <p className="log-source-empty">没有可用的日志文件</p>
                )}
              </aside>
              <section className="log-viewer">
                {error !== null && <div className="log-viewer-error">{error}</div>}
                {loading && <div className="log-viewer-loading">正在读取日志…</div>}
                {activeLog !== null && (
                  <>
                    <div className="log-viewer-meta">
                      <code title={activeLog.path}>{activeLog.path}</code>
                      <span>
                        {activeLog.truncated
                          ? `只显示最后 ${activeLog.lines.length} 行（共 ${formatNumber(activeLog.totalLines)} 行）`
                          : `共 ${formatNumber(activeLog.totalLines)} 行`}
                      </span>
                    </div>
                    {(activeLog.hasOlder || activeLog.hasNewer) && (
                      <div className="log-viewer-pager">
                        {activeLog.hasOlder && (
                          <Button
                            size="small"
                            disabled={loading}
                            onClick={() => void loadLogTail(activeLog.sourceId, activeLog.pageStart)}
                          >
                            更早的日志
                          </Button>
                        )}
                        {activeLog.hasNewer && (
                          <Button
                            size="small"
                            disabled={loading}
                            onClick={() => void loadLogTail(activeLog.sourceId, null)}
                          >
                            回到最新
                          </Button>
                        )}
                      </div>
                    )}
                    {activeLog.error !== undefined ? (
                      <div className="log-viewer-error">读取失败：{activeLog.error}</div>
                    ) : (
                      <pre className="log-lines">
                        {activeLog.lines.map((line, index) => (
                          <code key={index}>{line}</code>
                        ))}
                      </pre>
                    )}
                  </>
                )}
              </section>
            </div>
          </div>
        </div>
      )}

      <DangerConfirmModal
        open={confirmFix !== null}
        title="确认一键修复"
        confirmLabel="确认修复"
        cancelLabel="先不修复"
        busy={fixBusy}
        onCancel={() => setConfirmFix(null)}
        onConfirm={() => void runLogFix()}
        impact="该操作会重启或重连相关服务。确认前不会执行任何修改。"
      >
        管家将执行修复方案「<strong>{confirmFix?.actionLabel ?? "重启服务"}</strong>」，
        期间 Hermes 可能短暂不可用，修复完成后会自动复检。
      </DangerConfirmModal>
    </>
  );
}
