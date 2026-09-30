/**
 * 新建私有笔记与知识卡片弹窗（F-3 拆分自 KnowledgePage，JSX 原样搬移）。
 * 状态与保存逻辑仍在 KnowledgePage，本组件只负责展示。
 */
import { Button, Flex, Input, Modal, Segmented, Space } from "antd";
import { Typography } from "antd";

const { Text } = Typography;
import { FileTextOutlined } from "@ant-design/icons";

export interface CreateNoteModalProps {
  createNoteModalOpen: boolean;
  setCreateNoteModalOpen: (open: boolean) => void;
  creatingNote: boolean;
  handleCreateNote: () => void;
  newNoteTitle: string;
  setNewNoteTitle: (value: string | ((prev: string) => string)) => void;
  newNoteCategory: string;
  setNewNoteCategory: (value: string) => void;
  newNoteContent: string;
  setNewNoteContent: (value: string) => void;
}

export function CreateNoteModal({
  createNoteModalOpen,
  setCreateNoteModalOpen,
  creatingNote,
  handleCreateNote,
  newNoteTitle,
  setNewNoteTitle,
  newNoteCategory,
  setNewNoteCategory,
  newNoteContent,
  setNewNoteContent,
}: CreateNoteModalProps) {
  return (
    <Modal
      title={
        <Flex align="center" gap={8}>
          <FileTextOutlined style={{ color: "var(--ab-primary)" }} />
          <span>新建私有笔记与知识卡片</span>
        </Flex>
      }
      open={createNoteModalOpen}
      onCancel={() => {
        if (!creatingNote) {
          setCreateNoteModalOpen(false);
        }
      }}
      onOk={handleCreateNote}
      okText={creatingNote ? "保存入库中..." : "保存并自动切片入库"}
      confirmLoading={creatingNote}
      destroyOnClose
      width={560}
    >
      <Flex vertical gap={14} style={{ marginTop: 16 }}>
        <div>
          <Text strong style={{ fontSize: 13, marginBottom: 4, display: "block" }}>
            笔记标题 / 文件名
          </Text>
          <Input
            placeholder="例如：系统核心架构设计规范（自动补齐 .md 后缀）"
            value={newNoteTitle}
            onChange={(e) => setNewNoteTitle(e.target.value)}
            allowClear
          />
        </div>

        <div>
          <Text strong style={{ fontSize: 13, marginBottom: 4, display: "block" }}>
            知识分类预设
          </Text>
          <Segmented
            size="small"
            block
            value={newNoteCategory}
            onChange={(val: string | number) => setNewNoteCategory(String(val))}
            options={[
              { label: "🔖 知识卡片", value: "card" },
              { label: "📓 技术架构", value: "tech" },
              { label: "💡 灵感备忘", value: "idea" },
              { label: "📋 运维规程", value: "sop" },
            ]}
          />
        </div>

        <div>
          <Flex justify="space-between" align="center" style={{ marginBottom: 4 }}>
            <Text strong style={{ fontSize: 13 }}>
              正文内容 (支持 Markdown)
            </Text>
            <Space size={4}>
              <Button
                size="small"
                type="text"
                style={{ fontSize: 11, padding: "0 4px", color: "var(--ab-primary)" }}
                onClick={() => {
                  setNewNoteTitle((prev) => prev || "系统模块架构设计规范");
                  setNewNoteCategory("tech");
                  setNewNoteContent(`## 1. 架构目标与背景
- 解决痛点：
- 核心指标：

## 2. 模块分工与依赖拓扑
- 核心模块与职责：
- 外部依赖与通信端口：

## 3. 数据流与容错机制
- 核心消息处理链路：
- 异常自愈策略：`);
                }}
              >
                架构模版
              </Button>
              <span style={{ color: "var(--ab-border)" }}>|</span>
              <Button
                size="small"
                type="text"
                style={{ fontSize: 11, padding: "0 4px", color: "var(--ab-primary)" }}
                onClick={() => {
                  setNewNoteTitle((prev) => prev || "通道异常排查与恢复SOP");
                  setNewNoteCategory("sop");
                  setNewNoteContent(`## 1. 适用场景与触发条件
- 故障现象：
- 前置检查命令：

## 2. 标准排错与处置步骤
1. 第一步：检查容器与进程状态
2. 第二步：分析死信或错误日志
3. 第三步：执行滚动重启或配置修正

## 3. 验收标准与恢复验证
- 验证指令：
- 预期输出：`);
                }}
              >
                运维模版
              </Button>
              <span style={{ color: "var(--ab-border)" }}>|</span>
              <Button
                size="small"
                type="text"
                style={{ fontSize: 11, padding: "0 4px", color: "var(--ab-primary)" }}
                onClick={() => {
                  setNewNoteTitle((prev) => prev || "关键技术知识卡片");
                  setNewNoteCategory("card");
                  setNewNoteContent(`## 核心概念与工作原理

## 典型应用场景与关键代码
\`\`\`bash
# 常用排障或配置命令
\`\`\`

## 避坑指南与最佳实践
- 注意事项 1：
- 注意事项 2：`);
                }}
              >
                卡片模版
              </Button>
            </Space>
          </Flex>
          <Input.TextArea
            placeholder="输入知识点、架构说明、运维备忘或核心规则... (支持 Ctrl+Enter 快捷保存)"
            value={newNoteContent}
            onChange={(e) => setNewNoteContent(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                void handleCreateNote();
              }
            }}
            autoSize={{ minRows: 6, maxRows: 14 }}
            showCount
          />
          <div style={{ marginTop: 4, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Text type="secondary" style={{ fontSize: 11 }}>
              <kbd className="im-kbd-hint">Ctrl + Enter</kbd> 快捷保存入库 · 写入后自动分段切片
            </Text>
          </div>
        </div>
      </Flex>
    </Modal>
  );
}
