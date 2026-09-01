/**
 * 进化页右栏门禁区：真实评估入口提示、评估结果、兼容手填表单与门禁结论。
 */
import {
  Alert,
  Button,
  Checkbox,
  Col,
  Flex,
  Form,
  Input,
  InputNumber,
  Row,
  Typography,
} from "antd";
import type { FormInstance } from "antd";
import { AdvancedDetails } from "../../components/AdvancedDetails.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import {
  type BusyKind,
  type EvaluationOutcome,
  type GateOutcome,
  METRIC_RULES,
  outcomeTone,
  statusLabel,
} from "./helpers.js";

interface GateDecisionPanelProps {
  form: FormInstance;
  gateReady: boolean;
  gate: GateOutcome | null;
  evaluation: EvaluationOutcome | null;
  busy: BusyKind;
  onStartEvaluate: () => void;
  onSubmitGate: () => void;
}

export function GateDecisionPanel({
  gateReady,
  gate,
  evaluation,
  busy,
  onStartEvaluate,
  onSubmitGate,
}: GateDecisionPanelProps) {
  return (
    <>
      {gateReady && (
        <Alert
          type="info"
          showIcon
          title="可以开始真实评估"
          description="管家会调用已配置的外部评估器，自动返回样本数、当前版本与改进方案的指标、把握程度和是否允许采用。"
          action={
            <Button type="primary" loading={busy === "evaluate"} onClick={onStartEvaluate}>
              开始真实评估
            </Button>
          }
        />
      )}

      {evaluation !== null && (
        <Alert
          type={
            evaluation.status === "accepted"
              ? "success"
              : evaluation.status === "rejected-regression"
                ? "error"
                : "warning"
          }
          showIcon
          title={statusLabel(evaluation.status)}
          description={`样本 ${evaluation.sampleCount} 条 · ${evaluation.baselineMetric.toFixed(3)} → ${evaluation.candidateMetric.toFixed(3)} · 变化 ${(evaluation.candidateMetric - evaluation.baselineMetric).toFixed(3)}${evaluation.confidence === null ? "" : ` · 把握程度 ${(evaluation.confidence * 100).toFixed(1)}%`}`}
          action={
            <StatusBadge
              tone={evaluation.canPromote ? "ok" : "muted"}
              label={evaluation.canPromote ? "可申请采用" : "保留当前版本"}
            />
          }
        />
      )}

      {gateReady && (
        <AdvancedDetails
          summary={
            <span>
              <strong>兼容：手动提交外部评估结果</strong>
              <small>优先使用上方“开始真实评估”；此处仅兼容尚未接入标准响应格式的旧评估器</small>
            </span>
          }
        >
          <Flex vertical gap={16}>
            <Flex vertical gap={2}>
              <Typography.Text strong>填写评估结果</Typography.Text>
              <Typography.Text type="secondary">
                管家会保存你提交的结论，不会擅自判断好坏。
              </Typography.Text>
            </Flex>
            <Row gutter={[16, 16]}>
              <Col xs={24} sm={12}>
                <Form.Item name="baselineMetric" label="当前版本表现" rules={METRIC_RULES}>
                  <InputNumber step="any" style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12}>
                <Form.Item name="candidateMetric" label="改进后表现" rules={METRIC_RULES}>
                  <InputNumber step="any" style={{ width: "100%" }} />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item name="significant" valuePropName="checked">
              <Checkbox>我确认改进后确实更好</Checkbox>
            </Form.Item>
            <Form.Item name="rootCause" label="为什么有变化（可选）">
              <Input.TextArea rows={2} />
            </Form.Item>
            <Form.Item name="fixes" label="做了哪些修复（可选）">
              <Input.TextArea rows={2} />
            </Form.Item>
            <Button
              type="primary"
              loading={busy === "gate"}
              disabled={busy !== null}
              onClick={onSubmitGate}
            >
              确认结果
            </Button>
          </Flex>
        </AdvancedDetails>
      )}

      {gate !== null && (
        <Flex
          vertical
          gap={8}
          style={{
            border: "1px solid var(--ant-color-border-secondary)",
            borderRadius: 8,
            padding: 16,
          }}
        >
          <Flex align="center" gap={8}>
            <StatusBadge
              tone={outcomeTone(gate.status)}
              label={gate.status === "accepted" ? "仅记录通过" : "暂不采用"}
            />
            <Typography.Text strong>
              {statusLabel(gate.status)}
              {gate.delta !== null
                ? ` · 变化 ${gate.delta >= 0 ? "+" : ""}${gate.delta.toFixed(6)}`
                : ""}
            </Typography.Text>
          </Flex>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            当前版本已保留。手填指标不会授权写入，正式采用需通过服务端受信提升入口。
          </Typography.Paragraph>
        </Flex>
      )}
    </>
  );
}
