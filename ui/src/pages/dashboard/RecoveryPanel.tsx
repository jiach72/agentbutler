/**
 * 专业处理区：先诊断再按低/中/高风险分级修复；探针结果与动作卡片。
 */
import { Alert, Badge, Button, Card, Col, Flex, Progress, Row, Typography } from "antd";
import { StatusBadge } from "../../components/StatusBadge.js";
import { formatRelative } from "../../lib/format.js";
import { quickProbeBadge } from "./helpers.js";
import type {
  RecoveryActionView,
  RecoveryDiagnosisView,
  RecoveryEvidenceView,
  RecoveryJobView,
} from "./types.js";

const { Text, Title } = Typography;

/**
 * 把证据说成人话。用户看到「最近 2 小时出现 17 次，最近一次 5 分钟前」就知道该不该紧张；
 * 只丢一句「内存不足」他只能瞎猜。
 */
function evidenceText(evidence: RecoveryEvidenceView): string {
  const parts: string[] = [];
  if (evidence.lastSeenLabel !== null) parts.push(`最近一次 ${evidence.lastSeenLabel}`);
  if (evidence.occurrences > 0) parts.push(`累计 ${evidence.occurrences} 次`);
  if (evidence.source !== null && evidence.source !== "") parts.push(`来源 ${evidence.source}`);
  return parts.length === 0 ? "时间不明确" : parts.join(" · ");
}

/** 结论区：探针失败才叫「根因」，日志里的问题只叫「发现」。 */
function conclusion(recovery: RecoveryDiagnosisView): {
  type: "success" | "warning" | "error";
  title: string;
  description: string;
} {
  if (recovery.rootCause !== null) {
    return {
      type: "error",
      title: `发现明确的问题：${recovery.rootCause}`,
      description: "这项检查没有通过，下面按风险从低到高列出可以做的处理。",
    };
  }
  const primary = recovery.primaryFinding;
  if (primary !== null) {
    return {
      type: "warning",
      title: `运行正常，但日志里有提醒：${primary.title}`,
      description: `${primary.detail}（${evidenceText(primary.evidence)}）`,
    };
  }
  return {
    type: "success",
    title: "没有发现问题",
    description:
      recovery.historicalFindingCount > 0
        ? `检查项全部通过。更早的日志里有 ${recovery.historicalFindingCount} 条历史提醒，不影响当前运行，需要的话可以看系统日志。`
        : "检查项全部通过，最近日志也没有已知错误。",
  };
}

interface RecoveryPanelProps {
  recovery: RecoveryDiagnosisView | null;
  busy: boolean;
  onDiagnose: () => void;
  onExecute: (action: RecoveryActionView) => void;
  onRequestConfirm: (action: RecoveryActionView) => void;
  job?: RecoveryJobView | null;
}

export function RecoveryPanel({
  recovery,
  busy,
  onDiagnose,
  onExecute,
  onRequestConfirm,
  job = null,
}: RecoveryPanelProps) {
  return (
    <section aria-live="polite">
      <Flex vertical gap={16}>
        <Flex wrap justify="space-between" align="flex-start" gap={16}>
          <div style={{ minWidth: 0 }}>
            <Text
              type="secondary"
              style={{ display: "block", fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}
            >
              诊断
            </Text>
            <Title level={4} style={{ marginBottom: 0 }}>
              检查项与处理
            </Title>
          </div>
          <Button loading={busy} onClick={onDiagnose}>
            重新诊断
          </Button>
        </Flex>
        {recovery === null ? (
          <Alert
            type="info"
            showIcon
            title="正在读取诊断结果"
            description="完成后会显示检查结果、问题依据和可执行处理。"
          />
        ) : (
          <>
            {job !== null && (
              <Card size="small" aria-live="polite">
                <Flex vertical gap={4}>
                  <Flex justify="space-between" align="center" gap={8}>
                    <Text strong>{job.label}</Text>
                    <Badge
                      status={
                        job.status === "done" ? "success" : job.status === "failed" ? "error" : "processing"
                      }
                      text={
                        job.status === "done" ? "已完成" : job.status === "failed" ? "执行失败" : "执行中"
                      }
                    />
                  </Flex>
                  <Progress
                    percent={job.progress}
                    status={job.status === "failed" ? "exception" : job.status === "done" ? "success" : "active"}
                  />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {job.detail}
                  </Text>
                </Flex>
              </Card>
            )}
            {(() => {
              const verdict = conclusion(recovery);
              return (
                <Alert
                  type={verdict.type}
                  showIcon
                  title={verdict.title}
                  description={
                    <Flex vertical gap={2}>
                      <span>{verdict.description}</span>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        诊断时间：{formatRelative(recovery.checkedAt)}
                      </Text>
                    </Flex>
                  }
                />
              );
            })()}
            {recovery.findings.length > 1 && (
              <Card size="small" title={`最近一天共 ${recovery.findings.length} 类提醒`}>
                <Flex vertical gap={8}>
                  {recovery.findings.map((finding) => (
                    <Flex key={finding.id} vertical gap={2}>
                      <Text strong style={{ fontSize: 13 }}>
                        {finding.title}
                      </Text>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {evidenceText(finding.evidence)}
                      </Text>
                    </Flex>
                  ))}
                </Flex>
              </Card>
            )}
            <Flex wrap="wrap" gap={4}>
              {recovery.probes.map((probe) => {
                const badge = quickProbeBadge(probe.status);
                return (
                  <StatusBadge
                    key={probe.id}
                    tone={badge.tone}
                    title={probe.detail}
                    label={`${probe.label}：${badge.label}`}
                  />
                );
              })}
            </Flex>
            <Row gutter={[8, 8]}>
              {recovery.recommendedActions.map((action) => (
                <Col xs={24} md={12} key={action.id}>
                  <Card
                    size="small"
                    style={{ height: "100%" }}
                    styles={{ body: { display: "flex", flexDirection: "column", gap: 8 } }}
                  >
                    <Flex justify="space-between" align="center" gap={8}>
                      <Text strong>{action.label}</Text>
                      <Badge
                        status={
                          action.risk === "high" ? "error" : action.risk === "medium" ? "warning" : "success"
                        }
                        text={action.risk === "high" ? "高风险" : action.risk === "medium" ? "需确认" : "低风险"}
                      />
                    </Flex>
                    <span style={{ fontSize: 13 }}>{action.description}</span>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {action.impact} · 约 {action.estimatedSeconds} 秒
                    </Text>
                    {!action.available && action.unavailableFix && (
                      <Text type="warning" style={{ fontSize: 12 }}>
                        解决：{action.unavailableFix}
                      </Text>
                    )}
                    <div>
                      <Button
                        type={action.risk === "high" ? "primary" : "default"}
                        danger={action.risk === "high"}
                        disabled={!action.available || busy}
                        onClick={() => (action.requiresConfirmation ? onRequestConfirm(action) : onExecute(action))}
                      >
                        {!action.available ? action.unavailableReason ?? "暂不可用" : action.requiresConfirmation ? "确认执行" : "执行"}
                      </Button>
                    </div>
                  </Card>
                </Col>
              ))}
            </Row>
          </>
        )}
      </Flex>
    </section>
  );
}
