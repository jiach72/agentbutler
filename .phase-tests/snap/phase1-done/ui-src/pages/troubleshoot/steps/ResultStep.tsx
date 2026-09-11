/**
 * 第 4 步：给一个明确的成败结论。
 *
 * 最忌讳的是"执行完了"这种没有结论的话。用户需要知道：
 * 到底修好了没有？没修好现在是什么状态（有没有被我搞坏）？接下来还能做什么？
 * 展示层与全站统一：结论块按成败分层（绿/红/蓝），按钮条与各步骤一致。
 */
import { CheckCircleOutlined, CloseCircleOutlined, InfoCircleOutlined } from "@ant-design/icons";
import { Button, Card, Flex, Progress, Space, Typography } from "antd";
import { SectionHeader } from "../../../components/SectionHeader.js";
import type { RecoveryDiagnosisView, RecoveryJobView } from "../../dashboard/types.js";
import type { WizardOutcome } from "../useTroubleshoot.js";
import { useExportReport } from "../exportReport.js";
import { guidanceForDiagnosis } from "../guidance.js";

const { Text, Paragraph } = Typography;

interface ResultStepProps {
  job: RecoveryJobView | null;
  outcome: WizardOutcome | null;
  diagnosis: RecoveryDiagnosisView | null;
  busy: boolean;
  onBack: () => void;
  onRestart: () => void;
}

export function ResultStep({ job, outcome, diagnosis, busy, onBack, onRestart }: ResultStepProps) {
  const { exportReport } = useExportReport();
  const running = job !== null && job.status === "running";
  const guidance = guidanceForDiagnosis(diagnosis);

  return (
    <Card size="small">
      <Flex vertical gap={16}>
        <SectionHeader
          kicker="确认结果"
          title={running ? "正在处理…" : outcome === null ? "处理完成" : outcome.label}
        />

        {running && job !== null && (
          <Flex vertical gap={12}>
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>{job.detail}</Paragraph>
            <Progress percent={job.progress} status="active" />
            <Text type="secondary" role="status">
              这一步大概需要一点时间，页面会自动更新结果，不用手动刷新。
            </Text>
          </Flex>
        )}

        {!running && outcome !== null && (
          <Flex className={`ts-result ${outcome.state === "fixed" ? "is-ok" : "is-fail"}`} gap={10}>
            {outcome.state === "fixed" ? (
              <CheckCircleOutlined className="ts-result-icon" aria-hidden="true" />
            ) : (
              <CloseCircleOutlined className="ts-result-icon" aria-hidden="true" />
            )}
            <Flex vertical gap={2} style={{ minWidth: 0 }}>
              <Text strong>{outcome.label}</Text>
              <Text type="secondary" style={{ fontSize: 13 }}>{outcome.detail}</Text>
            </Flex>
          </Flex>
        )}

        {!running && outcome === null && (
          <Flex className="ts-result is-info" gap={10}>
            <InfoCircleOutlined className="ts-result-icon" aria-hidden="true" />
            <Flex vertical gap={2} style={{ minWidth: 0 }}>
              <Text strong>正在复查处理结果</Text>
              <Text type="secondary" style={{ fontSize: 13 }}>
                动作已经执行完，管家正在确认问题是否解决，稍等一下就会给出结论。
              </Text>
            </Flex>
          </Flex>
        )}

        {!running && (
          <div className="ts-nav">
            <Flex vertical gap={8}>
              <Space wrap>
                {outcome?.state === "unresolved" && (
                  <>
                    <Button type="primary" onClick={onBack}>换个办法再试</Button>
                    <Button href={guidance.to}>{guidance.label}</Button>
                  </>
                )}
                <Button onClick={() => void exportReport()} loading={busy}>
                  下载诊断报告
                </Button>
                <Button type="link" onClick={onRestart}>
                  重新排查
                </Button>
              </Space>
              <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
                没修好也不用担心：管家在每个动作执行前都做了快照，不会把状态搞得更糟。
                {outcome?.state === "unresolved" ? ` ${guidance.detail}` : " 下载报告后贴到项目的 Issue 里，能帮你的人一眼就能看到全貌。"}
              </Paragraph>
            </Flex>
          </div>
        )}
      </Flex>
    </Card>
  );
}
