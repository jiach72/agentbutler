/**
 * 体检总览（排查页新首屏）：进入页面即静默体检，先给结论再给人操作。
 *
 * 三种形态：
 * - 全绿：0 操作，告诉用户「没事」，附检查明细（收起）；
 * - 有提醒（warn）：结论 + 推荐动作（1 键执行，无需进向导）；
 * - 有问题（error）：最可能的原因 + 推荐动作 1 键执行 + 全部动作进阶入口。
 *
 * 产品原则：用户带着焦虑来，第一屏必须是答案而不是选择题。
 * 现象选择不删除——降级为「按我的感受重新聚焦」，只影响排序不隐藏信息。
 */
import { CaretRightOutlined, ExclamationCircleOutlined, CheckCircleOutlined, CloseCircleOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Card, Collapse, Flex, Progress, Space, Typography } from "antd";
import { StatusBadge } from "../../../components/StatusBadge.js";
import { formatRelative } from "../../../lib/format.js";
import type { RecoveryActionView, RecoveryDiagnosisView } from "../../dashboard/types.js";
import type { TriageSummary } from "../useTroubleshoot.js";
import { useExportReport } from "../exportReport.js";
import { guidanceForDiagnosis } from "../guidance.js";

const { Text, Paragraph } = Typography;

const PROBE_STATUS: Record<string, { label: string; tone: "ok" | "warn" | "error" | "unknown" }> = {
  pass: { label: "正常", tone: "ok" },
  warn: { label: "需留意", tone: "warn" },
  fail: { label: "不正常", tone: "error" },
};

/** 推荐动作卡：风险用后果说（会中断服务），不用等级说（high risk）。 */
const RISK_LABEL: Record<RecoveryActionView["risk"], { text: string; tone: "ok" | "warn" | "error" }> = {
  low: { text: "不影响使用", tone: "ok" },
  medium: { text: "会有短暂影响", tone: "warn" },
  high: { text: "会中断服务", tone: "error" },
};

interface TriageOverviewProps {
  triage: TriageSummary | null;
  triageBusy: boolean;
  diagnosis: RecoveryDiagnosisView | null;
  recommended: RecoveryActionView | null;
  alternatives: RecoveryActionView[];
  jobRunning: boolean;
  jobDetail: string;
  jobProgress: number;
  busy: boolean;
  onRerun: () => void;
  onRunAction: (action: RecoveryActionView) => void;
  onOpenWizard: () => void;
}

