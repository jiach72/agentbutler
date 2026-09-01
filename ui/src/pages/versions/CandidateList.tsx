/**
 * 版本页 · 最新可升级版本：版本源诊断、目标实例选择与候选列表。
 */
import { Button, Card, Empty, Flex, Select, Timeline, Typography } from "antd";
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

const { Text } = Typography;

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
      <Flex vertical gap={16}>
        <DegradedBanner
          severity="warn"
          message={watchReachable === false ? "管家服务暂时连不上" : "版本源检查失败"}
          description={
            watchReachable === false
              ? "现在无法查看新版本，也不能升级。"
              : `已尝试 ${available.attempts?.length ?? 0} 个版本源，暂无可用结果。`
          }
          action={<Button onClick={onRefresh}>重新检查版本</Button>}
        />
        {(available.attempts?.length ?? 0) > 0 && (
          <Timeline
            items={(available.attempts ?? []).map((attempt) => ({
              key: attempt.id,
              color: attempt.status === "ok" ? "green" : "red",
              children: (
                <Text type="secondary">
                  {attempt.id}：{attempt.status === "ok" ? "可用" : attempt.error ?? "请求失败"} · {attempt.durationMs}ms
                </Text>
              ),
            }))}
          />
        )}
      </Flex>
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
    <Flex vertical gap={16}>
      <Flex wrap="wrap" align="center" gap={12}>
        <Text>更新来源：{versionSourceLabel(available.source ?? "")}</Text>
        <Text type="secondary">
          已检查：{available.checkedAt ? formatRelative(available.checkedAt) : "—"}
        </Text>
        <label htmlFor="upgrade-target">
          <Text>要升级的管家：</Text>
        </label>
        <Select
          id="upgrade-target"
          style={{ minWidth: 180 }}
          value={targetInstance}
          options={instanceOptions}
          onChange={(value) => onSelectInstance(value)}
          popupMatchSelectWidth={false}
        />
      </Flex>
      {available.attempts !== undefined && available.attempts.length > 0 && (
        <Flex vertical aria-label="版本源探测记录">
          <Timeline
            items={available.attempts.map((attempt) => ({
              key: attempt.id,
              color: attempt.status === "ok" ? "green" : "red",
              children: (
                <Flex align="baseline" gap={8} wrap="wrap">
                  <Text strong>{attempt.id}</Text>
                  <Text type="secondary">
                    {attempt.status === "ok" ? "已响应" : attempt.error ?? "请求失败"}
                  </Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {attempt.durationMs}ms
                  </Text>
                </Flex>
              ),
            }))}
          />
        </Flex>
      )}
      {candidates.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            currentVersion === ""
              ? "尚未读取到目标实例当前版本；请先确认 Hermes 实例在线，再重新检查。"
              : `当前目标实例 ${instanceLabel(targetInstance)} 为 ${currentVersion}，版本源没有更高版本候选。`
          }
        >
          <Button onClick={onRefresh}>重新检查版本</Button>
        </Empty>
      ) : (
        <Flex vertical gap={12}>
          {candidates.map((entry) => {
            const badge =
              entry.channel !== undefined && entry.channel !== ""
                ? channelBadge(entry.channel)
                : null;
            const isCurrent =
              currentVersion !== "" &&
              compareVersion(versionComparable(entry), currentVersion) === 0;
            const published = formatPublishedAt(entry.publishedAt);
            return (
              <Card key={entry.version} size="small">
                <Flex justify="space-between" align="center" gap={16} wrap="wrap">
                  <Flex vertical gap={2}>
                    <Flex align="center" gap={8} wrap="wrap">
                      <Text strong>{versionDisplay(entry)}</Text>
                      {badge !== null && <StatusBadge tone={badge.tone} label={badge.label} />}
                      {isCurrent && <StatusBadge tone="muted" label="当前版本" />}
                    </Flex>
                    <Text type="secondary">
                      {entry.version}
                      {published !== "" ? ` · ${published}` : ""}
                    </Text>
                    {entry.notes !== undefined && entry.notes !== "" && (
                      <Text type="secondary">{entry.notes}</Text>
                    )}
                  </Flex>
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
                </Flex>
              </Card>
            );
          })}
        </Flex>
      )}
    </Flex>
  );
}
