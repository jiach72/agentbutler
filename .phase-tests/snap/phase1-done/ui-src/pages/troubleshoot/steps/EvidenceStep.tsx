/**
 * 第 2 步：展示查到了什么，以及凭什么这么说。
 *
 * 关键设计：**先给证据，再给结论**。用户看到「最近一次 5 分钟前，累计 17 次」
 * 自己就能判断严不严重；只丢一句「系统错误」他只能瞎猜或者吓一跳。
 * 展示层与全站统一：结论块按成败分层（绿/黄/红），检查行用统一的卡片语言。
 */
import { CheckCircleOutlined, CloseCircleOutlined, ExclamationCircleOutlined } from "@ant-design/icons";
import { Button, Card, Flex, Space, Typography } from "antd";
import { formatRelative } from "../../../lib/format.js";
import { SectionHeader } from "../../../components/SectionHeader.js";
import { StatusBadge } from "../../../components/StatusBadge.js";
import type { RecoveryDiagnosisView, RecoveryEvidenceView } from "../../dashboard/types.js";
import type { SymptomId } from "../symptoms.js";
import { findSymptom } from "../symptoms.js";
import { WizardNav } from "./SymptomStep.js";

const { Text, Paragraph } = Typography;

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
    <Card size="small">
      <Flex vertical gap={16}>
        <SectionHeader
          kicker="查看证据"
          title="查完了，结果是这样"
          extra={<Text type="secondary" style={{ fontSize: 12 }}>检查时间：{formatRelative(diagnosis.checkedAt)}</Text>}
        />
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          你反馈的是「{findSymptom(symptom).label}」，下面是各项检查的结果和依据。
        </Paragraph>

        {diagnosis.rootCause !== null ? (
          <Flex className="ts-result is-fail" gap={10}>
            <CloseCircleOutlined className="ts-result-icon" aria-hidden="true" />
            <Flex vertical gap={2} style={{ minWidth: 0 }}>
              <Text strong>{`找到明确的问题：${diagnosis.rootCause}`}</Text>
              <Text type="secondary" style={{ fontSize: 13 }}>
                {`${diagnosis.summary ?? "这项检查没有通过"}${diagnosis.safeToRetry === false ? "；不建议直接重试，请先按下一步处理。" : "；下一步可以选择对应的处理方式。"}`}
              </Text>
            </Flex>
          </Flex>
        ) : primary !== null ? (
          <Flex className="ts-result is-warn" gap={10}>
            <ExclamationCircleOutlined className="ts-result-icon" aria-hidden="true" />
            <Flex vertical gap={2} style={{ minWidth: 0 }}>
              <Text strong>{`运行正常，但日志里有提醒：${primary.title}`}</Text>
              <Text type="secondary" style={{ fontSize: 13 }}>
                {`${primary.detail}（${evidenceText(primary.evidence)}）`}
              </Text>
            </Flex>
          </Flex>
        ) : (
          <Flex className="ts-result is-ok" gap={10}>
            <CheckCircleOutlined className="ts-result-icon" aria-hidden="true" />
            <Flex vertical gap={2} style={{ minWidth: 0 }}>
              <Text strong>检查项全部通过</Text>
              <Text type="secondary" style={{ fontSize: 13 }}>
                {historical > 0
                  ? `最近没有新问题。更早的日志里有 ${historical} 条历史提醒，不影响当前运行。`
                  : "没有发现需要处理的问题。"}
              </Text>
            </Flex>
          </Flex>
        )}

        <Flex vertical gap={8}>
          {diagnosis.probes.map((probe) => {
            const status = PROBE_STATUS[probe.status] ?? { label: probe.status, tone: "muted" as const };
            return (
              <Flex align="flex-start" gap={10} key={probe.id} className="ts-probe-row">
                <StatusBadge tone={status.tone} label={status.label} />
                <Flex vertical style={{ minWidth: 0 }}>
                  <Text strong>{probe.label}</Text>
                  <Text type="secondary">{probe.detail}</Text>
                </Flex>
              </Flex>
            );
          })}
        </Flex>

        {diagnosis.findings.length > 0 && (
          <Card size="small" variant="outlined">
            <Flex vertical gap={10}>
              <SectionHeader compact kicker="历史提醒" title={`最近一天共 ${diagnosis.findings.length} 类提醒`} />
              <Flex vertical gap={10}>
                {diagnosis.findings.map((finding) => (
                  <Flex wrap gap={8} align="baseline" key={finding.id}>
                    <Text>{finding.title}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>{evidenceText(finding.evidence)}</Text>
                    <Text type="secondary" style={{ flex: "1 0 100%" }}>{finding.detail}</Text>
                  </Flex>
                ))}
              </Flex>
            </Flex>
          </Card>
        )}

        <WizardNav onBack={onBack} onNext={onNext} nextLabel="看看能怎么处理" />
        <Space wrap>
          <Button type="link" href="/logs">
            想看原始日志
          </Button>
        </Space>
      </Flex>
    </Card>
  );
}