export function TriageOverview({
  triage,
  triageBusy,
  diagnosis,
  recommended,
  alternatives,
  jobRunning,
  jobDetail,
  jobProgress,
  busy,
  onRerun,
  onRunAction,
  onOpenWizard,
}: TriageOverviewProps) {
  const { exportReport } = useExportReport();

  if (triage === null) {
    return (
      <Card size="small">
        <Flex vertical gap={12} align="flex-start">
          {triageBusy ? (
            <>
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                正在做一轮完整体检（进程、接口、记忆、消息通道、模型连接），完成后自动出结论，不用刷新页面。
              </Paragraph>
              <Progress percent={60} status="active" showInfo={false} style={{ width: 240 }} />
            </>
          ) : (
            <>
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                刚才这轮体检没有读到结果，可能是管家服务暂时不可用。
              </Paragraph>
              <Button type="primary" icon={<ReloadOutlined />} onClick={onRerun}>再试一次</Button>
            </>
          )}
        </Flex>
      </Card>
    );
  }

  const tone = triage.tone;
  const guidance = guidanceForDiagnosis(diagnosis);

  return (
    <Flex vertical gap={16}>
 {/* 结论块：一眼定性 */}
      <Flex className={`ts-result ${tone === "ok" ? "is-ok" : tone === "warn" ? "is-warn" : "is-fail"}`} gap={12}>
        {tone === "ok" ? (
          <CheckCircleOutlined className="ts-result-icon" aria-hidden="true" />
        ) : tone === "warn" ? (
          <ExclamationCircleOutlined className="ts-result-icon" aria-hidden="true" />
        ) : (
          <CloseCircleOutlined className="ts-result-icon" aria-hidden="true" />
        )}
        <Flex vertical gap={2} style={{ minWidth: 0, flex: 1 }}>
          <Text strong style={{ fontSize: 15 }}>{triage.title}</Text>
          {triage.rootCause !== null && (
            <Text style={{ fontSize: 13 }}>
              最可能的原因：<Text strong>{triage.rootCause}</Text>
            </Text>
          )}
          <Text type="secondary" style={{ fontSize: 13 }}>{triage.detail}</Text>
          {diagnosis !== null && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              检查时间：{formatRelative(diagnosis.checkedAt)} · 共 {diagnosis.probes.length} 项检查
            </Text>
          )}
        </Flex>
        <Button size="small" type="text" icon={<ReloadOutlined />} aria-label="重新体检" onClick={onRerun} loading={triageBusy || busy} />
      </Flex>

      {/* 动作执行中：进度条 + 实时说明 */}
      {jobRunning && (
        <Card size="small">
          <Flex vertical gap={8}>
            <Text strong>正在执行处理动作…</Text>
            <Text type="secondary">{jobDetail}</Text>
            <Progress percent={jobProgress} status="active" />
            <Text type="secondary" style={{ fontSize: 12 }}>
              执行前已自动创建状态快照，不会把状态搞得更糟。完成后会自动复查并更新上方的结论。
            </Text>
          </Flex>
        </Card>
      )}

      {/* 有问题/有提醒：推荐动作直达 */}
      {tone !== "ok" && recommended !== null && !jobRunning && (
        <Card size="small" className="ts-reco-card" styles={{ body: { padding: "14px 16px" } }}>
          <Flex vertical gap={12}>
            <Flex align="center" gap={8} wrap>
              <Text strong style={{ fontSize: 14 }}>建议先试：</Text>
              <StatusBadge tone="brand" label="推荐" />
              <Text strong>{recommended.label}</Text>
              <StatusBadge tone={RISK_LABEL[recommended.risk].tone} label={RISK_LABEL[recommended.risk].text} />
            </Flex>
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {recommended.description} · 约 {recommended.estimatedSeconds} 秒。
              {recommended.requiresConfirmation ? " 执行前会再让你确认一次。" : " 不会打断现有使用。"}
            </Paragraph>
            <Space wrap>
              <Button
                type="primary"
                icon={<CaretRightOutlined />}
                loading={busy}
                onClick={() => onRunAction(recommended)}
              >
                执行「{recommended.label}」
              </Button>
              {alternatives.length > 0 && (
                <Button onClick={onOpenWizard}>还有 {alternatives.length + 1} 个办法可选</Button>
              )}
            </Space>
          </Flex>
        </Card>
      )}

      {/* 检查明细 + 其他出口：收进折叠，不抢主结论的戏 */}
      <Collapse
        size="small"
        items={[
          {
            key: "probes",
            label: (
              <span className="ts-collapse-label">
                <span>检查明细</span>
                <span className="ts-collapse-extra">
                  {diagnosis === null ? "" : `${diagnosis.probes.filter((p) => p.status === "pass").length}/${diagnosis.probes.length} 项通过`}
                </span>
              </span>
            ),
            children: (
              <Flex vertical gap={8}>
                {(diagnosis?.probes ?? []).map((probe) => {
                  const status = PROBE_STATUS[probe.status] ?? { label: probe.status, tone: "unknown" as const };
                  return (
                    <Flex align="flex-start" gap={10} key={probe.id} className="ts-probe-row">
                      <StatusBadge tone={status.tone} label={status.label} />
                      <Flex vertical style={{ minWidth: 0 }}>
                        <Text strong>{probe.label}</Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>{probe.detail}</Text>
                      </Flex>
                    </Flex>
                  );
                })}
              </Flex>
            ),
          },
        ]}
      />

      {/* 底部出口：主次分明，向导入口弱化为文字链 */}
      <div className="ts-footer-links">
        <Button type="primary" ghost onClick={onOpenWizard}>按现象仔细查（完整向导）</Button>
        {tone !== "ok" && <Button onClick={() => window.location.assign(guidance.to)}>{guidance.label}</Button>}
        <Button type="text" onClick={() => void exportReport()}>下载诊断报告</Button>
      </div>
    </Flex>
  );
}
