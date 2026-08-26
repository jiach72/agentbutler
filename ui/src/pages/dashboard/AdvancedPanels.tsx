/**
 * 高级详情内的三块面板：一键处理方案、管家最近检查、经常出现的问题。
 */
import { DegradedBanner } from "../../components/DegradedBanner.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { formatRelative } from "../../lib/format.js";
import {
  criticalProbeBadge,
  fingerprintBadge,
  formatDuration,
  formatSample,
  instanceLabel,
} from "./helpers.js";
import type { FingerprintView, InspectStatusView, RunbookView, RunbooksPayload } from "./types.js";

/** 可以一键处理：修复方案列表，熔断中的方案被过滤。 */
export function RunbooksPanel({
  runbooks,
  onRepair,
}: {
  runbooks: RunbooksPayload | null;
  onRepair: (runbook: RunbookView) => void;
}) {
  const available = (runbooks?.runbooks ?? []).filter(
    (item) => item.breakerTripped !== true,
  );
  return (
    <>
      {runbooks !== null && !runbooks.reachable && (
        <DegradedBanner severity="warn" message="管家暂时连不上：处理方案列表暂不可用" />
      )}
      {runbooks !== null && runbooks.reachable && available.length === 0 && (
        <div className="empty-state">管家在线，但还没有可以一键处理的问题。</div>
      )}
      {runbooks !== null && runbooks.reachable && (
        <div className="cards-stack">
          {available.map((runbook) => (
            <div className="card runbook-item" key={runbook.id}>
              <div className="runbook-main">
                <div className="runbook-title">
                  <span className="instance-name">{runbook.label}</span>
                  {runbook.breakerTripped === true && (
                    <StatusBadge tone="error" label="已暂停" />
                  )}
                </div>
                {runbook.description !== undefined && runbook.description !== "" && (
                  <div className="runbook-desc">{runbook.description}</div>
                )}
                <div className="runbook-lastrun">
                  上次执行：
                  {runbook.lastRun
                    ? `${formatRelative(runbook.lastRun.at)}（${runbook.lastRun.success ? "成功" : "失败"}）`
                    : "从未执行"}
                </div>
              </div>
              <button type="button" className="btn" onClick={() => onRepair(runbook)}>
                开始处理
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** 管家最近检查：关键记忆探针 SLA 与检查节奏。 */
export function InspectCard({
  inspectStatus,
  onInspect,
}: {
  inspectStatus: InspectStatusView | null;
  onInspect: () => void;
}) {
  if (inspectStatus === null || !inspectStatus.reachable) {
    return (
      <div className="card inspect-card">
        <div className="empty-state">
          管家服务暂时连不上：看不到最近检查，也无法开始新的检查。
        </div>
      </div>
    );
  }
  const criticalProbe = inspectStatus.criticalProbe;
  const criticalBadge = criticalProbeBadge(criticalProbe);
  return (
    <div className="card inspect-card">
      {criticalProbe === undefined ? null : (
        <div className="inspect-sla" role="status">
          <StatusBadge tone={criticalBadge.tone} label={criticalBadge.label} />
          <span>关键记忆探针：每 {criticalProbe.intervalMin} 分钟，SLA {criticalProbe.slaMin} 分钟</span>
          {criticalProbe.lastDurationMs !== null ? (
            <span>最近耗时 {formatDuration(criticalProbe.lastDurationMs)}</span>
          ) : null}
        </div>
      )}
      <dl className="kv">
        <dt>上次检查</dt>
        <dd>{formatRelative(inspectStatus.lastAt)}</dd>
        <dt>下次预计</dt>
        <dd>{formatRelative(inspectStatus.nextAt)}</dd>
        <dt>多久检查一次</dt>
        <dd>{inspectStatus.intervalMin ?? "—"} 分钟</dd>
        <dt>现在</dt>
        <dd>{inspectStatus.inFlight ? "正在检查" : "没有在检查"}</dd>
      </dl>
      <div className="inspect-actions">
        <button type="button" className="btn" onClick={onInspect}>
          立即检查
        </button>
      </div>
    </div>
  );
}

/** 经常出现的问题：同类错误指纹表。 */
export function FingerprintsTable({
  fingerprints,
  onOpenLogs,
}: {
  fingerprints: FingerprintView[];
  onOpenLogs: () => void;
}) {
  if (fingerprints.length === 0) {
    return (
      <div className="empty-state">
        暂时没有经常出现的问题；如果以后出现，会显示在这里。
      </div>
    );
  }
  return (
    <div className="card table-card">
      <table className="table">
        <thead>
          <tr>
            <th>问题内容</th>
            <th>影响组件</th>
            <th>首次出现</th>
            <th>次数</th>
            <th>状态</th>
            <th>最近出现</th>
            <th>日志</th>
          </tr>
        </thead>
        <tbody>
          {fingerprints.map((fp) => {
            const badge = fingerprintBadge(fp.status);
            return (
              <tr key={fp.signature}>
                <td className="fp-sample" title={fp.lastSample ?? undefined}>
                  {formatSample(fp.lastSample)}
                </td>
                <td>{fp.instance ? instanceLabel(fp.instance) : "未知"}</td>
                <td>{formatRelative(fp.firstSeen)}</td>
                <td>{fp.count}</td>
                <td>
                  <StatusBadge tone={badge.tone} label={badge.label} />
                </td>
                <td>{formatRelative(fp.lastSeen)}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn-quiet btn-sm"
                    onClick={onOpenLogs}
                  >
                    查看日志
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
