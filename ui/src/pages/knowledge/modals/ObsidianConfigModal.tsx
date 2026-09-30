/**
 * Obsidian 笔记库路径配置弹窗（F-3 拆分自 KnowledgePage，JSX 原样搬移）。
 * 状态与保存/测试逻辑仍在 KnowledgePage，本组件只负责展示。
 */
import { Alert, Button, Flex, Input, Modal } from "antd";
import { Typography } from "antd";

const { Paragraph, Text } = Typography;

export interface TestPathResult {
  exists: boolean;
  noteCount: number;
  resolvedPath: string;
  message: string;
}

export interface ObsidianConfigModalProps {
  obsidianModalOpen: boolean;
  handleSaveObsidianConfig: () => void;
  setObsidianModalOpen: (open: boolean) => void;
  setTestPathResult: (result: TestPathResult | null) => void;
  obsidianPathInput: string;
  setObsidianPathInput: (value: string) => void;
  handleTestPath: () => void;
  testingPath: boolean;
  testPathResult: TestPathResult | null;
}

export function ObsidianConfigModal({
  obsidianModalOpen,
  handleSaveObsidianConfig,
  setObsidianModalOpen,
  setTestPathResult,
  obsidianPathInput,
  setObsidianPathInput,
  handleTestPath,
  testingPath,
  testPathResult,
}: ObsidianConfigModalProps) {
  return (
    <Modal
      title="配置 Obsidian 笔记库本地路径"
      open={obsidianModalOpen}
      onOk={handleSaveObsidianConfig}
      onCancel={() => {
        setObsidianModalOpen(false);
        setTestPathResult(null);
      }}
      okText="保存路径"
      cancelText="取消"
    >
      <Flex vertical gap={12} style={{ marginTop: 12 }}>
        <Paragraph style={{ margin: 0, fontSize: 13 }}>
          若您希望绑定固定的本地路径进行后台周期同步，支持 macOS（如 <Text code>/Users/name/Documents/Notes</Text>）、Linux（如 <Text code>/home/name/notes</Text>）以及 Windows 绝对路径（如 <Text code>C:\Users\name\Documents\Notes</Text>）：
        </Paragraph>
        <Flex gap={8}>
          <Input
            placeholder="例如：/Users/name/Notes 或 C:\Users\name\Documents\MyVault"
            value={obsidianPathInput}
            onChange={(e) => {
              setObsidianPathInput(e.target.value);
              setTestPathResult(null);
            }}
          />
          <Button onClick={handleTestPath} loading={testingPath}>
            测试路径
          </Button>
        </Flex>

        {testPathResult && (
          <Alert
            type={testPathResult.exists ? "success" : "warning"}
            showIcon
            title={testPathResult.message}
            description={
              testPathResult.exists ? (
                <Text style={{ fontSize: 12 }}>
                  有效路径：<Text code>{testPathResult.resolvedPath}</Text>，可直接同步！
                </Text>
              ) : (
                <Text style={{ fontSize: 12 }}>
                  提示：全平台用户（macOS / Linux / Windows）均可直接在主界面点击「选择本地 Obsidian 笔记库文件夹」按钮，由浏览器原生拾取并建立索引同步，无需手动配置容器路径映射。
                </Text>
              )
            }
          />
        )}
      </Flex>
    </Modal>
  );
}
