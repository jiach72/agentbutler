/**
 * 版本页 · 最新可升级版本：版本源诊断、目标实例选择与候选列表。
 */
import { Button, Select } from "antd";
import { DegradedBanner } from "../../components/DegradedBanner.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { formatRelative } from "../../lib/format.js";
import { compareVersion } from "../../lib/semver.js";
import {
  channelBadge,
  formatPublishedAt,
  instanceLabel,
  versionComparable,
  versionDisplay,
  versionSourceLabel,
} from "./helpers.js";
import type {
  AvailableVersionEntry,
  AvailableVersionsView,
  InstanceView,
  ManagedUpgradeTarget,
} from "./types.js";

interface CandidateListProps {
  available: AvailableVersionsView | null;
  watchReachable: boolean | undefined;
  instances: InstanceView[];
  targetInstance: string;
  currentVersion: string;
  candidates: AvailableVersionEntry[];
  launchPending: boolean;
  jobRunning: boolean;
  onSelectInstance: (instanceId: string) => void;
  onUpgrade: (target: ManagedUpgradeTarget) => void;
  onRefresh: () => void;
}

export function CandidateList({
  available,
  watchReachable,
  instances,
  targetInstance,
  currentVersion,
  candidates,
  launchPending,
  jobRunning,
  onSelectInstance,
  onUpgrade,
  onRefresh,
}: CandidateListProps) {
  if (available === null) return null;
  if (!available.reachable) {
    return (
      <DegradedBanner
        severity="warn"
        message={<strong>{watchReachable === false ? "管家服务暂时连不上" : "版本源检查失败"}</strong>}
        description={
          <>
            <span>
              {watchReachable === false
                ? "现在无法查看新版本，也不能升级。"
                : `已尝试 ${available.attempts?.length ?? 0} 个版本源，暂无可用结果。`}
            </span>
            {available.attempts?.map((attempt) => (
              <span key={attempt.id} className="version-source-attempt">
                {attempt.id}：{attempt.status === "ok" ? "可用" : attempt.error ?? "请求失败"} · {attempt.durationMs}ms
              </span>
            ))}
          </>
        }
        action={<Button onClick={onRefresh}>重新检查版本</Button>}
      />
    );
  }
  const instanceOptions =
    instances.length === 0
      ? [{ value: "", label: "（暂未发现管家，由管家自动选择）" }]
      : instances.map((instance) => ({
          value: instance.instanceId,
          label: instanceLabel(instance.instanceId),
        }));
  return (
    <>
      <div className="version-toolbar">
        <span className="version-source">更新来源：{versionSourceLabel(available.source ?? "")}</span>
        <span className="version-source-check">已检查：{available.checkedAt ? formatRelative(available.checkedAt) : "—"}</span>
        <label className="field-label" htmlFor="upgrade-target">
          要升级的管家：
        </label>
        <Select
          id="upgrade-target"
          className="version-target-select"
          value={targetInstance}
          options={instanceOptions}
          onChange={(value) => onSelectInstance(value)}
          popupMatchSelectWidth={false}
        />
      </div>
      {available.attempts !== undefined && available.attempts.length > 0 && (
        <div className="version-source-timeline" aria-label="版本源探测记录">
          {available.attempts.map((attempt) => (
            <div className={`version-source-timeline-item is-${attempt.status}`} key={attempt.id}>
              <span className="version-source-dot" />
              <span><strong>{attempt.id}</strong> {attempt.status === "ok" ? "已响应" : attempt.error ?? "请求失败"}</span>
              <small>{attempt.durationMs}ms</small>
            </div>
          ))}
        </div>
      )}
      {candidates.length === 0 ? (
        <div className="empty-state version-empty-explained">
          {currentVersion === ""
            ? "尚未读取到目标实例当前版本；请先确认 Hermes 实例在线，再重新检查。"
            : `当前目标实例 ${instanceLabel(targetInstance)} 为 ${currentVersion}，版本源没有更高版本候选。`}
          <Button onClick={onRefresh}>重新检查版本</Button>
        </div>
      ) : (
        <div className="cards-stack">
          {candidates.map((entry) => {
            const badge =
              entry.channel !== undefined && entry.channel !== ""
                ? channelBadge(entry.channel)
                : null;
            const isCurrent = currentVersion !== "" && compareVersion(versionComparable(entry), currentVersion) === 0;
            const published = formatPublishedAt(entry.publishedAt);
            return (
              <div className="card version-item" key={entry.version}>
                <div className="version-main">
                  <div className="version-name-row">
                    <span className="version-name">{versionDisplay(entry)}</span>
                    {badge !== null && <StatusBadge tone={badge.tone} label={badge.label} />}
                    {isCurrent && <StatusBadge tone="muted" label="当前版本" />}
                  </div>
                  <small className="version-tag">
                    {entry.version}
                    {published !== "" ? ` · ${published}` : ""}
                  </small>
                  {entry.notes !== undefined && entry.notes !== "" && (
                    <p className="version-notes">{entry.notes}</p>
                  )}
                </div>
                <Button
                  type="primary"
                  disabled={isCurrent || launchPending || jobRunning}
                  onClick={() => onUpgrade(entry)}
                >
                  {isCurrent
                    ? "正在使用"
                    : launchPending
                      ? "正在启动升级"
                      : jobRunning
                        ? "升级进行中"
                        : "升级到这一版"}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
