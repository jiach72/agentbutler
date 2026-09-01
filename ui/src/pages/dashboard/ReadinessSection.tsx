import { CheckCircleOutlined, ExclamationCircleOutlined, ReloadOutlined, SyncOutlined } from "@ant-design/icons";
import { Badge, Button, Card, Col, Flex, Row, Typography } from "antd";
import { useMemo } from "react";
import type { ConnectionsPayload, DiscoveredLlmConfigView, LlmStatusView } from "./types.js";
import { buildLocalReadiness, type ReadinessTone } from "./readiness.js";

const { Text, Title } = Typography;

interface ReadinessSectionProps {
  connections: ConnectionsPayload | null;
  llmStatus: LlmStatusView | null;
  discoveredModels: DiscoveredLlmConfigView[] | null;
  refreshing: boolean;
  onRefresh: () => void;
}

const toneBadgeStatus = {
  ok: "success",
  warn: "warning",
  error: "error",
  idle: "default",
} as const;

function ReadinessIcon({ tone }: { tone: ReadinessTone }) {
  const color =
    tone === "ok"
      ? "var(--ant-color-success)"
      : tone === "warn"
        ? "var(--ant-color-warning)"
        : tone === "error"
          ? "var(--ant-color-error)"
          : "var(--ant-color-text-quaternary)";
  if (tone === "ok") return <CheckCircleOutlined aria-hidden="true" style={{ color }} />;
  if (tone === "idle") return <SyncOutlined spin aria-hidden="true" style={{ color }} />;
  return <ExclamationCircleOutlined aria-hidden="true" style={{ color }} />;
}

export function ReadinessSection({
  connections,
  llmStatus,
  discoveredModels,
  refreshing,
  onRefresh,
}: ReadinessSectionProps) {
  const readiness = useMemo(
    () => buildLocalReadiness(connections, llmStatus, discoveredModels),
    [connections, discoveredModels, llmStatus],
  );

  return (
    <section aria-labelledby="readiness-heading">
      <Flex vertical gap={16}>
        <Flex wrap="wrap" justify="space-between" align="flex-start" gap={16}>
          <div style={{ minWidth: 0 }}>
            <Text
              type="secondary"
              style={{ display: "block", fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}
            >
              持续就绪
            </Text>
            <Title level={4} id="readiness-heading" style={{ marginBottom: 4 }}>
              本机运行就绪度
            </Title>
            <Text type="secondary" aria-live="polite">
              <Text strong>{readiness.summary}</Text>
              {readiness.detail}
            </Text>
          </div>
          <Flex wrap="wrap" gap={8}>
            {readiness.nextAction !== undefined && (
              <Button type="primary" href={readiness.nextAction.to}>
                {readiness.nextAction.label}
              </Button>
            )}
            <Button icon={<ReloadOutlined />} loading={refreshing} onClick={onRefresh}>
              复查状态
            </Button>
          </Flex>
        </Flex>
        <Row gutter={[16, 16]}>
          {readiness.items.map((item) => (
            <Col xs={24} md={12} xl={8} key={item.id}>
              <Card size="small" style={{ height: "100%" }}>
                <Flex vertical gap={8}>
                  <Flex align="center" gap={8}>
                    <ReadinessIcon tone={item.tone} />
                    <Text strong style={{ flex: 1, minWidth: 0 }}>
                      {item.title}
                    </Text>
                    <Badge status={toneBadgeStatus[item.tone]} text={item.status} />
                  </Flex>
                  <Text type="secondary">{item.detail}</Text>
                  {item.action !== undefined && (
                    <Button type="link" href={item.action.to} style={{ paddingInline: 0 }}>
                      {item.action.label}
                    </Button>
                  )}
                </Flex>
              </Card>
            </Col>
          ))}
        </Row>
      </Flex>
    </section>
  );
}
