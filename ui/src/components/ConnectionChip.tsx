/**
 * 服务连接指示：三态（在线 / 离线 / 连接中）统一呈现，
 * 收编此前 page-live / skills-live / evolution-connection 四种写法。
 */
type Reachable = boolean | null | undefined;

const PRESET: Record<"online" | "offline" | "connecting", { text: string }> = {
  online: { text: "管家服务已连接" },
  offline: { text: "管家服务离线" },
  connecting: { text: "正在连接管家…" },
};


interface ConnectionChipProps {
  /** true 在线 / false 离线 / null·undefined 视为连接中。 */
  reachable: Reachable;
  onlineText?: string;
  offlineText?: string;
  connectingText?: string;
  className?: string;
  variant?: "pill" | "subtle";
}

export function ConnectionChip({
  reachable,
  onlineText,
  offlineText,
  connectingText,
  className,
  variant = "pill",
}: ConnectionChipProps) {
  const key = reachable === true ? "online" : reachable === false ? "offline" : "connecting";
  const preset = PRESET[key];
  const label =
    (key === "online" ? onlineText : key === "offline" ? offlineText : connectingText) ?? preset.text;

  return (
    <span
      className={`ab-connection-chip is-${key}${variant === "subtle" ? " is-subtle" : ""}${className ? ` ${className}` : ""}`}
      role="status"
      aria-label={label}
    >
      <span className={`ab-beacon-dot is-${key}`} aria-hidden="true" />
      <span className="ab-beacon-text">{label}</span>
    </span>
  );
}

