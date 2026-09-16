import type { ReactNode } from "react";
import { Card, Descriptions, Flex, Typography } from "antd";
import { AdvancedEvidence } from "./AdvancedEvidence.js";

interface IssueCardProps {
  title: string;
  impact: ReactNode;
  suggestion: ReactNode;
  risk: ReactNode;
  verification: ReactNode;
  action?: ReactNode;
  evidence?: ReactNode;
  tone?: "warn" | "error" | "info";
  className?: string;
}

export function IssueCard({
  title,
  impact,
  suggestion,
  risk,
  verification,
  action,
  evidence,
  tone = "warn",
  className,
}: IssueCardProps) {
  return (
    <Card
      size="small"
      className={`ab-guard-card is-${tone}${className ? ` ${className}` : ""}`}
      style={{ minWidth: 0, overflowWrap: "anywhere" }}
    >
      <Flex vertical gap={12}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        <Descriptions
          column={1}
          size="small"
          items={[
            { key: "impact", label: "影响什么", children: impact },
            { key: "suggestion", label: "建议动作", children: suggestion },
            { key: "risk", label: "操作风险", children: risk },
            { key: "verification", label: "如何验证", children: verification },
          ]}
        />
        {action}
        {evidence !== undefined && <AdvancedEvidence>{evidence}</AdvancedEvidence>}
      </Flex>
    </Card>
  );
}
