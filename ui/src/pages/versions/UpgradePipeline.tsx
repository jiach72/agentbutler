/**
 * 版本页 · 升级进度：启动态进度条与真实 Job 五步流水线。
 */
import { PageProgress } from "../../components/PageProgress.js";
import { DegradedBanner } from "../../components/DegradedBanner.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { formatRelative } from "../../lib/format.js";
import { channelBadge, instanceLabel, jobBadge, stepBadge } from "./helpers.js";
import type { ManagedUpgradeProgressView } from "./helpers.js";
import type { UpgradeJobView } from "./types.js";

interface UpgradePipelineProps {
  job: UpgradeJobView | null;
  launchPending: boolean;
  progress: ManagedUpgradeProgressView | null;
}

export function UpgradePipeline({ job, launchPending, progress }: UpgradePipelineProps) {
  return (
    <>
      {progress !== null && (
        <PageProgress
          compact
          title={progress.title}
          detail={progress.detail}
          indeterminate={progress.indeterminate}
          steps={progress.steps}
        />
      )}
      {job === null ? (
        <div className="empty-state">
          {launchPending
            ? "正在创建升级任务，收到管家的第一步状态后会显示详细步骤。"
            : "目前没有正在进行的升级。选择上方版本后，进度会显示在这里。"}
        </div>
      ) : (
        <div className="card">
          <div className="pipeline-head">
            <span className="instance-name">{instanceLabel(job.instanceId)}</span>
            <span>→ {job.targetVersion}</span>
            {job.channel !== undefined && job.channel !== "" && (
              <StatusBadge
                tone={channelBadge(job.channel).tone}
                label={channelBadge(job.channel).label}
              />
            )}
            <StatusBadge
              tone={jobBadge(job.status).tone}
              label={jobBadge(job.status).label}
            />
          </div>
          {job.rolledBack === true && (
            <DegradedBanner
              severity="warn"
              message={`⚠ 升级后检查没有通过，管家已自动还原${job.snapshotId !== undefined ? `（备份 ${job.snapshotId}）` : ""}`}
            />
          )}
          <ol className="pipeline-steps">
            {job.steps.map((step, index) => {
              const badge = stepBadge(step.status);
              return (
                <li className={`pipeline-step step-${step.status}`} key={step.id}>
                  <span className="step-index">{index + 1}</span>
                  <span className="step-label">{step.label}</span>
                  <StatusBadge tone={badge.tone} label={badge.label} />
                  {step.detail !== undefined && step.detail !== "" && (
                    <span className="step-detail" title={step.detail}>
                      {step.detail}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
          <dl className="kv pipeline-kv">
            <dt>开始于</dt>
            <dd>{formatRelative(job.startedAt)}</dd>
            <dt>结束于</dt>
            <dd>{job.finishedAt !== undefined ? formatRelative(job.finishedAt) : "—"}</dd>
            {job.trigger !== undefined && job.trigger !== "" && (
              <>
                <dt>触发方式</dt>
                <dd>{job.trigger}</dd>
              </>
            )}
            {job.error !== undefined && job.error !== "" && (
              <>
                <dt>错误</dt>
                <dd>{job.error}</dd>
              </>
            )}
          </dl>
        </div>
      )}
    </>
  );
}
