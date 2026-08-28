/**
 * 设置页左栏：本机安全检查、配置规则与密钥文件详情、自动修复保护、通知方式。
 * 各数据源独立三态：failed 显示降级横幅 + 重试，loading 仅在首屏短暂出现。
 */
import { useMemo } from "react";
import { Button } from "antd";
import { DegradedBanner } from "../../components/DegradedBanner.js";
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
        <Button size="small" onClick={() => onRetry(key)}>
          重试
        </Button>
      }
    />
  );
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
      title: "只允许本机访问",
      status:
        baseline.status === "ready"
          ? baseline.data.listenHost === "127.0.0.1"
            ? "pass"
            : "warn"
          : baseline.status === "loading"
            ? "warn"
            : "partial",
      detail:
        baseline.status === "ready"
          ? "只允许本机访问，局域网默认拒绝"
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
    <>
      <div className="settings-section-head">
        <div>
          <span className="product-kicker">本机安全</span>
          <h2>本机安全检查</h2>
        </div>
        <StatusBadge tone="muted" label="基础检查" />
      </div>

      {baseline.status === "failed" && retryBanner("baseline", baseline.reason, onRetry)}
      {security.status === "failed" && retryBanner("security", security.reason, onRetry)}

      <div className="baseline-list">
        {baselineItems.map((item) => (
          <article className="baseline-row" key={item.title}>
            <i className={`baseline-dot is-${item.status}`} />
            <div>
              <strong>{item.title}</strong>
              <span>{item.detail}</span>
            </div>
            <em>
              {item.status === "pass" ? "已满足" : item.status === "warn" ? "需注意" : "建设中"}
            </em>
          </article>
        ))}
      </div>

      {security.status === "ready" && security.data.invariants.length > 0 && (
        <details className="advanced-details settings-advanced">
          <summary>查看配置规则详情</summary>
          <div className="advanced-details-body">
            {security.data.invariants.map((item) => (
              <article className="invariant-row" key={item.id}>
                <i className={`baseline-dot is-${item.status}`} />
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.detail}</span>
                </div>
                <em>{invariantStatusLabel(item.status)}</em>
              </article>
            ))}
          </div>
        </details>
      )}

      {security.status === "ready" && security.data.secrets.length > 0 && (
        <details className="advanced-details settings-advanced">
          <summary>
            密钥文件权限（
            {security.data.insecureSecretFiles === 0
              ? "全部正常"
              : `${security.data.insecureSecretFiles} 个需处理`}
            ）
          </summary>
          <div className="advanced-details-body">
            <p className="hint">{security.data.message}</p>
            <ul className="secret-list">
              {security.data.secrets.map((secret) => (
                <li key={secret.rel}>
                  <code>{secret.rel}</code>
                  <span>
                    {secret.secure ? "权限正常" : "权限过宽"} · {secret.mode}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}

      <div className="settings-subsection">
        <div className="settings-section-head is-compact">
          <div>
            <span className="product-kicker">自动修复保护</span>
            <h2>反复失败时会停下</h2>
          </div>
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
        </div>
        {runbooks.status === "loading" && <p className="hint">正在读取自动修复保护状态…</p>}
        {runbooks.status === "failed" && retryBanner("runbooks", runbooks.reason, onRetry)}
        {runbooks.status === "ready" && runbooks.data.reachable && trippedRunbooks.length === 0 && (
          <p className="hint">10 分钟内连续失败达到阈值时，管家会暂停对应自动修复，避免无限重启。</p>
        )}
        {runbooks.status === "ready" && !runbooks.data.reachable && (
          <p className="hint">管家服务暂时连不上，无法读取或解除自动修复保护。</p>
        )}
        {runbooks.status === "ready" &&
          runbooks.data.reachable &&
          trippedRunbooks.map((runbook) => (
            <article className="route-row" key={runbook.id}>
              <StatusBadge tone="warn" label="已暂停" />
              <div>
                <strong>{runbook.label}</strong>
                <span>{runbook.description || "连续失败后等待人工确认"}</span>
              </div>
              <Button
                size="small"
                disabled={busy !== null}
                loading={busy === `reset-${runbook.id}`}
                onClick={() => onRequestReset(runbook)}
              >
                确认后解除
              </Button>
            </article>
          ))}
      </div>

      <div className="settings-subsection">
        <div className="settings-section-head is-compact">
          <div>
            <span className="product-kicker">通知方式</span>
            <h2>消息送达与保留</h2>
          </div>
        </div>
        {alerts.status === "failed" && retryBanner("alerts", alerts.reason, onRetry)}
        <div className="route-row">
          <StatusBadge tone="muted" label="规则" />
          <div>
            <strong>按当前消息通道发送</strong>
            <span>系统只使用当前通道，不设置备用通知链路</span>
          </div>
        </div>
        <div className="route-row">
          <StatusBadge tone="muted" label="当前" />
          <div>
            <strong>
              {alerts.status === "ready" && alerts.data.reachable
                ? "通知服务在线"
                : "通知服务暂时连不上"}
            </strong>
            <span>
              {alerts.status === "ready" && alerts.data.reachable
                ? "当前消息通道可用"
                : "真实发送失败仍会保留记录"}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
