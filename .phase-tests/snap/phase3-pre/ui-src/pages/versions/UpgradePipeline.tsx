/**
 * 版本页 · 升级进度：启动态进度条与真实 Job 五步流水线。
 */
import { Descriptions, Empty, Flex, Steps, Typography } from "antd";
import type { StepsProps } from "antd";
import { PageProgress } from "../../components/PageProgress.js";
import { DegradedBanner } from "../../components/DegradedBanner.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { formatRelative } from "../../lib/format.js";
import { channelBadge, instanceLabel, jobBadge } from "./helpers.js";
import type { ManagedUpgradeProgressView } from "./helpers.js";
import type { UpgradeJobView } from "./types.js";

const { Text } = Typography;

interface UpgradePipelineProps {
  job: UpgradeJobView | null;
  launchPending: boolean;
  progress: ManagedUpgradeProgressView | null;
}

/** 步骤状态 → antd Steps 状态（passed→finish / running→process / failed→error / 其余→wait）。 */
function stepStatus(status: string): NonNullable<StepsProps["items"]>[number]["status"] {
  if (status === "passed") return "finish";
  if (status === "running") return "process";
  if (status === "failed") return "error";
  return "wait";
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
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            launchPending
              ? "正在创建升级任务，收到管家的第一步状态后会显示详细步骤。"
              : "目前没有正在进行的升级。选择上方版本后，进度会显示在这里。"
          }
        />
      ) : (
        <Flex vertical gap={16}>
          <Flex wrap="wrap" align="center" gap={12}>
            <Text strong>{instanceLabel(job.instanceId)}</Text>
            <Text>→ {job.targetVersion}</Text>
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
          </Flex>
          {job.rolledBack === true && (
            <DegradedBanner
              severity="warn"
              message={`升级后检查没有通过，管家已自动还原${job.snapshotId !== undefined ? `（备份 ${job.snapshotId}）` : ""}`}
            />
          )}
          <Steps
            direction="vertical"
            size="small"
            items={job.steps.map((step) => ({
              title: step.label,
              description:
                step.detail !== undefined && step.detail !== "" ? step.detail : undefined,
              status: stepStatus(step.status),
            }))}
          />
          <Descriptions
            column={1}
            size="small"
            items={[
              { key: "started", label: "开始于", children: formatRelative(job.startedAt) },
              {
                key: "finished",
                label: "结束于",
                children: job.finishedAt !== undefined ? formatRelative(job.finishedAt) : "—",
              },
              ...(job.trigger !== undefined && job.trigger !== ""
                ? [{ key: "trigger", label: "触发方式", children: job.trigger }]
                : []),
              ...(job.error !== undefined && job.error !== ""
                ? [{ key: "error", label: "错误", children: job.error }]
                : []),
            ]}
          />
        </Flex>
      )}
    </>
  );
}
