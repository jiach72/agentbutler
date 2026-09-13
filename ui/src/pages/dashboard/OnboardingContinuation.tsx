import { Button, Card, Flex, Typography } from "antd";
import { CloseOutlined } from "@ant-design/icons";
import { useMemo, useState } from "react";
import { readSetupPreferences, type SetupPreferences } from "../setup/state.js";
import { getScenarioTemplate } from "../setup/templates.js";
import { dismissOnboardingContinuation, readOnboardingDismissed } from "./onboardingDismiss.js";

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
  const [dismissed, setDismissed] = useState<boolean>(() => readOnboardingDismissed());

  if (scenario === null) {
    if (dismissed) return null;
    const dismiss = () => {
      // 纯前端关闭：只记录「跳过引导」，绝不标记安装完成、不改任何后端 setup 状态。
      dismissOnboardingContinuation();
      setDismissed(true);
    };
    return (
      <section aria-labelledby="scenario-heading">
        <Card
          size="small"
          extra={
            <Button type="text" aria-label="关闭引导" icon={<CloseOutlined />} onClick={dismiss} />
          }
        >
          <Flex wrap="wrap" justify="space-between" align="center" gap={16}>
            <div style={{ minWidth: 0 }}>
              <Title level={4} id="scenario-heading" style={{ marginBottom: 4 }}>
                选择一个常用用途
              </Title>
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                告诉管家你想先做什么，它会保留相应入口和下一步。
              </Paragraph>
            </div>
            <Flex gap={8} wrap="wrap">
              {/* 次按钮：首屏唯一的主动作留给结论条的「立即检查」（规范 §1 P2 一个动作）。 */}
              <Button href="/setup">开始设置</Button>
              <Button type="link" onClick={dismiss}>暂不设置</Button>
            </Flex>
          </Flex>
        </Card>
      </section>
    );
  }

  return null;
}
