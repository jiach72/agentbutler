/**
 * 待办清单：按重要程度排序的问题卡片；超过 5 条可展开收起。
 */
import { useState } from "react";
import { ArrowRightOutlined } from "@ant-design/icons";
import { Button } from "antd";
import { useNavigate } from "react-router-dom";
import type { IssueView } from "./types.js";

interface IssuesSectionProps {
  issues: IssueView[];
  attentionCount: number;
  onInspect: () => void;
}

export function IssuesSection({ issues, attentionCount, onInspect }: IssuesSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();
  const visibleIssues = expanded ? issues : issues.slice(0, 5);

  return (
    <div className="manager-section">
      <div className="manager-section-head">
        <div>
          <span className="product-kicker">当前状态</span>
          <h2>{attentionCount > 0 ? `有 ${attentionCount} 件事需要处理` : "当前没有待处理事项"}</h2>
        </div>
        <span className="manager-section-note">详细信息请查看诊断与修复</span>
      </div>
      <div className="issue-list">
        {visibleIssues.map((issue) => {
          const action = issue.action;
          return (
            <article className={`issue-card is-${issue.tone}`} key={issue.id}>
              <div className="issue-main">
                <strong>{issue.title}</strong>
                <p>{issue.detail}</p>
                {action !== undefined && (
                  <Button
                    type="link"
                    size="small"
                    icon={<ArrowRightOutlined />}
                    onClick={() => action.to === undefined ? onInspect() : navigate(action.to)}
                  >
                    {action.label}
                  </Button>
                )}
              </div>
            </article>
          );
        })}
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
