/**
 * 第 3 步：让用户选一个动作。
 *
 * 三条纪律：
 * 1）可用的排在前面，推荐的默认选中——用户不想选就直接用默认。
 * 2）不可用的动作不隐藏，折叠起来说明"为什么不能做"和"怎么才能做"，
 *    否则用户会以为是产品坏了。
 * 3）风险用后果说（会中断服务），不用等级说（high risk）。
 * 展示层与全站统一：动作卡 = 图标底 + 名称 + 风险标签 + 说明与影响。
 */
import type { ComponentType } from "react";
import {
  ApiOutlined,
  ClearOutlined,
  ControlOutlined,
  DatabaseOutlined,
  PoweroffOutlined,
  SyncOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import { Collapse, Flex, Radio, Typography } from "antd";
import { SectionHeader } from "../../../components/SectionHeader.js";
import { StatusBadge } from "../../../components/StatusBadge.js";
import type { RecoveryActionView } from "../../dashboard/types.js";
import type { SymptomId } from "../symptoms.js";
import { WizardNav } from "./SymptomStep.js";

const { Text, Paragraph } = Typography;

const RISK_LABEL: Record<RecoveryActionView["risk"], { text: string; tone: "ok" | "warn" | "error" }> = {
  low: { text: "不影响使用", tone: "ok" },
  medium: { text: "会有短暂影响", tone: "warn" },
  high: { text: "会中断服务", tone: "error" },
};

const RISK_TILE_TONE: Record<RecoveryActionView["risk"], string> = {
  low: "tone-ok",
  medium: "tone-warn",
  high: "tone-error",
};

/** 已知动作的图标底；未知动作回退为通用工具图标。 */
const ACTION_ICONS: Record<string, ComponentType> = {
  "reconnect-channel": ApiOutlined,
  "cleanup-gateway": ClearOutlined,
  "refresh-probe": SyncOutlined,
  "restart-instance": PoweroffOutlined,
  "apply-throttle-patch": ControlOutlined,
  "rebuild-memory-index": DatabaseOutlined,
};

function actionIconOf(actionId: string): ComponentType {
  return ACTION_ICONS[actionId] ?? ToolOutlined;
}

interface ActionStepProps {
  ranked: RecoveryActionView[];
  recommended: RecoveryActionView | null;
  selected: string | null;
  symptom: SymptomId;
  busy: boolean;
  onSelect: (id: string) => void;
  onBack: () => void;
  onRun: (action: RecoveryActionView) => void;
}

export function ActionStep({
  ranked,
  recommended,
  selected,
  busy,
  onSelect,
  onBack,
  onRun,
}: ActionStepProps) {
  const available = ranked.filter((action) => action.available);
  const unavailable = ranked.filter((action) => !action.available);
  const chosen = ranked.find((action) => action.id === selected) ?? null;

  return (
    <Flex vertical gap={16}>
      <SectionHeader
        kicker="选择处理"
        title="你想怎么处理？"
        extra={<Text type="secondary" style={{ fontSize: 12 }}>{`可用 ${available.length} 个 · 不可用 ${unavailable.length} 个`}</Text>}
      />
      <Paragraph type="secondary" style={{ marginBottom: 0 }}>
        已经按「先试影响最小的」排好序。没有把握就用推荐的那一个。
      </Paragraph>

      {available.length === 0 ? (
        <Flex className="ts-result is-info" gap={10}>
          <Flex vertical gap={2} style={{ minWidth: 0 }}>
            <Text strong>现在没有可以自动执行的动作</Text>
            <Text type="secondary" style={{ fontSize: 13 }}>
              检查项都通过了，或者当前环境不支持自动处理。可以先导出诊断报告，把它发给能帮你的人。
            </Text>
          </Flex>
        </Flex>
      ) : (
        <Radio.Group
          value={selected ?? undefined}
          onChange={(event) => onSelect(String(event.target.value))}
          className="ts-action-grid"
        >
          {available.map((action) => {
            const risk = RISK_LABEL[action.risk];
            const TileIcon = actionIconOf(action.id);
            return (
              <Radio key={action.id} value={action.id} className="ts-action-card">
                <Flex vertical gap={6} style={{ minWidth: 0 }}>
                  <Flex align="center" gap={10} wrap>
                    <span className={`ts-tile ${RISK_TILE_TONE[action.risk]}`} aria-hidden="true">
                      <TileIcon />
                    </span>
                    <Text strong>{action.label}</Text>
                    {recommended?.id === action.id && (
                      <StatusBadge tone="info" label="推荐" />
                    )}
                    <StatusBadge tone={risk.tone} label={risk.text} />
                  </Flex>
                  <Text type="secondary">{action.description}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>{action.impact} · 约 {action.estimatedSeconds} 秒</Text>
                </Flex>
              </Radio>
            );
          })}
        </Radio.Group>
      )}

      {unavailable.length > 0 && (
        <Collapse
          items={[
            {
              key: "unavailable",
              label: `还有 ${unavailable.length} 个动作现在用不了（点开看原因）`,
              children: (
                <Flex vertical gap={12}>
                  {unavailable.map((action) => {
                    const TileIcon = actionIconOf(action.id);
                    return (
                      <Flex key={action.id} vertical gap={4} className="ts-action-card is-static">
                        <Flex align="center" gap={10} wrap>
                          <span className="ts-tile tone-muted" aria-hidden="true">
                            <TileIcon />
                          </span>
                          <Text strong>{action.label}</Text>
                        </Flex>
                        <Text type="secondary">{action.unavailableReason ?? "当前环境不支持"}</Text>
                        {action.unavailableFix !== undefined && (
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            想用上的话：{action.unavailableFix}
                          </Text>
                        )}
                      </Flex>
                    );
                  })}
                </Flex>
              ),
            },
          ]}
        />
      )}

      <WizardNav
        onBack={onBack}
        onNext={chosen === null ? undefined : () => onRun(chosen)}
        nextLabel={chosen === null ? "先选一个动作" : `执行「${chosen.label}」`}
        nextDisabled={chosen === null}
        busy={busy}
      />
    </Flex>
  );
}
