/**
 * 英雄结论区：一句话结论 + 主行动（立即检查 / 诊断并处理）+ 元信息。
 */
import { formatRelative } from "../../lib/format.js";
import type { HeroView, InspectStatusView } from "./types.js";

interface HeroConclusionProps {
  hero: HeroView;
  inspectStatus: InspectStatusView | null;
  /** 「立即检查」请求在途（busy 标志，替代原 1.5s 定时复位）。 */
  inspectRequested: boolean;
  recoveryBusy: boolean;
  /** 是否存在需要处理/留意的事，决定「诊断并处理」是否可用。 */
  canDiagnose: boolean;
  onInspect: () => void;
  onDiagnose: () => void;
}

export function HeroConclusion({
  hero,
  inspectStatus,
  inspectRequested,
  recoveryBusy,
  canDiagnose,
  onInspect,
  onDiagnose,
}: HeroConclusionProps) {
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
        <button
          type="button"
          className="btn btn-primary manager-action"
          onClick={onInspect}
          disabled={inspectRequested || inspectStatus?.inFlight === true}
        >
          {inspectStatus?.inFlight === true ? "正在检查…" : "立即检查"}
        </button>
        <button
          type="button"
          className="btn manager-action"
          onClick={onDiagnose}
          disabled={recoveryBusy || !canDiagnose}
        >
          {recoveryBusy ? "正在诊断…" : "诊断并处理"}
        </button>
      </div>
      <div className="manager-hero-meta">
        <span>上次检查：{formatRelative(inspectStatus?.lastAt)}</span>
        <span>自动检查：{inspectStatus?.intervalMin ?? "—"} 分钟一次</span>
        <span>管家服务：{inspectStatus?.reachable ? "在线" : "未连接"}</span>
      </div>
    </div>
  );
}
