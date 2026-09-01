/**
 * 设置页左栏：本机安全检查、配置规则与密钥文件详情、自动修复保护、通知方式。
 * 各数据源独立三态：failed 显示降级横幅 + 重试，loading 仅在首屏短暂出现。
 * 视觉全部走 antd List / Badge / Collapse 原语，不依赖旧页面 CSS。
 */
import { useMemo } from "react";
import { Badge, Button, Flex, List, Typography } from "antd";
import type { BadgeProps } from "antd";
import { AdvancedDetails } from "../../components/AdvancedDetails.js";
import { DegradedBanner } from "../../components/DegradedBanner.js";
import { SectionHeader } from "../../components/SectionHeader.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import type { FetchState } from "../../lib/api.js";
import {
  type AlertsPayload,
  type AuditPayload,
  type BackupsPayload,
  DEGRADED_TEXT,
  invariantAggregate,
  invariantStatusLabel,
  type RunbookSummary,
  type RunbooksPayload,
  type SecurityBaselinePayload,
  type SecurityPayload,
  type SettingsSourceKey,
  sourceData,
} from "./helpers.js";

const { Text } = Typography;

interface BaselineItem {
  title: string;
  status: string;
  detail: string;
}

interface SecurityBaselineProps {
  baseline: FetchState<SecurityBaselinePayload>;
  alerts: FetchState<AlertsPayload>;
  runbooks: FetchState<RunbooksPayload>;
  security: FetchState<SecurityPayload>;
  audit: FetchState<AuditPayload>;
  backups: FetchState<BackupsPayload>;
  busy: string | null;
  onRetry: (key: SettingsSourceKey) => void;
  onRequestReset: (runbook: RunbookSummary) => void;
}

function retryBanner(
  key: SettingsSourceKey,
  reason: string | undefined,
  onRetry: (key: SettingsSourceKey) => void,
) {
  return (
    <DegradedBanner
      severity="warn"
      message={DEGRADED_TEXT}
      description={reason}
      action={
        <Button onClick={() => onRetry(key)}>
          重试
        </Button>
      }
    />
  );
}

/** 检查状态 → antd Badge status 映射（pass/warn/fail 之外的都按中性处理）。 */
function statusToBadge(status: string): BadgeProps["status"] {
  if (status === "pass") return "success";
  if (status === "warn") return "warning";
  if (status === "fail") return "error";
  return "default";
}

/** 检查状态 → 右侧结论文案（已满足 / 需注意 / 建设中）。 */
function stateLabel(status: string): string {
  return status === "pass" ? "已满足" : status === "warn" ? "需注意" : "建设中";
}

