/**
 * 第 2 步：展示查到了什么，以及凭什么这么说。
 *
 * 关键设计：**先给证据，再给结论**。用户看到「最近一次 5 分钟前，累计 17 次」
 * 自己就能判断严不严重；只丢一句「系统错误」他只能瞎猜或者吓一跳。
 */
import { Alert, Button, Card, Flex, Space, Typography } from "antd";
import { formatRelative } from "../../../lib/format.js";
import { StatusBadge } from "../../../components/StatusBadge.js";
import type { RecoveryDiagnosisView, RecoveryEvidenceView } from "../../dashboard/types.js";
import type { SymptomId } from "../symptoms.js";
import { findSymptom } from "../symptoms.js";
import { WizardNav } from "./SymptomStep.js";

/** 把证据说成人话。 */
function evidenceText(evidence: RecoveryEvidenceView): string {
  const parts: string[] = [];
  if (evidence.lastSeenLabel !== null) parts.push(`最近一次 ${evidence.lastSeenLabel}`);
  if (evidence.occurrences > 0) parts.push(`累计 ${evidence.occurrences} 次`);
  if (evidence.source !== null && evidence.source !== "") parts.push(`来源 ${evidence.source}`);
  return parts.length === 0 ? "时间不明确" : parts.join(" · ");
}

const PROBE_STATUS: Record<string, { label: string; tone: "ok" | "warn" | "error" | "muted" }> = {
  pass: { label: "正常", tone: "ok" },
  warn: { label: "需留意", tone: "warn" },
  fail: { label: "不正常", tone: "error" },
};

interface EvidenceStepProps {
  diagnosis: RecoveryDiagnosisView;
  symptom: SymptomId;
  onBack: () => void;
  onNext: () => void;
}

export function EvidenceStep({ diagnosis, symptom, onBack, onNext }: EvidenceStepProps) {
  const primary = diagnosis.primaryFinding;
  const historical = diagnosis.historicalFindingCount;

  return (
    <Flex vertical gap={16}>
      <Typography.Title level={4} style={{ marginBottom: 0 }}>查完了，结果是这样</Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        你反馈的是「{findSymptom(symptom).label}」，下面是各项检查的结果和依据。
      </Typography.Paragraph>

      {diagnosis.rootCause !== null ? (
        <Alert
          type="error"
          showIcon
          message={`找到明确的问题：${diagnosis.rootCause}`}
          description={`${diagnosis.summary ?? "这项检查没有通过"}${diagnosis.safeToRetry === false ? "；不建议直接重试，请先按下一步处理。" : "；下一步可以选择对应的处理方式。"}`}
        />
      ) : primary !== null ? (
        <Alert
          type="warning"
          showIcon
          message={`运行正常，但日志里有提醒：${primary.title}`}
          description={`${primary.detail}（${evidenceText(primary.evidence)}）`}
        />
      ) : (
        <Alert
          type="success"
          showIcon
          message="检查项全部通过"
          description={
            historical > 0
              ? `最近没有新问题。更早的日志里有 ${historical} 条历史提醒，不影响当前运行。`
              : "没有发现需要处理的问题。"
          }
        />
      )}

      <Flex vertical gap={10}>
        {diagnosis.probes.map((probe) => {
          const status = PROBE_STATUS[probe.status] ?? { label: probe.status, tone: "muted" as const };
          return (
            <Flex align="flex-start" gap={10} key={probe.id} style={{ padding: "10px 12px", border: "1px solid var(--ant-color-split)", borderRadius: 8 }}>
              <StatusBadge tone={status.tone} label={status.label} />
              <Flex vertical>
                <Typography.Text strong>{probe.label}</Typography.Text>
                <Typography.Text type="secondary">{probe.detail}</Typography.Text>
              </Flex>
            </Flex>
          );
        })}
      </Flex>

      {diagnosis.findings.length > 0 && (
        <Card size="small" variant="outlined">
          <Flex vertical gap={10}>
            <Typography.Title level={5} style={{ marginBottom: 0 }}>最近一天共 {diagnosis.findings.length} 类提醒</Typography.Title>
            <Flex vertical gap={10}>
              {diagnosis.findings.map((finding) => (
                <Flex wrap gap={8} align="baseline" key={finding.id}>
                  <Typography.Text>{finding.title}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{evidenceText(finding.evidence)}</Typography.Text>
                  <Typography.Text type="secondary" style={{ flex: "1 0 100%" }}>{finding.detail}</Typography.Text>
                </Flex>
              ))}
            </Flex>
          </Flex>
        </Card>
      )}

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>检查时间：{formatRelative(diagnosis.checkedAt)}</Typography.Text>

      <WizardNav onBack={onBack} onNext={onNext} nextLabel="看看能怎么处理" />
      <Space wrap>
        <Button type="link" href="/logs">
          想看原始日志
        </Button>
      </Space>
    </Flex>
  );
}
