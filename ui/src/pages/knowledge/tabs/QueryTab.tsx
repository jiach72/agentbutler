/**
 * 知识问答检索 Tab（F-3 拆分自 KnowledgePage，JSX 原样搬移）。
 * 问答状态与检索逻辑仍在 KnowledgePage。
 */
import { useNavigate } from "react-router-dom";
import { Button, Card, Col, Flex, Input, Row, Space, Tag, Tooltip } from "antd";
import { Typography } from "antd";
import type { MessageInstance } from "antd/es/message/interface";
import {
  CheckOutlined,
  CommentOutlined,
  CompassOutlined,
  CopyOutlined,
  EyeOutlined,
  MessageOutlined,
} from "@ant-design/icons";
import type { KnowledgeDocument } from "../KnowledgePage.js";

const { Text } = Typography;

export interface KnowledgeCitation {
  docName: string;
  path: string;
  snippet: string;
  score: number;
}

export interface QueryTabProps {
  queryInput: string;
  setQueryInput: (value: string) => void;
  handleRunQuery: (preset?: string) => void | Promise<void>;
  querying: boolean;
  queryResult: { query: string; answer: string; citations: KnowledgeCitation[] } | null;
  documents: KnowledgeDocument[];
  handleOpenPreview: (doc: KnowledgeDocument) => void;
  copiedSnippetIdx: number | null;
  setCopiedSnippetIdx: (value: number | null) => void;
  message: MessageInstance;
  qaCopied: boolean;
  setQaCopied: (value: boolean) => void;
}

