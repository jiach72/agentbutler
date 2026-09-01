/**
 * 版本页 · 管家自身卡片：版本信息、更新偏好、最新可用版本与自身恢复点。
 */
import { Button, Card, Checkbox, Descriptions, Empty, Flex, List, Select, Typography } from "antd";
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

const { Text, Title } = Typography;

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
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="管家自身的版本信息暂时读不到；管家服务恢复后会显示在这里。"
      />
    );
  }
  const repoBadge = repositoryBadge(butler);
  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="flex-start" wrap="wrap" gap={12}>
        <Flex vertical gap={4}>
          <Text type="secondary">Agent Butler</Text>
          <Title level={2} style={{ marginBottom: 0 }}>
            {butler.version ?? "版本未知"}
          </Title>
        </Flex>
        <StatusBadge tone={repoBadge.tone} label={repoBadge.label} />
      </Flex>
      <Descriptions
        column={2}
        size="small"
        items={[
          {
            key: "repository",
            label: "代码仓库",
            children: (
              <Flex vertical>
                <Text strong title={butler.repository ?? undefined}>
                  {butler.repository ?? "尚未配置源码仓库"}
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {butler.repositorySource === "git-origin"
                    ? "来自当前源码目录的 Git origin"
                    : butler.repositorySource === "configured-default"
                      ? "容器未挂载 Git 元数据，使用部署配置地址"
                      : typeof butler.repository === "string" && butler.repository.trim() !== ""
                        ? "来自旧版管家接口的仓库地址"
                        : "尚未配置仓库地址"}
                </Text>
              </Flex>
            ),
          },
          {
            key: "source",
            label: "管家代码目录",
            children: (
              <Flex vertical>
                <Text strong title={butler.source ?? undefined}>
                  {butler.source ?? "—"}
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  版本读取与升级预检使用此目录
                </Text>
              </Flex>
            ),
          },
          {
            key: "runtime",
            label: "运行环境",
            children: (
              <Flex vertical>
                <Text strong>{butler.runtime?.detail ?? "运行环境未知"}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {butler.runtime?.user ? `用户 ${butler.runtime.user}` : "WSL 用户未返回"}
                </Text>
              </Flex>
            ),
          },
          {
            key: "data",
            label: "数据目录",
            children: (
              <Flex vertical>
                <Text strong title={butler.runtime?.butlerDataDir}>
                  {butler.runtime?.butlerDataDir ?? "—"}
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  状态库、任务和审计记录
                </Text>
              </Flex>
            ),
          },
          {
            key: "branch",
            label: "分支 / 提交",
            children: (
              <Flex vertical>
                <Text strong>
                  {butler.branch ?? "—"}
                  {butler.commit !== null ? ` · ${butler.commit}` : ""}
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  最近标签：{butler.tag ?? "未打标签"}
                </Text>
              </Flex>
            ),
          },
          {
            key: "available",
            label: "可用更新",
            children: (
              <Flex vertical>
                <Text strong>检查后显示候选</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {butler.repositorySource === "configured-default"
                    ? "由内置更新服务拉取、构建并重启，失败会自动回滚"
                    : "升级前会自动备份并支持回滚"}
                </Text>
              </Flex>
            ),
          },
        ]}
      />
      {butlerSelf !== null && butlerSelf.reachable && (
        <>
          <Card type="inner" title="更新偏好">
            <Flex vertical gap={12}>
              <Text type="secondary">
                升级前会自动备份；失败自动回滚，不会让你自己处理。
              </Text>
              <Flex wrap="wrap" align="center" gap={16}>
                <label style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
                  <Text>更新通道</Text>
                  <Select
                    style={{ minWidth: 180 }}
                    value={butlerSelf.prefs.channel}
                    disabled={selfBusy}
                    onChange={(value) =>
                      onSavePrefs(value === "beta" ? "beta" : "stable", butlerSelf.prefs.locked)
                    }
                    options={[
                      { value: "stable", label: "稳定版" },
                      { value: "beta", label: "测试版（可能不稳定）" },
                    ]}
                  />
                </label>
                <Checkbox
                  checked={butlerSelf.prefs.locked}
                  disabled={selfBusy}
                  onChange={(event) => onSavePrefs(butlerSelf.prefs.channel, event.target.checked)}
                >
                  锁定版本（忽略更新提醒）
                </Checkbox>
              </Flex>
            </Flex>
          </Card>

          {butlerSelf.lastJob !== null && (
            <Card
              type="inner"
              title={butlerSelf.lastJob.kind === "upgrade" ? "管家自身升级" : "管家自身回滚"}
              extra={
                <StatusBadge
                  tone={jobBadge(butlerSelf.lastJob.status).tone}
                  label={jobBadge(butlerSelf.lastJob.status).label}
                />
              }
            >
              <Text type="secondary">
                {butlerSelf.lastJob.status === "running"
                  ? `正在${selfPhaseVerb(butlerSelf.lastJob.phase)}中…`
                  : butlerSelf.lastJob.error ?? "已完成"}
              </Text>
            </Card>
          )}

          <Card type="inner" title="最新可用版本">
            {candidate === null ? (
              <Text type="secondary">
                {butlerSelf.upgradeSupported === false || butlerSelf.commit === null
                  ? "自更新服务当前不可用，请确认 updater sidecar 已启动后重试。"
                  : butlerSelf.remoteConfigured === false || butlerSelf.repository === null || butlerSelf.repository === ""
                    ? "没有检测到 Git 仓库地址，无法查询管家更新。请检查 BUTLER_SRC 与 origin。"
                    : butlerSelf.repoClean === false
                      ? "当前源码目录有未提交改动，升级入口已保护；请先提交或清理改动。"
                      : `已检查 ${formatRelative(butlerSelf.checkedAt)}，仓库 ${butlerSelf.repository} 暂无高于 ${butlerSelf.version} 的 ${butlerSelf.prefs.channel === "beta" ? "测试版" : "稳定版"} 标签。`}
              </Text>
            ) : (
              <List
                size="small"
                dataSource={[candidate]}
                renderItem={(item) => (
                  <List.Item
                    actions={[
                      <Button
                        key="self-upgrade"
                        type="primary"
                        disabled={
                          selfBusy ||
                          butlerSelf.lastJob?.status === "running" ||
                          butlerSelf.prefs.locked
                        }
                        onClick={() => onRequestUpgrade(item)}
                      >
                        更新到最新版
                      </Button>,
                    ]}
                  >
                    <Flex align="center" gap={8} wrap="wrap">
                      <Text strong>{item.version}</Text>
                      <StatusBadge
                        tone={channelBadge(item.channel).tone}
                        label={channelBadge(item.channel).label}
                      />
                    </Flex>
                  </List.Item>
                )}
              />
            )}
          </Card>

          <Card type="inner" title="退回上一版本">
            {previousSelfSnapshot === null ? (
              <Text type="secondary">还没有上一版本恢复点；首次更新前会自动创建。</Text>
            ) : (
              <List
                size="small"
                dataSource={[previousSelfSnapshot]}
                renderItem={(item) => (
                  <List.Item
                    actions={[
                      <Button
                        key="self-rollback"
                        disabled={
                          selfBusy ||
                          butlerSelf.lastJob?.status === "running" ||
                          butlerSelf.upgradeSupported === false
                        }
                        onClick={() => onRequestRollback(item)}
                      >
                        退回上一版本
                      </Button>,
                    ]}
                  >
                    <Flex align="center" gap={8} wrap="wrap">
                      <Text strong>{item.version}</Text>
                      <Text type="secondary">{formatRelative(item.at)}保存</Text>
                    </Flex>
                  </List.Item>
                )}
              />
            )}
          </Card>
        </>
      )}

      <Text type="secondary">
        {butler.repositoryConfigured !== false && butler.repository !== null && butler.repository !== ""
          ? "源码上传到仓库并打 tag 后，内置更新服务支持一键升级与回滚；升级失败会自动还原。"
          : "配置 Git 仓库地址并打上版本 tag 后，内置更新服务支持一键升级与回滚。"}
      </Text>
    </Flex>
  );
}
