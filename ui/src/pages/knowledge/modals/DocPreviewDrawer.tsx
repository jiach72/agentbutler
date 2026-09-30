/**
 * 文档内容在线预览抽屉（F-3 拆分自 KnowledgePage，JSX 原样搬移）。
 * 预览数据加载与追问逻辑仍在 KnowledgePage。
 */
import { Alert, Button, Drawer, Dropdown, Empty, Flex, Input, Space, Tag, Tooltip } from "antd";
import { Typography } from "antd";
import type { MessageInstance } from "antd/es/message/interface";
import {
  BookOutlined,
  CommentOutlined,
  DownOutlined,
  FileTextOutlined,
  LoadingOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { CopySnippetButton } from "../../../components/CopySnippetButton.js";

const { Text } = Typography;

/** 文档内容按关键词高亮渲染（原 KnowledgePage 模块级函数，随抽屉一并搬移，实现保持原样）。 */
function renderHighlightedDocContent(content: string, keyword: string) {
  const q = keyword.trim();
  if (!q) return content;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = content.split(new RegExp(`(${escaped})`, "gi"));
  return parts.map((part, i) =>
    part.toLowerCase() === q.toLowerCase() ? (
      <mark
        key={i}
        style={{
          backgroundColor: "#ffe58f",
          color: "#000",
          padding: "1px 3px",
          borderRadius: 3,
          fontWeight: 600,
        }}
      >
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

export interface PreviewData {
  name: string;
  ext: string;
  size: number;
  updatedAt: string;
  content: string;
  truncated: boolean;
}

export interface DocPreviewDrawerProps {
  previewDrawerOpen: boolean;
  setPreviewDrawerOpen: (open: boolean) => void;
  setDocSearchKeyword: (value: string) => void;
  previewLoading: boolean;
  previewData: PreviewData | null;
  previewDocTags: string[];
  docSearchKeyword: string;
  docSearchMatchCount: number;
  handleAskButlerAboutDoc: (docName: string, intent: "summary" | "todos" | "audit" | "brief") => void;
  handleFilterByTag: (tag: string) => void;
  message: MessageInstance;
}

export function DocPreviewDrawer({
  previewDrawerOpen,
  setPreviewDrawerOpen,
  setDocSearchKeyword,
  previewLoading,
  previewData,
  previewDocTags,
  docSearchKeyword,
  docSearchMatchCount,
  handleAskButlerAboutDoc,
  handleFilterByTag,
  message,
}: DocPreviewDrawerProps) {
  return (
    <Drawer
      title={
        <Flex align="center" gap={8}>
          <FileTextOutlined style={{ color: "var(--ant-color-primary)" }} />
          <Typography.Text
            strong
            copyable={{
              text: previewData?.name ?? "",
              tooltips: ["复制文件名", "已复制"],
            }}
          >
            {previewData?.name ? `文档原文预览：${previewData.name}` : "文档原文预览"}
          </Typography.Text>
        </Flex>
      }
      placement="right"
      size={680}
      styles={{ wrapper: { maxWidth: "100%" } }}
      open={previewDrawerOpen}
      onClose={() => {
        setPreviewDrawerOpen(false);
        setDocSearchKeyword("");
      }}
    >
      {previewLoading ? (
        <Flex justify="center" align="center" style={{ height: 200 }}>
          <LoadingOutlined style={{ fontSize: 32 }} spin />
        </Flex>
      ) : previewData ? (
        <Flex vertical gap={12}>
          <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
            <Space>
              <Tag color="blue">{previewData.ext.toUpperCase() || "DOC"}</Tag>
              <Text type="secondary">{Math.max(1, Math.round(previewData.size / 1024))} KB</Text>
              <Text type="secondary">更新时间：{new Date(previewData.updatedAt).toLocaleString()}</Text>
            </Space>
            <Space wrap>
              <Dropdown
                menu={{
                  items: [
                    {
                      key: "summary",
                      label: "💡 梳理核心要点与操作步骤（默认）",
                      onClick: () => handleAskButlerAboutDoc(previewData.name, "summary"),
                    },
                    {
                      key: "todos",
                      label: "📋 提取行动项与待办清单",
                      onClick: () => handleAskButlerAboutDoc(previewData.name, "todos"),
                    },
                    {
                      key: "audit",
                      label: "🛡️ 审查潜在风险与合规注意",
                      onClick: () => handleAskButlerAboutDoc(previewData.name, "audit"),
                    },
                    {
                      key: "brief",
                      label: "📝 总结为 200 字即时工作简报",
                      onClick: () => handleAskButlerAboutDoc(previewData.name, "brief"),
                    },
                  ],
                }}
                trigger={["click"]}
              >
                <Button type="primary" size="small" icon={<CommentOutlined />}>
                  <span>在即时通讯中提问</span>
                  <DownOutlined style={{ fontSize: 10, marginLeft: 2 }} />
                </Button>
              </Dropdown>
              <CopySnippetButton text={previewData.content} label="复制全文" />
              <Tooltip title="复制知识库引用标签 ([参考本地知识库: 《...》])">
                <Button
                  size="small"
                  icon={<BookOutlined style={{ color: "var(--ant-color-primary)" }} />}
                  onClick={() => {
                    const refTag = `[参考本地知识库: 《${previewData.name}》]`;
                    void navigator.clipboard.writeText(refTag);
                    message.success(`已复制引用标签: ${refTag}`);
                  }}
                >
                  复制引用标签
                </Button>
              </Tooltip>
            </Space>
          </Flex>

          {/* 提取出的标签快速过滤 */}
          {previewDocTags.length > 0 && (
            <Flex align="center" gap={6} wrap="wrap" style={{ padding: "2px 0" }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                文档标签：
              </Text>
              {previewDocTags.map((tag) => (
                <Tag
                  key={tag}
                  color="processing"
                  style={{ cursor: "pointer", margin: 0 }}
                  onClick={() => handleFilterByTag(tag)}
                  title={`点击在收集箱中按标签「${tag}」筛选`}
                >
                  {tag}
                </Tag>
              ))}
            </Flex>
          )}

          {/* 文档内关键词搜索工具条 */}
          <Flex align="center" justify="space-between" gap={8} style={{ padding: "4px 0" }}>
            <Input
              size="small"
              prefix={<SearchOutlined style={{ color: "var(--ab-text-secondary)" }} />}
              placeholder="在文档中搜索关键词..."
              allowClear
              value={docSearchKeyword}
              onChange={(e) => setDocSearchKeyword(e.target.value)}
              style={{ maxWidth: 280 }}
            />
            {docSearchKeyword.trim() && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                匹配到 <strong style={{ color: docSearchMatchCount > 0 ? "var(--ant-color-primary)" : "var(--ant-color-error)" }}>{docSearchMatchCount}</strong> 处
              </Text>
            )}
          </Flex>

          {previewData.truncated && (
            <Alert
              type="info"
              showIcon
              title="文档内容较长，已展示前 16,000 字符预览，全部内容已建立切片索引。"
            />
          )}

          <div
            style={{
              fontFamily: "monospace",
              fontSize: 13,
              lineHeight: "1.6",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: "var(--ant-color-fill-quaternary)",
              padding: "12px 16px",
              borderRadius: 8,
              maxHeight: "70vh",
              overflowY: "auto",
              border: "1px solid var(--ant-color-border-secondary)",
            }}
          >
            {previewData.content ? renderHighlightedDocContent(previewData.content, docSearchKeyword) : "（暂无文本内容）"}
          </div>
        </Flex>
      ) : (
        <Empty description="该文件暂无文本预览内容或格式无法直接解析" />
      )}
    </Drawer>
  );
}
