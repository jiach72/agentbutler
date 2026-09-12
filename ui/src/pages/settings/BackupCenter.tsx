/**
 * 设置页右栏备份面板：手动备份入口、保留策略与备份记录时间线。
 * 备份/管家自检两路数据独立三态，失败时显示降级横幅与单源重试。
 */
import { Button, Card, Divider, Flex, Space, Spin, Timeline, Tooltip, Typography } from "antd";
import { Empty } from "../../components/Empty.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { DegradedBanner } from "../../components/DegradedBanner.js";
import { SectionHeader } from "../../components/SectionHeader.js";
import { formatBytes, formatTime } from "../../lib/format.js";
import type { FetchState } from "../../lib/api.js";
import {
  type BackupItem,
  backupKindLabel,
  backupRetentionOf,
  DEGRADED_TEXT,
  type BackupsPayload,
  type ButlerSelfPayload,
  snapshotRetentionOf,
  snapshotStatusLabel,
} from "./helpers.js";

const { Paragraph, Text } = Typography;

interface BackupCenterProps {
  backups: FetchState<BackupsPayload>;
  butlerSelf: FetchState<ButlerSelfPayload>;
  busy: string | null;
  onRetry: (key: "backups" | "butlerSelf") => void;
  onRunBackup: (kind: "full" | "memory") => void;
  onVerifyBackup: () => void;
  onRequestRestore: (item: BackupItem) => void;
}

function restoreable(item: BackupItem): boolean {
  return item.kind === "memory" || item.kind === "full";
}

