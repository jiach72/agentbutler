/**
 * 进化页左栏：高级运行设置（antd Form）、预检清单、运行/补齐动作与结论框。
 */
import { useMemo } from "react";
import { Alert, Badge, Button, Col, Flex, Form, Input, InputNumber, Row, Typography } from "antd";
import type { FormInstance } from "antd";
import { AdvancedDetails } from "../../components/AdvancedDetails.js";
import {
  type BusyKind,
  type CheckStatus,
  HOLDOUT_RULES,
  PENDING_CHECKS,
  type PreflightOutcome,
} from "./helpers.js";

type BadgeState = "success" | "error" | "processing";

function checkStatus(status: CheckStatus): BadgeState {
  if (status === "pass") return "success";
  if (status === "fail") return "error";
  return "processing";
}

interface PreflightPanelProps {
  form: FormInstance;
  preflight: PreflightOutcome | null;
  busy: BusyKind;
  watchReachable: boolean | undefined;
  onRunPreflight: () => void;
  onExpandDataset: () => void;
}

export function PreflightPanel({
  form,
  preflight,
  busy,
  watchReachable,
  onRunPreflight,
  onExpandDataset,
}: PreflightPanelProps) {
  const checks = preflight?.checks ?? PENDING_CHECKS;
  const failedChecks = useMemo(() => checks.filter((check) => check.status === "fail"), [checks]);

  const datasetPath = Form.useWatch("datasetPath", form) ?? "";
  const seedExamples = Form.useWatch("seedExamples", form) ?? "";
  const canExpand =
    preflight?.nextAction?.kind === "expand-dataset" &&
    (datasetPath.trim() !== "" || seedExamples.trim() !== "");

  const preflightState = useMemo(() => {
    if (busy === "preflight" || busy === "expand") return "检查中";
    if (preflight === null) return "待运行";
    return preflight.allowRun ? "已通过" : "已拒绝";
  }, [busy, preflight]);

  return (
    <Flex vertical gap={16}>
      <Flex wrap="wrap" justify="space-between" align="center" gap={12}>
        <Flex vertical gap={2}>
          <Typography.Text
            type="secondary"
            style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}
          >
            开始之前
          </Typography.Text>
          <Typography.Title level={5} component="h3" style={{ marginBottom: 0 }}>
            先检查，再运行
          </Typography.Title>
        </Flex>
        <Badge
          status={
            preflight?.allowRun ? "success" : failedChecks.length > 0 ? "error" : "processing"
          }
          text={preflightState}
        />
      </Flex>

      <AdvancedDetails
        summary={
          <span>
            <strong>高级运行设置</strong>
            <small>运行依赖、模型连接和测试样本位置；普通用户通常不需要填</small>
          </span>
        }
      >
        <Row gutter={[16, 16]}>
          <Col xs={24} md={12}>
            <Form.Item name="dependencies" label="运行依赖（高级）">
              <Input />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="endpoint" label="模型连接地址">
              <Input placeholder="例如：https://你的模型地址/v1" />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="holdoutCount" label="测试样本数量" rules={HOLDOUT_RULES}>
              <InputNumber min={0} step={1} precision={0} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="instanceId" label="管家实例（可选）">
              <Input placeholder="留空自动选择正在运行的实例" />
            </Form.Item>
          </Col>
          <Col xs={24}>
            <Form.Item name="datasetPath" label="测试样本位置（可选）">
              <Input placeholder="例如：/home/你的账户/hermes/eval/test.jsonl" />
            </Form.Item>
          </Col>
        </Row>
      </AdvancedDetails>

      <Flex vertical gap={8}>
        {checks.map((check, index) => (
          <Flex
            key={check.id}
            align="flex-start"
            justify="space-between"
            gap={12}
            style={{
              animationDelay: `${index * 55}ms`,
              padding: "10px 12px",
              border: "1px solid var(--ant-color-border-secondary)",
              borderRadius: 8,
            }}
          >
            <Flex vertical gap={2} style={{ minWidth: 0 }}>
              <Flex align="center" gap={8}>
                <Badge status={checkStatus(check.status)} />
                <Typography.Text strong>{check.label}</Typography.Text>
              </Flex>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                {check.detail}
              </Typography.Paragraph>
              {check.action !== undefined && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {check.action}
                </Typography.Text>
              )}
            </Flex>
            <Badge
              status={checkStatus(check.status)}
              text={check.status === "pass" ? "通过" : check.status === "fail" ? "失败" : "待检"}
            />
          </Flex>
        ))}
      </Flex>

      <Flex align="center" gap={12}>
        <Button
          type="primary"
          loading={busy === "preflight"}
          disabled={busy !== null || watchReachable === false}
          onClick={onRunPreflight}
        >
          开始检查
        </Button>
        <Typography.Text type="secondary">
          全部通过后管家会先备份，再允许外部改进。
        </Typography.Text>
      </Flex>

      {preflight !== null && !preflight.allowRun && (
        <Alert
          type="error"
          showIcon
          title="拒绝运行"
          description={
            <Flex vertical gap={12}>
              <Typography.Text strong>{failedChecks[0]?.detail ?? "检查未通过"}</Typography.Text>
              <Typography.Text type="secondary">
                {failedChecks[0]?.action ?? "按提示处理好后重新检查。"}
              </Typography.Text>
              {preflight.nextAction?.kind === "expand-dataset" && (
                <Flex vertical gap={8}>
                  <Form.Item
                    name="seedExamples"
                    label="没有数据集路径时，粘贴 JSON 数组或 JSONL 种子样本"
                    style={{ marginBottom: 0 }}
                  >
                    <Input.TextArea
                      rows={4}
                      placeholder={'{"prompt":"示例问题","expected":"期望答案"}'}
                    />
                  </Form.Item>
                  <Button
                    loading={busy === "expand"}
                    disabled={busy !== null || !canExpand}
                    onClick={onExpandDataset}
                  >
                    {`补齐到 ${preflight.nextAction.targetCount} 条并重检`}
                  </Button>
                </Flex>
              )}
            </Flex>
          }
        />
      )}

      {preflight?.allowRun === true && (
        <Alert
          type="success"
          showIcon
          title="检查通过，可以开始改进"
          description={
            <Flex vertical gap={4}>
              <Typography.Text strong>已做好备份；改进结果确认后才会采用</Typography.Text>
              <Typography.Text type="secondary">
                管家已准备好运行环境。改进完成后，在右侧提交结果确认；确认更好才会写入。
              </Typography.Text>
            </Flex>
          }
        />
      )}
    </Flex>
  );
}
