/**
 * 第 1 步：让用户用自己的话描述现象。
 *
 * 这一步的意义是把用户从"我不知道该点哪个按钮"里解出来。
 * 选项不带任何技术分类，用户凭直觉选即可；选什么都不会漏掉后面的证据。
 * 展示层为统一卡规格网格：图标 + 现象名 + 一句话描述，点击后短暂高亮选中态。
 */
import { useState } from "react";
import { LoadingOutlined, MessageOutlined, ClockCircleOutlined, AlertOutlined, SyncOutlined, SearchOutlined } from "@ant-design/icons";
import { Button, Flex, Space, Steps, Typography } from "antd";
import { SectionHeader } from "../../../components/SectionHeader.js";
import { SYMPTOMS, type SymptomId } from "../symptoms.js";
import type { ComponentType } from "react";

const { Text, Paragraph } = Typography;

/** 现象卡图标与色调（色调随类别）。 */
const SYMPTOM_META: Record<SymptomId, { icon: ComponentType; tone: string }> = {
  "no-reply": { icon: MessageOutlined, tone: "tone-error" },
  slow: { icon: ClockCircleOutlined, tone: "tone-warn" },
  error: { icon: AlertOutlined, tone: "tone-cinnabar" },
  "after-update": { icon: SyncOutlined, tone: "tone-info" },
  "not-sure": { icon: SearchOutlined, tone: "tone-muted" },
};

interface SymptomStepProps {
  busy: boolean;
  onChoose: (id: SymptomId) => void;
}

export function SymptomStep({ busy, onChoose }: SymptomStepProps) {
  const [pending, setPending] = useState<SymptomId | null>(null);

  const choose = (id: SymptomId) => {
    if (busy) return;
    setPending(id);
    onChoose(id);
  };

  return (
    <Flex vertical gap={16}>
      <SectionHeader
        kicker="选择你遇到的现象"
        title="哪里不对劲？"
        extra={<Text type="secondary" style={{ fontSize: 12 }}>{busy ? "正在检查…" : `共 ${SYMPTOMS.length} 种常见情况`}</Text>}
      />
      <Paragraph type="secondary" style={{ marginBottom: 0 }}>
        选一个最接近的描述，管家会照着这个方向重点排查。选错了也没关系，所有检查结果都会完整显示。
      </Paragraph>
      <div className="ts-symptom-grid" role="group" aria-label="现象选择">
        {SYMPTOMS.map((symptom) => {
          const meta = SYMPTOM_META[symptom.id];
          const TileIcon = meta.icon;
          return (
            <div
              key={symptom.id}
              className={`ts-symptom-card${pending === symptom.id ? " is-selected" : ""}`}
              role="button"
              tabIndex={busy ? -1 : 0}
              aria-label={symptom.label}
              aria-disabled={busy || undefined}
              onClick={() => choose(symptom.id)}
              onKeyDown={(event) => {
                if (busy) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  choose(symptom.id);
                }
              }}
              style={{ cursor: busy ? "default" : "pointer" }}
            >
              <span className={`ts-tile ${meta.tone}`} aria-hidden="true">
                <TileIcon />
              </span>
              <Text strong>{symptom.label}</Text>
              <Text type="secondary" className="ts-symptom-hint" style={{ fontSize: 13 }}>{symptom.hint}</Text>
            </div>
          );
        })}
      </div>
      {busy && (
        <Space>
          <LoadingOutlined />
          <Text type="secondary" role="status">正在检查，请稍等…</Text>
        </Space>
      )}
    </Flex>
  );
}

/** 步骤条：告诉用户现在到哪一步了，还剩几步。 */
export function WizardSteps({ current }: { current: number }) {
  const labels = ["描述问题", "查看证据", "选择处理", "确认结果"];
  return (
    <Steps size="small" current={current} items={labels.map((label) => ({ title: label }))} />
  );
}

/** 步骤之间的导航按钮。 */
export function WizardNav({
  onBack,
  onNext,
  nextLabel = "下一步",
  nextDisabled = false,
  busy = false,
}: {
  onBack?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  busy?: boolean;
}) {
  return (
    <Space wrap className="ts-nav">
      {onBack !== undefined && (
        <Button onClick={onBack} disabled={busy}>
          上一步
        </Button>
      )}
      {onNext !== undefined && (
        <Button type="primary" onClick={onNext} disabled={nextDisabled} loading={busy}>
          {nextLabel}
        </Button>
      )}
    </Space>
  );
}
