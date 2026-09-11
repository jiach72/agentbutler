/**
 * 英雄结论区：一句话结论 + 主行动（立即检查）+ 元信息。
 */
import { Alert, Button, Divider, Flex, Typography } from "antd";
import { formatRelative } from "../../lib/format.js";
import type { HeroView, InspectStatusView } from "./types.js";

const { Text } = Typography;

interface HeroConclusionProps {
  hero: HeroView;
  inspectStatus: InspectStatusView | null;
  /** 「立即检查」请求在途（busy 标志，替代原 1.5s 定时复位）。 */
  inspectRequested: boolean;
  onInspect: () => void;
}

const heroAlertType = {
  ok: "success",
  warn: "warning",
  error: "error",
  idle: "info",
} as const;

export function HeroConclusion({
  hero,
  inspectStatus,
  inspectRequested,
  onInspect,
}: HeroConclusionProps) {
  const inspectInFlight =
    inspectRequested || inspectStatus?.inFlight === true;
  return (
    <Flex vertical gap={12}>
      <Alert
        type={heroAlertType[hero.tone]}
        showIcon
        title={hero.title}
        description={hero.copy}
        action={
          <Button type="primary" loading={inspectInFlight} onClick={onInspect}>
            立即检查
          </Button>
        }
      />
      <Flex wrap="wrap" align="center" gap={8}>
        <Text type="secondary">上次检查：{formatRelative(inspectStatus?.lastAt)}</Text>
        <Divider type="vertical" />
        <Text type="secondary">自动检查：{inspectStatus?.intervalMin ?? "—"} 分钟一次</Text>
        <Divider type="vertical" />
        <Text type="secondary">管家服务：{inspectStatus?.reachable ? "在线" : "未连接"}</Text>
      </Flex>
    </Flex>
  );
}
