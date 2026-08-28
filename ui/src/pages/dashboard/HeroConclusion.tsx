/**
 * 英雄结论区：一句话结论 + 主行动（立即检查）+ 元信息。
 */
import { Button } from "antd";
import { formatRelative } from "../../lib/format.js";
import type { HeroView, InspectStatusView } from "./types.js";

interface HeroConclusionProps {
  hero: HeroView;
  inspectStatus: InspectStatusView | null;
  /** 「立即检查」请求在途（busy 标志，替代原 1.5s 定时复位）。 */
  inspectRequested: boolean;
  onInspect: () => void;
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
    <div className={`manager-hero is-${hero.tone}`}>
      <span className="manager-hero-band" aria-hidden="true" />
      <div className="manager-hero-icon" aria-hidden="true">
        {hero.tone === "ok" ? "✓" : hero.tone === "error" || hero.tone === "warn" ? "!" : "…"}
      </div>
      <div className="manager-hero-copy">
        <span className="manager-hero-kicker">当前状态</span>
        <h2>{hero.title}</h2>
        <p>{hero.copy}</p>
      </div>
      <div className="manager-hero-actions">
        <Button
          type="primary"
          className="manager-action"
          loading={inspectInFlight}
          onClick={onInspect}
        >
          立即检查
        </Button>
      </div>
      <div className="manager-hero-meta">
        <span>上次检查：{formatRelative(inspectStatus?.lastAt)}</span>
        <span>自动检查：{inspectStatus?.intervalMin ?? "—"} 分钟一次</span>
        <span>管家服务：{inspectStatus?.reachable ? "在线" : "未连接"}</span>
      </div>
    </div>
  );
}
