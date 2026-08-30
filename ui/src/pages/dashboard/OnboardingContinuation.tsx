import { EditOutlined, RightOutlined } from "@ant-design/icons";
import { Button } from "antd";
import { useMemo } from "react";
import { readSetupPreferences, type SetupPreferences } from "../setup/state.js";
import { getScenarioTemplate } from "../setup/templates.js";

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
      <section className="scenario-continuation" aria-labelledby="scenario-heading">
        <div>
          <span className="product-eyebrow">常用场景</span>
          <h2 id="scenario-heading">选择一个常用用途</h2>
          <p>告诉管家你想先做什么，它会保留相应入口和下一步。</p>
        </div>
        <Button type="primary" href="/setup">开始设置</Button>
      </section>
    );
  }

  const canContinueElsewhere = scenario.destination !== "/dashboard";
  return (
    <section className="scenario-continuation" aria-labelledby="scenario-heading">
      <div>
        <span className="product-eyebrow">你的常用场景</span>
        <h2 id="scenario-heading">{scenario.label}</h2>
        <p>{scenario.description}</p>
      </div>
      <div className="scenario-continuation-actions">
        {canContinueElsewhere && (
          <Button type="primary" href={scenario.destination} icon={<RightOutlined />} iconPlacement="end">
            {scenario.nextLabel}
          </Button>
        )}
        <Button href="/setup" icon={<EditOutlined />}>重新设置</Button>
      </div>
    </section>
  );
}
