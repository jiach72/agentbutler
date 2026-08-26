/**
 * 待办清单：按重要程度排序的问题卡片；超过 5 条可展开收起。
 */
import { useState } from "react";
import type { IssueView, RunbookView } from "./types.js";

interface IssuesSectionProps {
  issues: IssueView[];
  attentionCount: number;
  onRepair: (runbook: RunbookView) => void;
  onOpenAdvanced: () => void;
}

export function IssuesSection({ issues, attentionCount, onRepair, onOpenAdvanced }: IssuesSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const visibleIssues = expanded ? issues : issues.slice(0, 5);

  return (
    <div className="manager-section">
      <div className="manager-section-head">
        <div>
          <span className="product-kicker">当前状态</span>
          <h2>{attentionCount > 0 ? `有 ${attentionCount} 件事需要处理` : "管家正在替你看着"}</h2>
        </div>
        <span className="manager-section-note">没事就不用管；专业细节收在下面</span>
      </div>
      <div className="issue-list">
        {visibleIssues.map((issue) => (
          <article className={`issue-card is-${issue.tone}`} key={issue.id}>
            <div className="issue-main">
              <strong>{issue.title}</strong>
              <p>{issue.detail}</p>
            </div>
            <div className="issue-actions">
              {issue.runbook !== undefined && issue.tone !== "ok" && (
                <button type="button" className="btn" onClick={() => onRepair(issue.runbook!)}>
                  一键修复
                </button>
              )}
              <button type="button" className="btn btn-quiet" onClick={onOpenAdvanced}>
                查看详情
              </button>
            </div>
          </article>
        ))}
      </div>
      {issues.length > 5 && (
        <div className="issues-toggle-wrap">
          <button
            type="button"
            className="btn btn-quiet issues-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "收起" : `展开全部 ${issues.length} 条`}
          </button>
        </div>
      )}
    </div>
  );
}
