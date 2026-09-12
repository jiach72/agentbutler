import { Button, Card, Flex, Typography } from "antd";
import { useMemo } from "react";
import { readSetupPreferences, type SetupPreferences } from "../setup/state.js";
import { getScenarioTemplate } from "../setup/templates.js";

const { Paragraph, Title } = Typography;

interface OnboardingContinuationProps {
  preferences?: SetupPreferences | null;
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
              <Title level={4} id="scenario-heading" style={{ marginBottom: 4 }}>
                选择一个常用用途
              </Title>
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                告诉管家你想先做什么，它会保留相应入口和下一步。
              </Paragraph>
            </div>
            {/* 次按钮：首屏唯一的主动作留给结论条的「立即检查」（规范 §1 P2 一个动作）。 */}
            <Button href="/setup">开始设置</Button>
          </Flex>
        </Card>
      </section>
    );
  }

  return null;
}
