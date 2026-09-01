import { EditOutlined, RightOutlined } from "@ant-design/icons";
import { Button, Card, Flex, Typography } from "antd";
import { useMemo } from "react";
import { readSetupPreferences, type SetupPreferences } from "../setup/state.js";
import { getScenarioTemplate } from "../setup/templates.js";

const { Paragraph, Text, Title } = Typography;

interface OnboardingContinuationProps {
  preferences?: SetupPreferences | null;
}

function ScenarioKicker({ children }: { children: string }) {
  return (
    <Text
      type="secondary"
      style={{ display: "block", fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}
    >
      {children}
    </Text>
  );
}

export function OnboardingContinuation({ preferences: suppliedPreferences }: OnboardingContinuationProps) {
  const preferences = useMemo(
    () => suppliedPreferences === undefined ? readSetupPreferences() : suppliedPreferences,
    [suppliedPreferences],
  );
  const scenario = getScenarioTemplate(preferences?.templateId);

  if (scenario === null) {
    return (
      <section aria-labelledby="scenario-heading">
        <Card size="small">
          <Flex wrap="wrap" justify="space-between" align="center" gap={16}>
            <div style={{ minWidth: 0 }}>
              <ScenarioKicker>常用场景</ScenarioKicker>
              <Title level={4} id="scenario-heading" style={{ marginBottom: 4 }}>
                选择一个常用用途
              </Title>
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                告诉管家你想先做什么，它会保留相应入口和下一步。
              </Paragraph>
            </div>
            <Button type="primary" href="/setup">开始设置</Button>
          </Flex>
        </Card>
      </section>
    );
  }

  const canContinueElsewhere = scenario.destination !== "/dashboard";
  return (
    <section aria-labelledby="scenario-heading">
      <Card size="small">
        <Flex wrap="wrap" justify="space-between" align="center" gap={16}>
          <div style={{ minWidth: 0 }}>
            <ScenarioKicker>你的常用场景</ScenarioKicker>
            <Title level={4} id="scenario-heading" style={{ marginBottom: 4 }}>
              {scenario.label}
            </Title>
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {scenario.description}
            </Paragraph>
          </div>
          <Flex wrap="wrap" gap={8}>
            {canContinueElsewhere && (
              <Button
                type="primary"
                href={scenario.destination}
                icon={<RightOutlined />}
                iconPlacement="end"
              >
                {scenario.nextLabel}
              </Button>
            )}
            <Button href="/setup" icon={<EditOutlined />}>重新设置</Button>
          </Flex>
        </Flex>
      </Card>
    </section>
  );
}
