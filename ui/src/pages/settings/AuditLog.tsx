/**
 * 设置页操作记录面板：管家历史操作的只读时间线。
 * 审计数据独立三态，失败时显示降级横幅与重试。
 */
import { Button } from "antd";
import { DegradedBanner } from "../../components/DegradedBanner.js";
import { formatTime } from "../../lib/format.js";
import type { FetchState } from "../../lib/api.js";
import {
  actorLabel,
  auditActionLabel,
  type AuditPayload,
  DEGRADED_TEXT,
} from "./helpers.js";

interface AuditLogProps {
  audit: FetchState<AuditPayload>;
  onRetry: () => void;
}

export function AuditLog({ audit, onRetry }: AuditLogProps) {
  return (
    <div className="settings-subsection">
      <div className="settings-section-head is-compact">
        <div>
          <span className="product-kicker">操作记录</span>
          <h2>管家做过的操作</h2>
        </div>
      </div>
      <div className="audit-list">
        {audit.status === "ready" &&
          audit.data.items.slice(0, 10).map((item) => (
            <article className="audit-row" key={item.id} title={item.target}>
              <i />
              <div>
                <strong>
                  {actorLabel(item.actor)} · {auditActionLabel(item.action)}
                </strong>
                <span>{formatTime(item.ts)}</span>
              </div>
            </article>
          ))}
        {audit.status === "loading" && (
          <div className="empty-state">正在读取操作记录…</div>
        )}
        {audit.status === "failed" && (
          <DegradedBanner
            severity="warn"
            message={DEGRADED_TEXT}
            description={audit.reason}
            action={
              <Button onClick={onRetry}>
                重试
              </Button>
            }
          />
        )}
        {audit.status === "ready" && audit.data.items.length === 0 && (
          <div className="empty-state">还没有操作记录；管家每次操作都会记在这里。</div>
        )}
      </div>
    </div>
  );
}
