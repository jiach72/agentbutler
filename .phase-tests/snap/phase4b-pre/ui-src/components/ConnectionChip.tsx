/**
 * 服务连接指示：三态（在线 / 离线 / 连接中）统一呈现，
 * 收编此前 page-live / skills-live / evolution-connection 四种写法。
 */
import { Badge } from "antd";
import type { BadgeProps } from "antd";

type Reachable = boolean | null | undefined;

const PRESET: Record<
  "online" | "offline" | "connecting",
  { status: BadgeProps["status"]; text: string }
> = {
  online: { status: "success", text: "管家服务已连接" },
  offline: { status: "error", text: "管家服务离线" },
  connecting: { status: "processing", text: "正在连接管家…" },
};

interface ConnectionChipProps {
  /** true 在线 / false 离线 / null·undefined 视为连接中。 */
  reachable: Reachable;
  onlineText?: string;
  offlineText?: string;
  connectingText?: string;
}

export function ConnectionChip({
  reachable,
  onlineText,
  offlineText,
  connectingText,
}: ConnectionChipProps) {
  const key = reachable === true ? "online" : reachable === false ? "offline" : "connecting";
  const preset = PRESET[key];
  const override =
    key === "online" ? onlineText : key === "offline" ? offlineText : connectingText;
  return <Badge status={preset.status} text={override ?? preset.text} />;
}