export function SecurityBaseline({
  baseline,
  alerts,
  runbooks,
  security,
  audit,
  backups,
  busy,
  onRetry,
  onRequestReset,
}: SecurityBaselineProps) {
  const securityData = sourceData(security);
  const runbooksData = sourceData(runbooks);
  const backupsData = sourceData(backups);

  const trippedRunbooks = useMemo(
    () => (runbooksData?.runbooks ?? []).filter((item) => item.breakerTripped),
    [runbooksData],
  );

  const invariantAggregateItem = useMemo(
    () => invariantAggregate(securityData?.invariants ?? []),
    [securityData],
  );

  const backupStrategyOk =
    backupsData?.status?.lastFullAt !== undefined && backupsData?.status?.lastFullAt !== null;

  const baselineItems = useMemo<BaselineItem[]>(() => [
    {
      title: "访问范围",
      status:
        baseline.status === "ready"
          ? baseline.data.loopback
            ? "pass"
            : baseline.data.auth
              ? "pass"
              : "warn"
          : baseline.status === "loading"
            ? "warn"
            : "partial",
      detail:
        baseline.status === "ready"
          ? baseline.data.loopback
            ? `只允许本机访问（${baseline.data.listenHost}）${baseline.data.auth ? "，已设置访问口令" : ""}`
            : baseline.data.auth
              ? `监听在 ${baseline.data.listenHost}，同一网络的设备可以访问，已用访问口令保护`
              : `监听在 ${baseline.data.listenHost} 且没有访问口令，同一网络的任何人都能操作你的 AI`
          : baseline.status === "loading"
            ? "正在读取访问方式"
            : DEGRADED_TEXT,
    },
    {
      title: "配置自动复核",
      status: invariantAggregateItem.status,
      detail:
        security.status === "ready"
          ? security.data.watchReachable === false
            ? "管家服务暂时连不上，稍后再试"
            : security.data.invariants
                .map((item) => `${item.title}：${invariantStatusLabel(item.status)}`)
                .join("；")
          : security.status === "loading"
            ? "正在读取配置规则…"
            : DEGRADED_TEXT,
    },
    {
      title: "密钥文件保护",
      status:
        security.status === "ready"
          ? security.data.insecureSecretFiles === 0
            ? "pass"
            : "warn"
          : "partial",
      detail:
        security.status === "ready"
          ? security.data.insecureSecretFiles === 0
            ? `共检查 ${security.data.totalSecretFiles} 个密钥文件，权限都正常`
            : `有 ${security.data.insecureSecretFiles} 个密钥文件权限过宽，建议尽快改为仅本人可读`
          : security.status === "loading"
            ? "正在检查密钥文件…"
            : DEGRADED_TEXT,
    },
    {
      title: "操作记录只增不改",
      status: audit.status === "ready" ? "pass" : "partial",
      detail:
        audit.status === "ready"
          ? `已保留 ${audit.data.items.length} 条操作记录，只记录不修改`
          : audit.status === "loading"
            ? "正在读取操作记录…"
            : DEGRADED_TEXT,
    },
    {
      title: "自动备份",
      status: backupStrategyOk ? "pass" : "partial",
      detail: backupStrategyOk
        ? "每日全量 + 每小时记忆增量 + 升级/进化前自动备份"
        : backups.status === "failed"
          ? DEGRADED_TEXT
          : "首次备份后自动开启每日全量与每小时记忆增量",
    },
    {
      title: "反复崩溃自动停下",
      status:
        runbooks.status === "ready"
          ? runbooks.data.reachable === false
            ? "warn"
            : trippedRunbooks.length === 0
              ? "pass"
              : "warn"
          : runbooks.status === "failed"
            ? "warn"
            : "partial",
      detail:
        runbooks.status === "ready"
          ? runbooks.data.reachable === false
            ? "管家服务暂时连不上，无法确认熔断状态"
            : trippedRunbooks.length === 0
              ? "当前没有被暂停的自动修复方案"
              : `${trippedRunbooks.length} 个自动修复方案已暂停，需人工确认后解除`
          : runbooks.status === "loading"
            ? "正在读取修复保护状态…"
            : DEGRADED_TEXT,
    },
  ], [baseline, security, audit, backups, backupStrategyOk, invariantAggregateItem, runbooks, trippedRunbooks]);

  return (
    <Flex vertical gap={16}>
      <SectionHeader
        kicker="本机安全"
        title="本机安全检查"
        extra={<StatusBadge tone="muted" label="基础检查" />}
      />

      {baseline.status === "failed" && retryBanner("baseline", baseline.reason, onRetry)}
      {security.status === "failed" && retryBanner("security", security.reason, onRetry)}

      <List
        size="small"
        dataSource={baselineItems}
        renderItem={(item) => (
          <List.Item
            actions={[
              <Text key="state" type="secondary">
                {stateLabel(item.status)}
              </Text>,
            ]}
          >
            <List.Item.Meta
              avatar={<Badge status={statusToBadge(item.status)} />}
              title={item.title}
              description={item.detail}
            />
          </List.Item>
        )}
      />

      {security.status === "ready" && security.data.invariants.length > 0 && (
        <AdvancedDetails summary="查看配置规则详情">
          <List
            size="small"
            dataSource={security.data.invariants}
            renderItem={(item) => (
              <List.Item
                actions={[
                  <Text key="label" type="secondary">
                    {invariantStatusLabel(item.status)}
                  </Text>,
                ]}
              >
                <List.Item.Meta
                  avatar={<Badge status={statusToBadge(item.status)} />}
                  title={item.title}
                  description={item.detail}
                />
              </List.Item>
            )}
          />
        </AdvancedDetails>
      )}

      {security.status === "ready" && security.data.secrets.length > 0 && (
        <AdvancedDetails
          summary={`密钥文件权限（${security.data.insecureSecretFiles === 0 ? "全部正常" : `${security.data.insecureSecretFiles} 个需处理`}）`}
        >
          <Flex vertical gap={8}>
            <Text type="secondary">{security.data.message}</Text>
            <List
              size="small"
              dataSource={security.data.secrets}
              renderItem={(secret) => (
                <List.Item>
                  <List.Item.Meta
                    title={<Text code>{secret.rel}</Text>}
                    description={`${secret.secure ? "权限正常" : "权限过宽"} · ${secret.mode}`}
                  />
                </List.Item>
              )}
            />
          </Flex>
        </AdvancedDetails>
      )}

      <Flex vertical gap={12}>
        <SectionHeader
          compact
          kicker="自动修复保护"
          title="反复失败时会停下"
          extra={
            <StatusBadge
              tone={
                runbooks.status !== "ready" || runbooks.data.reachable === false
                  ? "muted"
                  : trippedRunbooks.length === 0
                    ? "ok"
                    : "warn"
              }
              label={
                runbooks.status === "loading"
                  ? "读取中"
                  : runbooks.status === "failed"
                    ? "暂不可用"
                    : runbooks.data.reachable === false
                      ? "服务离线"
                      : trippedRunbooks.length === 0
                        ? "运行正常"
                        : `${trippedRunbooks.length} 项已暂停`
              }
            />
          }
        />
        {runbooks.status === "loading" && <Text type="secondary">正在读取自动修复保护状态…</Text>}
        {runbooks.status === "failed" && retryBanner("runbooks", runbooks.reason, onRetry)}
        {runbooks.status === "ready" && runbooks.data.reachable && trippedRunbooks.length === 0 && (
          <Text type="secondary">10 分钟内连续失败达到阈值时，管家会暂停对应自动修复，避免无限重启。</Text>
        )}
        {runbooks.status === "ready" && !runbooks.data.reachable && (
          <Text type="secondary">管家服务暂时连不上，无法读取或解除自动修复保护。</Text>
        )}
        {runbooks.status === "ready" && runbooks.data.reachable && trippedRunbooks.length > 0 && (
          <List
            size="small"
            dataSource={trippedRunbooks}
            renderItem={(runbook) => (
              <List.Item
                actions={[
                  <Button
                    key="reset"
                    disabled={busy !== null}
                    loading={busy === `reset-${runbook.id}`}
                    onClick={() => onRequestReset(runbook)}
                  >
                    确认后解除
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  avatar={<StatusBadge tone="warn" label="已暂停" />}
                  title={runbook.label}
                  description={runbook.description || "连续失败后等待人工确认"}
                />
              </List.Item>
            )}
          />
        )}
      </Flex>

      <Flex vertical gap={12}>
        <SectionHeader compact kicker="通知方式" title="消息送达与保留" />
        {alerts.status === "failed" && retryBanner("alerts", alerts.reason, onRetry)}
        <List size="small">
          <List.Item>
            <List.Item.Meta
              avatar={<StatusBadge tone="muted" label="规则" />}
              title="按当前消息通道发送"
              description="系统只使用当前通道，不设置备用通知链路"
            />
          </List.Item>
          <List.Item>
            <List.Item.Meta
              avatar={<StatusBadge tone="muted" label="当前" />}
              title={
                alerts.status === "ready" && alerts.data.reachable
                  ? "通知服务在线"
                  : "通知服务暂时连不上"
              }
              description={
                alerts.status === "ready" && alerts.data.reachable
                  ? "当前消息通道可用"
                  : "真实发送失败仍会保留记录"
              }
            />
          </List.Item>
        </List>
      </Flex>
    </Flex>
  );
}
