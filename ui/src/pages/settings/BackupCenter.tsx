/**
 * 设置页右栏备份面板：手动备份入口、保留策略与备份记录时间线。
 * 备份/管家自检两路数据独立三态，失败时显示降级横幅与单源重试。
 */
import { Button } from "antd";
import { StatusBadge } from "../../components/StatusBadge.js";
import { DegradedBanner } from "../../components/DegradedBanner.js";
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

interface BackupCenterProps {
  backups: FetchState<BackupsPayload>;
  butlerSelf: FetchState<ButlerSelfPayload>;
  busy: string | null;
  onRetry: (key: "backups" | "butlerSelf") => void;
  onRunBackup: (kind: "full" | "memory") => void;
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
  onRequestRestore,
}: BackupCenterProps) {
  const backupRetention = backupRetentionOf(backups.status === "ready" ? backups.data : null);
  const snapshotRetention = snapshotRetentionOf(
    butlerSelf.status === "ready" ? butlerSelf.data : null,
  );

  return (
    <>
      <div className="settings-section-head">
        <div>
          <span className="product-kicker">备份与还原</span>
          <h2>备份记录</h2>
        </div>
        <StatusBadge
          tone={backups.status === "ready" && backups.data.items.length > 0 ? "ok" : "muted"}
          label={`${backups.status === "ready" ? backups.data.items.length : 0} 条`}
        />
      </div>

      <div className="backup-actions">
        <Button
          type="primary"
          loading={busy === "full"}
          disabled={busy !== null}
          onClick={() => onRunBackup("full")}
        >
          立即全量备份
        </Button>
        <Button
          loading={busy === "memory"}
          disabled={busy !== null}
          onClick={() => onRunBackup("memory")}
        >
          备份记忆
        </Button>
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
          {butlerSelf.status === "failed" && (
            <DegradedBanner
              severity="warn"
              message={DEGRADED_TEXT}
              description={butlerSelf.reason}
              action={
                <Button size="small" onClick={() => onRetry("butlerSelf")}>
                  重试
                </Button>
              }
            />
          )}
          <div className="backup-policy-meta">
            <span>当前恢复点</span>
            <strong>
              {butlerSelf.status === "loading"
                ? "读取中…"
                : butlerSelf.status === "ready"
                  ? butlerSelf.data.reachable
                    ? `${butlerSelf.data.snapshots.length} / ${snapshotRetention} 份`
                    : "服务离线"
                  : DEGRADED_TEXT}
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
        {backups.status === "ready" &&
          backups.data.items.slice(0, 8).map((item) => (
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
                <Button
                  size="small"
                  disabled={busy !== null}
                  loading={busy === `restore-${item.id}`}
                  onClick={() => onRequestRestore(item)}
                >
                  还原
                </Button>
              )}
            </article>
          ))}
        {backups.status === "loading" && (
          <div className="empty-state">正在读取备份记录…</div>
        )}
        {backups.status === "failed" && (
          <DegradedBanner
            severity="warn"
            message={DEGRADED_TEXT}
            description={backups.reason}
            action={
              <Button size="small" onClick={() => onRetry("backups")}>
                重试
              </Button>
            }
          />
        )}
        {backups.status === "ready" && backups.data.items.length === 0 && (
          <div className="empty-state">
            还没有备份记录；点击「立即全量备份」开始第一次备份，之后管家每天自动备份。
          </div>
        )}
      </div>
    </>
  );
}
