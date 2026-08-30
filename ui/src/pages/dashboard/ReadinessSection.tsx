import { CheckCircleOutlined, ExclamationCircleOutlined, ReloadOutlined, SyncOutlined } from "@ant-design/icons";
import { Button } from "antd";
import { useMemo } from "react";
import type { ConnectionsPayload, DiscoveredLlmConfigView, LlmStatusView } from "./types.js";
import { buildLocalReadiness, type ReadinessTone } from "./readiness.js";

interface ReadinessSectionProps {
  connections: ConnectionsPayload | null;
  llmStatus: LlmStatusView | null;
  discoveredModels: DiscoveredLlmConfigView[] | null;
  refreshing: boolean;
  onRefresh: () => void;
}

function ReadinessIcon({ tone }: { tone: ReadinessTone }) {
  if (tone === "ok") return <CheckCircleOutlined aria-hidden="true" />;
  if (tone === "idle") return <SyncOutlined spin aria-hidden="true" />;
  return <ExclamationCircleOutlined aria-hidden="true" />;
}

export function ReadinessSection({
  connections,
  llmStatus,
  discoveredModels,
  refreshing,
  onRefresh,
}: ReadinessSectionProps) {
  const readiness = useMemo(
    () => buildLocalReadiness(connections, llmStatus, discoveredModels),
    [connections, discoveredModels, llmStatus],
  );

  return (
    <section className={`readiness-section ${readiness.ready ? "is-ok" : ""}`} aria-labelledby="readiness-heading">
      <div className="manager-section-head readiness-section-head">
        <div>
          <span className="product-eyebrow">持续就绪</span>
          <h2 id="readiness-heading">本机运行就绪度</h2>
          <p className="readiness-summary" aria-live="polite"><strong>{readiness.summary}</strong>{readiness.detail}</p>
        </div>
        <div className="readiness-actions">
          {readiness.nextAction !== undefined && (
            <Button type="primary" href={readiness.nextAction.to}>
              {readiness.nextAction.label}
            </Button>
          )}
          <Button icon={<ReloadOutlined />} loading={refreshing} onClick={onRefresh}>
            复查状态
          </Button>
        </div>
      </div>
      <div className="readiness-grid">
        {readiness.items.map((item) => (
          <article key={item.id} className={`readiness-card is-${item.tone}`}>
            <div className="readiness-card-head">
              <span className="readiness-card-icon"><ReadinessIcon tone={item.tone} /></span>
              <div>
                <h3>{item.title}</h3>
                <strong>{item.status}</strong>
              </div>
            </div>
            <p>{item.detail}</p>
            {item.action !== undefined && (
              <Button type="link" href={item.action.to} className="readiness-card-action">
                {item.action.label}
              </Button>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
