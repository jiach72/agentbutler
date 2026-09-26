/**
 * 本地知识库配置卡片（AnythingLLM RAG）：
 * 1. 运行与探活状态实时显示；
 * 2. 开启/关闭主开关，配合二次确认弹窗（明确说明内存开销 ~300-500MB 与持久化保障）；
 * 3. 展示外部访问端口（127.0.0.1:3001）、本地 Ollama 直连状态与数据卷；
 * 4. 提供一键复制终端启动命令与直达知识库工作台的快捷链接。
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Alert,
  App,
  Button,
  Card,
  Divider,
  Flex,
  Space,
  Switch,
  Tag,
  Typography,
} from "antd";
import {
  BookOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  ExclamationCircleOutlined,
  LinkOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { loadJson, postJson } from "../../lib/api.js";
import { CopySnippetButton } from "../../components/CopySnippetButton.js";

const { Paragraph, Text, Title } = Typography;

export interface KnowledgeStatus {
  enabled: boolean;
  running: boolean;
  endpoint: string;
  externalUrl: string;
  ollamaUrl: string;
  vectorDb: string;
  volume: string;
  profile: string;
  error?: string;
}

const START_COMMAND = "docker compose up -d butler-rag-anythingllm";
const STOP_COMMAND = "docker compose stop butler-rag-anythingllm";

export function KnowledgeConfigCard() {
  const { message, modal } = App.useApp();
  const [status, setStatus] = useState<KnowledgeStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [toggling, setToggling] = useState(false);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    const res = await loadJson<KnowledgeStatus>("/api/knowledge/status", 5_000);
    if (res.ok && res.data) {
      setStatus(res.data);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const handleToggle = useCallback(
    (checked: boolean) => {
      if (checked) {
        modal.confirm({
          title: "确认开启本地知识库？",
          icon: <ExclamationCircleOutlined style={{ color: "var(--ant-color-primary)" }} />,
          content: (
            <Flex vertical gap={8} style={{ marginTop: 8 }}>
              <Paragraph style={{ margin: 0 }}>
                开启后，将启用 <strong>AnythingLLM</strong> 单容器服务并监听{" "}
                <Text code>127.0.0.1:3001</Text>。
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                • <strong>本地模型联动</strong>：自动直连本地 Ollama 共享 Embedding 与模型，100% 离线私有；
                <br />
                • <strong>资源占用</strong>：容器预计占用约 <strong>300MB ~ 500MB</strong> 内存；
                <br />
                • <strong>持久化存储</strong>：资料文件与向量索引安全写入 <Text code>anythingllm-data</Text> 命名卷。
              </Paragraph>
            </Flex>
          ),
          okText: "确认开启",
          cancelText: "取消",
          onOk: async () => {
            setToggling(true);
            const res = await postJson("/api/knowledge/toggle", { enabled: true }, 10_000);
            setToggling(false);
            if (res.ok) {
              message.success("已记录开启偏好！请确保容器服务已启动。");
              void fetchStatus();
            } else {
              message.error("切换失败，请重试");
            }
          },
        });
      } else {
        modal.confirm({
          title: "确认关闭本地知识库？",
          icon: <ExclamationCircleOutlined style={{ color: "var(--ant-color-warning)" }} />,
          content: (
            <Flex vertical gap={8} style={{ marginTop: 8 }}>
              <Paragraph style={{ margin: 0 }}>
                关闭后将停止本地知识库服务，释放系统内存。
              </Paragraph>
              <Paragraph style={{ margin: 0 }} type="secondary">
                您之前上传的全部文档与向量索引将安全保存在数据卷中，重新开启后立即可用，数据绝不丢失。
              </Paragraph>
            </Flex>
          ),
          okText: "确认关闭",
          okButtonProps: { danger: true },
          cancelText: "取消",
          onOk: async () => {
            setToggling(true);
            const res = await postJson("/api/knowledge/toggle", { enabled: false }, 10_000);
            setToggling(false);
            if (res.ok) {
              message.success("已记录关闭偏好。");
              void fetchStatus();
            } else {
              message.error("切换失败，请重试");
            }
          },
        });
      }
    },
    [modal, message, fetchStatus],
  );

  const isRunning = status?.running ?? false;
  const isEnabled = status?.enabled ?? false;

  return (
    <Card
      title={
        <Flex align="center" gap={8}>
          <BookOutlined style={{ color: "var(--ant-color-primary)" }} />
          <span>本地知识库 (AnythingLLM RAG)</span>
        </Flex>
      }
      extra={
        <Button
          size="small"
          icon={<ReloadOutlined spin={loading} />}
          onClick={fetchStatus}
          disabled={loading}
        >
          刷新状态
        </Button>
      }
    >
      <Flex vertical gap={16}>
        <Flex justify="space-between" align="center" wrap="wrap" gap={12}>
          <div>
            <Title level={5} style={{ margin: 0 }}>
              开启本地知识库
            </Title>
            <Text type="secondary" style={{ fontSize: 13 }}>
              启用轻量级私有文档知识库，支持批量收集并解析各类文件，供智能体随时引用检索。
            </Text>
          </div>
          <Flex align="center" gap={12}>
            {isRunning ? (
              <Tag icon={<CheckCircleFilled />} color="success">
                运行中 (:3001)
              </Tag>
            ) : isEnabled ? (
              <Tag color="warning">已启用 (等待服务响应)</Tag>
            ) : (
              <Tag icon={<CloseCircleFilled />} color="default">
                已关闭
              </Tag>
            )}
            <Switch
              checked={isEnabled}
              onChange={handleToggle}
              loading={toggling || loading}
              checkedChildren="开启"
              unCheckedChildren="关闭"
            />
          </Flex>
        </Flex>

        <Divider style={{ margin: "4px 0" }} />

        {isRunning ? (
          <Alert
            type="success"
            showIcon
            message="本地知识库服务正常在线"
            description={
              <Flex vertical gap={8} style={{ marginTop: 4 }}>
                <Text>
                  AnythingLLM 已正常监听在{" "}
                  <Text code>{status?.externalUrl ?? "http://127.0.0.1:3001"}</Text>，并已自动接入本地
                  Ollama 向量模型。
                </Text>
                <Space wrap>
                  <Button
                    type="primary"
                    icon={<LinkOutlined />}
                    href={status?.externalUrl ?? "http://127.0.0.1:3001"}
                    target="_blank"
                    rel="noreferrer"
                  >
                    在新窗口打开资料收集箱
                  </Button>
                  <Link to="/knowledge">
                    <Button icon={<BookOutlined />}>前往知识库管理页</Button>
                  </Link>
                </Space>
              </Flex>
            }
          />
        ) : isEnabled ? (
          <Alert
            type="info"
            showIcon
            message="知识库选项已开启，请启动 Docker 容器"
            description={
              <Flex vertical gap={8} style={{ marginTop: 4 }}>
                <Text>
                  若容器未在后台自动运行，您可以在侧栏「本地知识库」页面直接查看实时构建进度与终端日志，或在外部终端拉起容器：
                </Text>
                <Flex align="center" gap={12} wrap="wrap">
                  <Link to="/knowledge">
                    <Button type="primary" icon={<BookOutlined />}>
                      前往知识库查看实时终端进度
                    </Button>
                  </Link>
                  <Flex align="center" gap={8}>
                    <Text code style={{ fontSize: 13 }}>
                      {START_COMMAND}
                    </Text>
                    <CopySnippetButton text={START_COMMAND} label="复制命令" />
                  </Flex>
                </Flex>
              </Flex>
            }
          />
        ) : (
          <Alert
            type="info"
            showIcon
            message="功能未开启"
            description="开启后即可直接拖拽上传 PDF、Word、TXT、Markdown 等资料，智能体将能够精准检索相关文档知识。"
          />
        )}

        <details className="knowledge-config-details">
          <summary>服务技术规格与配置参数</summary>
          <div className="knowledge-config-specs">
            <div
              style={{
                padding: "10px 14px",
                borderRadius: 8,
                background: "var(--ant-color-fill-quaternary)",
                border: "1px solid var(--ant-color-border-secondary)",
              }}
            >
              <Text type="secondary" style={{ fontSize: 12 }}>
                服务访问入口
              </Text>
              <div style={{ marginTop: 4 }}>
                <Text code>{status?.externalUrl ?? "127.0.0.1:3001"}</Text>
                <Tag color="cyan" style={{ marginLeft: 6 }}>
                  回环安全
                </Tag>
              </div>
            </div>

            <div
              style={{
                padding: "10px 14px",
                borderRadius: 8,
                background: "var(--ant-color-fill-quaternary)",
                border: "1px solid var(--ant-color-border-secondary)",
              }}
            >
              <Text type="secondary" style={{ fontSize: 12 }}>
                向量数据库 (Vector DB)
              </Text>
              <div style={{ marginTop: 4 }}>
                <Text strong>{status?.vectorDb ?? "LanceDB"}</Text>
                <Text type="secondary" style={{ fontSize: 12, marginLeft: 4 }}>
                  (轻量嵌入式)
                </Text>
              </div>
            </div>

            <div
              style={{
                padding: "10px 14px",
                borderRadius: 8,
                background: "var(--ant-color-fill-quaternary)",
                border: "1px solid var(--ant-color-border-secondary)",
              }}
            >
              <Text type="secondary" style={{ fontSize: 12 }}>
                Embedding 与模型引擎
              </Text>
              <div style={{ marginTop: 4 }}>
                <Text strong>本地 Ollama</Text>
                <Text type="secondary" style={{ fontSize: 12, marginLeft: 4 }}>
                  (:11434)
                </Text>
              </div>
            </div>

            <div
              style={{
                padding: "10px 14px",
                borderRadius: 8,
                background: "var(--ant-color-fill-quaternary)",
                border: "1px solid var(--ant-color-border-secondary)",
              }}
            >
              <Text type="secondary" style={{ fontSize: 12 }}>
                数据持久化命名卷
              </Text>
              <div style={{ marginTop: 4 }}>
                <Text code>{status?.volume ?? "anythingllm-data"}</Text>
              </div>
            </div>
          </div>
        </details>

        {isEnabled && !isRunning && (
          <Flex vertical gap={6}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              命令行快速停止参考：
            </Text>
            <Flex align="center" gap={8}>
              <Text code style={{ fontSize: 12 }}>
                {STOP_COMMAND}
              </Text>
              <CopySnippetButton text={STOP_COMMAND} label="复制停止命令" />
            </Flex>
          </Flex>
        )}
      </Flex>
    </Card>
  );
}
