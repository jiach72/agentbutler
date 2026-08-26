/**
 * 版本页 · 管家自身卡片：版本信息、更新偏好、最新可用版本与自身恢复点。
 */
import { StatusBadge } from "../../components/StatusBadge.js";
import { formatRelative } from "../../lib/format.js";
import { channelBadge, jobBadge, repositoryBadge, selfPhaseVerb } from "./helpers.js";
import type {
  ButlerAvailableUpdate,
  ButlerSelfPrefs,
  ButlerSelfSnapshot,
  ButlerSelfView,
  ButlerVersionView,
} from "./types.js";

interface SelfUpgradeCardProps {
  butler: ButlerVersionView | null;
  butlerSelf: ButlerSelfView | null;
  candidate: ButlerAvailableUpdate | null;
  previousSelfSnapshot: ButlerSelfSnapshot | null;
  selfBusy: boolean;
  onSavePrefs: (channel: ButlerSelfPrefs["channel"], locked: boolean) => void;
  onRequestUpgrade: (target: ButlerAvailableUpdate) => void;
  onRequestRollback: (snapshot: ButlerSelfSnapshot) => void;
}

export function SelfUpgradeCard({
  butler,
  butlerSelf,
  candidate,
  previousSelfSnapshot,
  selfBusy,
  onSavePrefs,
  onRequestUpgrade,
  onRequestRollback,
}: SelfUpgradeCardProps) {
  if (butler === null || butler.reachable !== true) {
    return (
      <div className="card butler-version-card">
        <div className="empty-state">
          管家自身的版本信息暂时读不到；管家服务恢复后会显示在这里。
        </div>
      </div>
    );
  }
  const repoBadge = repositoryBadge(butler);
  return (
    <div className="card butler-version-card">
      <div className="butler-version-main">
        <div>
          <span className="butler-version-label">Agent Butler</span>
          <strong className="butler-version-number">{butler.version ?? "版本未知"}</strong>
        </div>
        <StatusBadge tone={repoBadge.tone} label={repoBadge.label} />
      </div>
      <div className="butler-version-grid">
        <div className="butler-version-fact">
          <span>代码仓库</span>
          <strong title={butler.repository ?? undefined}>
            {butler.repository ?? "尚未配置源码仓库"}
          </strong>
          <small>
            {butler.repositorySource === "git-origin"
              ? "来自当前源码目录的 Git origin"
              : butler.repositorySource === "configured-default"
                ? "容器未挂载 Git 元数据，使用部署配置地址"
                : typeof butler.repository === "string" && butler.repository.trim() !== ""
                  ? "来自旧版管家接口的仓库地址"
                  : "尚未配置仓库地址"}
          </small>
        </div>
        <div className="butler-version-fact">
          <span>管家代码目录</span>
          <strong title={butler.source ?? undefined}>{butler.source ?? "—"}</strong>
          <small>版本读取与升级预检使用此目录</small>
        </div>
        <div className="butler-version-fact">
          <span>运行环境</span>
          <strong>{butler.runtime?.detail ?? "运行环境未知"}</strong>
          <small>{butler.runtime?.user ? `用户 ${butler.runtime.user}` : "WSL 用户未返回"}</small>
        </div>
        <div className="butler-version-fact">
          <span>数据目录</span>
          <strong title={butler.runtime?.butlerDataDir}>{butler.runtime?.butlerDataDir ?? "—"}</strong>
          <small>状态库、任务和审计记录</small>
        </div>
        <div className="butler-version-fact">
          <span>分支 / 提交</span>
          <strong>{butler.branch ?? "—"}{butler.commit !== null ? ` · ${butler.commit}` : ""}</strong>
          <small>最近标签：{butler.tag ?? "未打标签"}</small>
        </div>
        <div className="butler-version-fact">
          <span>可用更新</span>
          <strong>
            {butler.repositorySource === "configured-default" ? "需在宿主机更新" : "检查后显示候选"}
          </strong>
          <small>
            {butler.repositorySource === "configured-default"
              ? "当前镜像不含 Git 工作树，请使用 scripts/deploy.sh 更新"
              : "升级前会自动备份并支持回滚"}
          </small>
        </div>
      </div>
      {butlerSelf !== null && butlerSelf.reachable && (
        <>
          <div className="butler-self-prefs">
            <div>
              <strong>更新偏好</strong>
              <span>升级前会自动备份；失败自动回滚，不会让你自己处理。</span>
            </div>
            <div className="butler-self-prefs-controls">
              <label className="field-label">
                更新通道
                <select
                  className="select"
                  value={butlerSelf.prefs.channel}
                  disabled={selfBusy}
                  onChange={(event) =>
                    onSavePrefs(
                      event.target.value === "beta" ? "beta" : "stable",
                      butlerSelf.prefs.locked,
                    )
                  }
                >
                  <option value="stable">稳定版</option>
                  <option value="beta">测试版（可能不稳定）</option>
                </select>
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={butlerSelf.prefs.locked}
                  disabled={selfBusy}
                  onChange={(event) => onSavePrefs(butlerSelf.prefs.channel, event.target.checked)}
                />
                锁定版本（忽略更新提醒）
              </label>
            </div>
          </div>

          {butlerSelf.lastJob !== null && (
            <div className="butler-self-job">
              <div>
                <strong>
                  {butlerSelf.lastJob.kind === "upgrade" ? "管家自身升级" : "管家自身回滚"}
                </strong>
                <StatusBadge
                  tone={jobBadge(butlerSelf.lastJob.status).tone}
                  label={jobBadge(butlerSelf.lastJob.status).label}
                />
              </div>
              <p>
                {butlerSelf.lastJob.status === "running"
                  ? `正在${selfPhaseVerb(butlerSelf.lastJob.phase)}中…`
                  : butlerSelf.lastJob.error ?? "已完成"}
              </p>
            </div>
          )}

          <div className="butler-self-updates">
            <strong>最新可用版本</strong>
            {candidate === null ? (
              <p className="hint">
                {butlerSelf.upgradeSupported === false || butlerSelf.commit === null
                  ? "当前为容器部署：仓库地址已配置，但镜像未挂载 Git 工作树，请在宿主机执行 scripts/deploy.sh 更新。"
                  : butlerSelf.remoteConfigured === false || butlerSelf.repository === null || butlerSelf.repository === ""
                  ? "没有检测到 Git 仓库地址，无法查询管家更新。请检查 BUTLER_SRC 与 origin。"
                  : butlerSelf.repoClean === false
                    ? "当前源码目录有未提交改动，升级入口已保护；请先提交或清理改动。"
                    : `已检查 ${formatRelative(butlerSelf.checkedAt)}，仓库 ${butlerSelf.repository} 暂无高于 ${butlerSelf.version} 的 ${butlerSelf.prefs.channel === "beta" ? "测试版" : "稳定版"} 标签。`}
              </p>
            ) : (
              <ul className="self-update-list">
                <li key={candidate.tag ?? candidate.version}>
                  <div>
                    <strong>{candidate.version}</strong>
                    <StatusBadge
                      tone={channelBadge(candidate.channel).tone}
                      label={channelBadge(candidate.channel).label}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn"
                    disabled={
                      selfBusy ||
                      butlerSelf.lastJob?.status === "running" ||
                      butlerSelf.prefs.locked
                    }
                    onClick={() => onRequestUpgrade(candidate)}
                  >
                    更新到最新版
                  </button>
                </li>
              </ul>
            )}
          </div>

          <div className="butler-self-snapshots">
            <strong>退回上一版本</strong>
            {previousSelfSnapshot === null ? (
              <p className="hint">
                还没有上一版本恢复点；首次更新前会自动创建。
              </p>
            ) : (
              <ul className="self-snapshot-list">
                <li key={previousSelfSnapshot.id}>
                  <div>
                    <strong>{previousSelfSnapshot.version}</strong>
                    <span>{formatRelative(previousSelfSnapshot.at)}保存</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={
                      selfBusy ||
                      butlerSelf.lastJob?.status === "running" ||
                      butlerSelf.upgradeSupported === false
                    }
                    onClick={() => onRequestRollback(previousSelfSnapshot)}
                  >
                    退回上一版本
                  </button>
                </li>
              </ul>
            )}
          </div>
        </>
      )}

      <div className="hint">
        {butler.repositoryConfigured !== false && butler.repository !== null && butler.repository !== ""
          ? "源码上传到仓库并打 tag 后，管家自身支持一键升级与回滚；升级失败会自动还原。"
          : "把源代码上传到 Git 仓库、配置远程地址并打上版本 tag 后，管家自身支持一键升级与回滚。"}
      </div>
    </div>
  );
}
