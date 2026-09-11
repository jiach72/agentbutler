/**
 * 设置页数据源状态概览条：七个轮询数据源的小圆点 + 名称 + 降级状态，
 * 直接映射 SettingsPage 的 FetchState（loading 灰 / ready 绿 / failed 黄）。
 * 只读展示，不引入任何新请求；单源重试仍在各分类面板内。
 */
import { Card, Typography } from "antd";
import {
  SOURCE_KEYS,
  SOURCE_LABELS,
  type SettingsSourceKey,
  type SourcesState,
} from "./helpers.js";
import "./settings.css";

const { Text } = Typography;

interface SourceStatusView {
  /** 圆点色调（对应 settings.css 的 dot 类）。 */
  tone: "loading" | "ready" | "failed";
  /** 状态文案：读取中 / 正常 / 降级。 */
  text: string;
  /** 悬停提示（降级时给出原因）。 */
  title?: string;
}

function sourceStatus(state: SourcesState[SettingsSourceKey]): SourceStatusView {
  if (state.status === "loading") return { tone: "loading", text: "读取中" };
  if (state.status === "ready") return { tone: "ready", text: "正常" };
  return { tone: "failed", text: "降级", title: state.reason };
}

export function SourceStatusBar({ sources }: { sources: SourcesState }) {
  return (
    <Card size="small" aria-label="数据源状态概览">
      <div className="settings-source-list">
        {SOURCE_KEYS.map((key) => {
          const status = sourceStatus(sources[key]);
          return (
            <span key={key} className="settings-source-item" title={status.title}>
              <span className={`settings-source-dot ${status.tone}`} aria-hidden="true" />
              <Text>{SOURCE_LABELS[key]}</Text>
              <Text
                type={status.tone === "failed" ? "warning" : "secondary"}
                style={{ fontSize: 12 }}
              >
                {status.text}
              </Text>
            </span>
          );
        })}
      </div>
    </Card>
  );
}
