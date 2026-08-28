/**
 * 待办清单：按重要程度排序的问题卡片；超过 5 条可展开收起。
 */
import { useState } from "react";
import { Button } from "antd";
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
          <h2>{attentionCount > 0 ? `有 ${attentionCount} 件事需要处理` : "当前没有待处理事项"}</h2>
        </div>
        <span className="manager-section-note">无待处理事项；详细信息见下方</span>
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
                <Button size="small" onClick={() => onRepair(issue.runbook!)}>
                  一键修复
                </Button>
              )}
              <Button type="text" size="small" onClick={onOpenAdvanced}>
                查看详情
              </Button>
            </div>
          </article>
        ))}
      </div>
      {issues.length > 5 && (
        <div className="issues-toggle-wrap">
          <Button
            type="text"
            size="small"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "收起" : `展开全部 ${issues.length} 条`}
          </Button>
        </div>
      )}
    </div>
  );
}
