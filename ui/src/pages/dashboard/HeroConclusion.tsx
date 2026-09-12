/**
 * 英雄结论区：一句话结论 + 主行动（立即检查）+ 元信息。
 * 行为完全兼容 v1；内部转由通用 `<ConclusionBar>` 承担，确保所有页面走同一份 tone 映射。
 */
import { Button, Divider, Flex, Typography } from "antd";
import { formatRelative } from "../../lib/format.js";
import { ConclusionBar } from "../../components/ConclusionBar.js";
import type { ConclusionTone } from "../../components/ConclusionBar.js";
import type { HeroView, InspectStatusView } from "./types.js";

const { Text } = Typography;

interface HeroConclusionProps {
  hero: HeroView;
  inspectStatus: InspectStatusView | null;
  /** 「立即检查」请求在途（busy 标志，替代原 1.5s 定时复位）。 */
  inspectRequested: boolean;
  onInspect: () => void;
}

/**
 * HeroView.tone 仍保留 `idle`（历史上"闲置/未启动" = 待激活）。
 * 结论条已统一为 6 档（规范 §3.2）：ok / warn / error / info / offline / unknown。
 * 这里把 `idle` 收敛为 `unknown`，因为它语义上就是"状态尚未确定"。
 */
function heroToneToConclusionTone(t: HeroView["tone"]): ConclusionTone {
  return t === "idle" ? "unknown" : t;
}

export function HeroConclusion({
  hero,
  inspectStatus,
  inspectRequested,
  onInspect,
}: HeroConclusionProps) {
  const inspectInFlight =
    inspectRequested || inspectStatus?.inFlight === true;
  return (
    <ConclusionBar
      tone={heroToneToConclusionTone(hero.tone)}
      title={hero.title}
      copy={hero.copy}
      action={
        <Button type="primary" loading={inspectInFlight} onClick={onInspect}>
          立即检查
        </Button>
      }
      extra={
        <Flex wrap="wrap" align="center" gap={8}>
          {/* 「管家服务在线/离线」只在状态条里说一次，结论条不再复述（评审 P0-3）。 */}
          <Text type="secondary">上次检查：{formatRelative(inspectStatus?.lastAt)}</Text>
          <Divider orientation="vertical" />
          <Text type="secondary">自动检查：{inspectStatus?.intervalMin ?? "—"} 分钟一次</Text>
        </Flex>
      }
    />
  );
}
