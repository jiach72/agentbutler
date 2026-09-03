/**
 * 待办清单：按重要程度排序的问题卡片；超过 5 条可展开收起。
 * 重复问题条目额外提供「复制求助提示词 / 转发给智能体」，让用户不必自己排查。
 */
import { useState } from "react";
import { App } from "antd";
import { ArrowRightOutlined, CopyOutlined, RobotOutlined } from "@ant-design/icons";
import { Badge, Button, Card, Flex, Typography } from "antd";
import { useNavigate } from "react-router-dom";
import { postJson } from "../../lib/api.js";
import { buildAgentHelpPrompt } from "./helpers.js";
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
  const [forwardingId, setForwardingId] = useState<string | null>(null);
  const navigate = useNavigate();
  const { message, modal } = App.useApp();
  const visibleIssues = expanded ? issues : issues.slice(0, 5);

  const copyHelpPrompt = async (issue: IssueView): Promise<void> => {
    if (issue.fingerprint === undefined) return;
    const prompt = buildAgentHelpPrompt(issue.fingerprint);
    try {
      await navigator.clipboard.writeText(prompt);
      message.success("求助提示词已复制，粘贴给智能体即可");
    } catch {
      modal.info({ title: "求助提示词（复制失败，请手动选择）", content: <pre style={{ whiteSpace: "pre-wrap" }}>{prompt}</pre> });
    }
  };

  const forwardToAgent = async (issue: IssueView): Promise<void> => {
    if (issue.fingerprint === undefined) return;
    const prompt = buildAgentHelpPrompt(issue.fingerprint);
    setForwardingId(issue.id);
    try {
      const result = await postJson(
        "/api/agent-message",
        { text: prompt },
        200_000,
      );
      if (result.ok && result.data !== null && typeof result.data === "object") {
        const reply = String((result.data as Record<string, unknown>)["reply"] ?? "").trim();
        modal.info({
          title: "已转发给智能体，它的分析如下",
          content: <pre style={{ whiteSpace: "pre-wrap", maxHeight: 360, overflow: "auto" }}>{reply || "（智能体没有返回文本）"}</pre>,
          width: 560,
        });
      } else {
        message.error("转发失败：智能体接口暂时不可用，可改用「复制求助提示词」");
      }
    } finally {
      setForwardingId(null);
    }
  };


  return (
    <section>
      <Flex vertical gap={16}>
        <Flex wrap="wrap" justify="space-between" align="flex-start" gap={16}>
          <div style={{ minWidth: 0 }}>
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
                    {issue.fingerprint !== undefined && (
                      <Flex wrap gap={8}>
                        <Button
                          size="small"
                          icon={<CopyOutlined />}
                          onClick={() => void copyHelpPrompt(issue)}
                        >
                          复制求助提示词
                        </Button>
                        {(issue.fingerprint.instance ?? "").startsWith("hermes") && (
                          <Button
                            size="small"
                            type="primary"
                            ghost
                            icon={<RobotOutlined />}
                            loading={forwardingId === issue.id}
                            onClick={() => void forwardToAgent(issue)}
                          >
                            转发给智能体
                          </Button>
                        )}
                      </Flex>
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
