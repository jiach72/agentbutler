/**
 * 设置页数据源诊断区：默认折叠的 <details>，点开才列出七路数据源的状态。
 * 取代旧版常驻首屏的状态概览条——首屏不再恒定占用一行「一切正常」绿点。
 * 措辞诚实：就绪只说「已更新（时间）」，绝不写「正常 / 业务正常」；
 * 失败才在对应位置给出「未更新」+ 可重试按钮。
 */
import { formatTime } from "../../lib/format.js";
import { SOURCE_KEYS, SOURCE_LABELS, type SettingsSourceKey, type SourcesState } from "./helpers.js";
import "./settings.css";

interface SourceStatusBarProps {
  /** 七路数据源当前状态。 */
  sources: SourcesState;
  /** 各源就绪时刻（ms）；用于标注「已更新」的具体时间。 */
  checkedAt?: Partial<Record<SettingsSourceKey, number>>;
  /** 单源重试回调；传入后失败项显示「重试」按钮。 */
  onRetry?: (key: SettingsSourceKey) => void;
}

function statusText(
  state: SourcesState[SettingsSourceKey],
  checkedAt: number | undefined,
): { tone: "loading" | "ready" | "failed"; text: string } {
  if (state.status === "loading") return { tone: "loading", text: "读取中" };
  if (state.status === "ready") {
    return { tone: "ready", text: checkedAt !== undefined ? `已更新 ${formatTime(checkedAt)}` : "已更新" };
  }
  return { tone: "failed", text: "未更新" };
}

export function SourceStatusBar({ sources, checkedAt = {}, onRetry }: SourceStatusBarProps) {
  return (
    <details className="settings-source-details" aria-label="数据源状态">
      <summary>数据源状态（点开查看；平时不占用首屏）</summary>
      <ul className="settings-source-list">
        {SOURCE_KEYS.map((key) => {
          const state = sources[key];
          const { tone, text } = statusText(state, checkedAt[key]);
          return (
            <li key={key} className="settings-source-item" title={state.status === "failed" ? state.reason : undefined}>
              <span className={`settings-source-dot ${tone}`} aria-hidden="true" />
              <span className="settings-source-name">{SOURCE_LABELS[key]}</span>
              <span
                className={`settings-source-state ${tone === "failed" ? "warn" : "secondary"}`}
              >
                {text}
              </span>
              {state.status === "failed" && onRetry ? (
                <button type="button" className="settings-source-retry" onClick={() => onRetry(key)}>
                  重试
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