export function QueryTab({
  queryInput,
  setQueryInput,
  handleRunQuery,
  querying,
  queryResult,
  documents,
  handleOpenPreview,
  copiedSnippetIdx,
  setCopiedSnippetIdx,
  message,
  qaCopied,
  setQaCopied,
}: QueryTabProps) {
  const navigate = useNavigate();
  return (
    <Card
      title={
        <Flex justify="space-between" align="center">
          <Flex align="center" gap={8}>
            <CompassOutlined style={{ color: "var(--ant-color-primary)" }} />
            <span>基于已收集资料的私有问答与语义检索 (Local RAG)</span>
          </Flex>
          <Tag color="cyan">本地 Ollama 驱动</Tag>
        </Flex>
      }
      style={{ borderRadius: 12 }}
    >
      <Flex vertical gap={16}>
        <Text type="secondary">
          向 Agent Butler 的本地私有知识库提问，智能体将实时在收集箱、Obsidian 笔记及微信归纳文件中检索相关切片，并结合本地模型回答。
        </Text>

        {/* 提问搜索框 */}
        <Flex gap={8}>
          <Input.Search
            size="large"
            placeholder="向知识库提问，例如：这份文档的核心结论是什么？有哪些待办事项？（按 Enter 检索）"
            enterButton="检索问答"
            allowClear
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            onSearch={() => handleRunQuery()}
            loading={querying}
          />
        </Flex>

        {/* 快捷提问推荐气泡 */}
        <Flex align="center" gap={8} wrap="wrap">
          <Text type="secondary" style={{ fontSize: 12 }}>
            快捷提问：
          </Text>
          <Button
            size="small"
            type="dashed"
            onClick={() => {
              const q = "请梳理知识库中相关文档的核心要点与关键结论";
              setQueryInput(q);
              void handleRunQuery(q);
            }}
          >
            💡 核心要点与结论？
          </Button>
          <Button
            size="small"
            type="dashed"
            onClick={() => {
              const q = "知识库中记录了哪些具体的行动项、任务或待办事项？";
              setQueryInput(q);
              void handleRunQuery(q);
            }}
          >
            📋 待办与行动项？
          </Button>
          <Button
            size="small"
            type="dashed"
            onClick={() => {
              const q = "请结合已有资料，总结背景信息、关键时间节点与注意事项";
              setQueryInput(q);
              void handleRunQuery(q);
            }}
          >
            🔍 背景与关键节点？
          </Button>
          <Button
            size="small"
            type="dashed"
            onClick={() => {
              const q = "请全面审查知识库中相关资料的潜在风险点、合规隐患与安全防线";
              setQueryInput(q);
              void handleRunQuery(q);
            }}
          >
            🛡️ 潜在风险与合规？
          </Button>
          <Button
            size="small"
            type="dashed"
            onClick={() => {
              const q = "请将知识库中相关文档的核心精要凝练成 200 字以内的高管工作简报";
              setQueryInput(q);
              void handleRunQuery(q);
            }}
          >
            📝 200 字工作简报？
          </Button>
        </Flex>

        {/* 问答检索结果 */}
        {queryResult && (
          <Card
            size="small"
            style={{
              background: "var(--ant-color-fill-quaternary)",
              borderRadius: 10,
              border: "1px solid var(--ant-color-border-secondary)",
            }}
          >
            <Flex vertical gap={12}>
              <Flex align="center" gap={8}>
                <MessageOutlined style={{ color: "var(--ant-color-primary)" }} />
                <Text strong style={{ fontSize: 14 }}>
                  问答回复：
                </Text>
              </Flex>

              <div
                style={{
                  whiteSpace: "pre-wrap",
                  lineHeight: "1.7",
                  fontSize: 14,
                  padding: "10px 14px",
                  background: "var(--ant-color-fill-quaternary)",
                  borderRadius: 8,
                }}
              >
                {queryResult.answer}
              </div>

              {queryResult.citations && queryResult.citations.length > 0 && (
                <Flex vertical gap={8} style={{ marginTop: 8 }}>
                  <Text strong style={{ fontSize: 13, color: "var(--ant-color-text-secondary)" }}>
                    参考来源与出处片段（Citations）：
                  </Text>
                  <Row gutter={[12, 12]}>
                    {queryResult.citations.map((c, i) => (
                      <Col xs={24} md={12} key={i}>
                        <Card
                          size="small"
                          style={{
                            borderRadius: 8,
                            background: "var(--ant-color-bg-container)",
                            border: "1px solid var(--ant-color-border)",
                          }}
                        >
                          <Flex vertical gap={4}>
                            <Flex justify="space-between" align="center">
                              <Text strong ellipsis style={{ maxWidth: 170 }}>
                                {c.docName}
                              </Text>
                              <Space size={2}>
                                <Tag color="blue" style={{ margin: 0, fontSize: 11 }}>匹配度 {c.score}</Tag>
                                {(() => {
                                  const matchedDoc = documents.find(
                                    (d) => d.name === c.docName || d.path.endsWith(c.docName),
                                  );
                                  return matchedDoc ? (
                                    <Tooltip title="在线预览该文档原文">
                                      <Button
                                        size="small"
                                        type="text"
                                        icon={<EyeOutlined style={{ fontSize: 11, color: "var(--ant-color-primary)" }} />}
                                        onClick={() => handleOpenPreview(matchedDoc)}
                                      />
                                    </Tooltip>
                                  ) : null;
                                })()}
                                <Tooltip title="一键复制出处切片内容">
                                  <Button
                                    size="small"
                                    type="text"
                                    icon={
                                      copiedSnippetIdx === i ? (
                                        <CheckOutlined style={{ fontSize: 11, color: "var(--ab-ok, #52c41a)" }} />
                                      ) : (
                                        <CopyOutlined style={{ fontSize: 11 }} />
                                      )
                                    }
                                    onClick={() => {
                                      void navigator.clipboard?.writeText(c.snippet);
                                      setCopiedSnippetIdx(i);
                                      setTimeout(() => setCopiedSnippetIdx(null), 2000);
                                      message.success(`已复制《${c.docName}》切片内容`);
                                    }}
                                  />
                                </Tooltip>
                                <Tooltip title="在即时通讯中就此出处追问细节">
                                  <Button
                                    size="small"
                                    type="text"
                                    icon={<CommentOutlined style={{ fontSize: 11, color: "var(--ant-color-primary)" }} />}
                                    onClick={() => {
                                      const prompt = `基于知识库文档《${c.docName}》的参考出处：\n> ${c.snippet}\n\n请针对问题「${queryResult.query}」展开深度解读与细节分析：`;
                                      navigate(`/gateway?tab=im&prefill=${encodeURIComponent(prompt)}`);
                                    }}
                                  />
                                </Tooltip>
                              </Space>
                            </Flex>
                            <Text
                              type="secondary"
                              style={{
                                fontSize: 12,
                                maxHeight: 70,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                display: "-webkit-box",
                                WebkitLineClamp: 3,
                                WebkitBoxOrient: "vertical",
                              }}
                            >
                              {c.snippet}
                            </Text>
                          </Flex>
                        </Card>
                      </Col>
                    ))}
                  </Row>
                </Flex>
              )}

              {/* 问答快捷操作条：直达即时通讯工作台深聊 + 复制全文 */}
              <Flex
                justify="space-between"
                align="center"
                wrap="wrap"
                gap={8}
                style={{
                  marginTop: 4,
                  paddingTop: 10,
                  borderTop: "1px dashed var(--ant-color-border-secondary)",
                }}
              >
                <Flex align="center" gap={8}>
                  <Button
                    type="primary"
                    icon={<CommentOutlined />}
                    onClick={() => {
                      const shortAnswer =
                        queryResult.answer.length > 180
                          ? `${queryResult.answer.slice(0, 180)}…`
                          : queryResult.answer;
                      const prefill = `基于本地知识库针对「${queryResult.query}」的检索结果：\n> ${shortAnswer.replace(/\n+/g, "\n> ")}\n\n请帮我进一步分析并给出执行建议：`;
                      navigate(`/gateway?tab=im&prefill=${encodeURIComponent(prefill)}`);
                    }}
                  >
                    在即时通讯工作台继续深聊
                  </Button>
                  <Button
                    icon={
                      qaCopied ? (
                        <CheckOutlined style={{ color: "var(--ab-ok, #52c41a)" }} />
                      ) : (
                        <CopyOutlined />
                      )
                    }
                    onClick={() => {
                      const qaText = `问题：${queryResult.query}\n\n回答：\n${queryResult.answer}\n\n（来自 Agent Butler 本地私有知识库）`;
                      void navigator.clipboard?.writeText(qaText);
                      setQaCopied(true);
                      setTimeout(() => setQaCopied(false), 2000);
                      message.success("已复制问答全文到剪贴板");
                    }}
                  >
                    {qaCopied ? "已复制问答全文 √" : "复制问答全文"}
                  </Button>
                </Flex>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  一键携带问答上下文直达 IM 智能体交互
                </Text>
              </Flex>
            </Flex>
          </Card>
        )}
      </Flex>
    </Card>
  );
}