export function BackupCenter({
  backups,
  butlerSelf,
  busy,
  onRetry,
  onRunBackup,
  onVerifyBackup,
  onRequestRestore,
}: BackupCenterProps) {
  const backupRetention = backupRetentionOf(backups.status === "ready" ? backups.data : null);
  const snapshotRetention = snapshotRetentionOf(
    butlerSelf.status === "ready" ? butlerSelf.data : null,
  );
  const fullVerification =
    backups.status === "ready" ? backups.data.status?.lastFullVerification ?? null : null;

  return (
    <Flex vertical gap={16}>
      <SectionHeader
        kicker="备份与还原"
        title="备份记录"
        extra={
          // 还没拿到备份列表 = 规范 §1.4 的"还没读到数据"，用 unknown。
          <StatusBadge
            tone={backups.status === "ready" && backups.data.items.length > 0 ? "ok" : "unknown"}
            label={`${backups.status === "ready" ? backups.data.items.length : 0} 条`}
          />
        }
      />

      <Space wrap>
        <Tooltip title="有备份或还原操作正在执行">
          <Button
            type="primary"
            loading={busy === "full"}
            disabled={busy !== null}
            onClick={() => onRunBackup("full")}
          >
            立即全量备份
          </Button>
        </Tooltip>
        <Tooltip title="有备份或还原操作正在执行">
          <Button
            loading={busy === "memory"}
            disabled={busy !== null}
            onClick={() => onRunBackup("memory")}
          >
            备份记忆
          </Button>
        </Tooltip>
        <Button
          disabled={busy !== null || backups.status !== "ready" || backups.data.items.length === 0}
          loading={busy === "verify"}
          onClick={onVerifyBackup}
        >
          验证最近备份
        </Button>
      </Space>

      <Card size="small" title="保留策略" aria-label="备份保留策略">
        <Flex vertical gap={12}>
          <div>
            <Flex justify="space-between" wrap gap={8}>
              <Text strong>升级快照</Text>
              <Text type="secondary">最多 {snapshotRetention} 份</Text>
            </Flex>
            <Paragraph type="secondary" style={{ marginBottom: 8 }}>
              管家自身升级前创建，用于升级失败时自动回滚。
            </Paragraph>
            {butlerSelf.status === "failed" && (
              <DegradedBanner
                severity="warn"
                message={DEGRADED_TEXT}
                description={butlerSelf.reason}
                action={<Button onClick={() => onRetry("butlerSelf")}>重试</Button>}
              />
            )}
            <Flex justify="space-between" wrap gap={8}>
              <Text type="secondary">当前恢复点</Text>
              <Text strong>
                {butlerSelf.status === "loading"
                  ? "读取中…"
                  : butlerSelf.status === "ready"
                    ? butlerSelf.data.reachable
                      ? `${butlerSelf.data.snapshots.length} / ${snapshotRetention} 份`
                      : "服务离线"
                    : DEGRADED_TEXT}
              </Text>
            </Flex>
          </div>
          <Divider style={{ margin: 0 }} />
          <div>
            <Flex justify="space-between" wrap gap={8}>
              <Text strong>日常备份</Text>
              <Text type="secondary">按类型轮转</Text>
            </Flex>
            <Paragraph type="secondary" style={{ marginBottom: 8 }}>
              日常备份不会挤占升级快照；验证会在临时目录检查文件和数据库，不会覆盖正在使用的数据。
            </Paragraph>
            <Flex gap={16} wrap>
              <Text type="secondary">每日全量 · {backupRetention.full} 份</Text>
              <Text type="secondary">记忆增量 · {backupRetention.memory} 份</Text>
              <Text type="secondary">操作前 · {backupRetention.event} 份</Text>
            </Flex>
            <Flex justify="space-between" wrap gap={8} style={{ marginTop: 8 }}>
              <Text type="secondary">最近全量验证</Text>
              <Text
                type={
                  fullVerification?.status === "verification-failed"
                    ? "danger"
                    : fullVerification?.status === "verified"
                      ? "success"
                      : "secondary"
                }
              >
                {fullVerification === null
                  ? "尚无全量备份"
                  : fullVerification.status === "verified"
                    ? `已验证 · ${formatTime(fullVerification.at)}`
                    : fullVerification.status === "verification-failed"
                      ? `验证失败 · ${formatTime(fullVerification.at)}`
                      : "尚未验证"}
              </Text>
            </Flex>
          </div>
        </Flex>
      </Card>

      {backups.status === "ready" && backups.data.items.length > 0 && (
        <Timeline
          items={backups.data.items.slice(0, 8).map((item) => ({
            key: item.id,
            children: (
              <Flex justify="space-between" align="flex-start" wrap gap={12}>
                <div style={{ minWidth: 0 }}>
                  <Text strong>{item.label ?? backupKindLabel(item.kind)}</Text>
                  <br />
                  <Text type="secondary">
                    {backupKindLabel(item.kind)} · {formatTime(item.createdAt)} ·{" "}
                    {formatBytes(item.sizeBytes)}
                  </Text>
                </div>
                <Space>
                  <StatusBadge tone="unknown" label={snapshotStatusLabel(item.status)} />
                  {restoreable(item) && (
                    <Tooltip title="有备份或还原操作正在执行">
                      <Button
                        size="small"
                        disabled={busy !== null}
                        loading={busy === `restore-${item.id}`}
                        onClick={() => onRequestRestore(item)}
                      >
                        还原
                    </Button>
                    </Tooltip>
                  )}
                </Space>
              </Flex>
            ),
          }))}
        />
      )}
      {backups.status === "loading" && (
        <Flex align="center" gap={8}>
          <Spin size="small" />
          <Text type="secondary">正在读取备份记录…</Text>
        </Flex>
      )}
      {backups.status === "failed" && (
        <DegradedBanner
          severity="warn"
          message={DEGRADED_TEXT}
          description={backups.reason}
          action={<Button onClick={() => onRetry("backups")}>重试</Button>}
        />
      )}
      {backups.status === "ready" && backups.data.items.length === 0 && (
        <Empty
          mascot={false}
          title="还没有备份记录"
          hint="点击「立即全量备份」开始第一次备份，之后管家每天自动备份。"
        />
      )}
    </Flex>
  );
}
