/**
 * 待办清单：按重要程度排序的问题卡片；超过 5 条可展开收起。
 */
import { useState } from "react";
import { ArrowRightOutlined } from "@ant-design/icons";
import { Badge, Button, Card, Flex, Typography } from "antd";
import { useNavigate } from "react-router-dom";
import type { IssueView } from "./types.js";

const { Text, Title } = Typography;

interface IssuesSectionProps {
  issues: IssueView[];
  attentionCount: number;
  onInspect: () => void;
}

const toneBadgeStatus = {
  ok: "success",
  warn: "warning",
  error: "error",
  idle: "default",
} as const;

export function IssuesSection({ issues, attentionCount, onInspect }: IssuesSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();
  const visibleIssues = expanded ? issues : issues.slice(0, 5);

  return (
    <section>
      <Flex vertical gap={16}>
        <Flex wrap="wrap" justify="space-between" align="flex-start" gap={16}>
          <div style={{ minWidth: 0 }}>
            <Text
              type="secondary"
              style={{ display: "block", fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}
            >
              当前状态
            </Text>
            <Title level={4} style={{ marginBottom: 0 }}>
              {attentionCount > 0 ? `有 ${attentionCount} 件事需要处理` : "当前没有待处理事项"}
            </Title>
          </div>
          <Text type="secondary">详细信息请查看诊断与修复</Text>
        </Flex>
        <Flex vertical gap={8}>
          {visibleIssues.map((issue) => {
            const action = issue.action;
            return (
              <Card size="small" key={issue.id}>
                <Flex align="flex-start" gap={12}>
                  <Badge status={toneBadgeStatus[issue.tone]} style={{ marginTop: 5 }} />
                  <Flex vertical gap={4} style={{ minWidth: 0 }}>
                    <Text strong>{issue.title}</Text>
                    <Text type="secondary">{issue.detail}</Text>
                    {action !== undefined && (
                      <Button
                        type="link"
                        icon={<ArrowRightOutlined />}
                        style={{ paddingInline: 0, alignSelf: "flex-start" }}
                        onClick={() => action.to === undefined ? onInspect() : navigate(action.to)}
                      >
                        {action.label}
                      </Button>
                    )}
                  </Flex>
                </Flex>
              </Card>
            );
          })}
        </Flex>
        {issues.length > 5 && (
          <Button
            type="text"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "收起" : `展开全部 ${issues.length} 条`}
          </Button>
        )}
      </Flex>
    </section>
  );
}
