/**
 * 已启用但容器未运行时的启动引导面板（F-3 拆分自 KnowledgePage，JSX 原样搬移）。
 * 启动流程与轮询逻辑仍在 KnowledgePage。
 */
import { Alert, Button, Card, Flex, Progress, Space, Steps, Tag } from "antd";
import { Typography } from "antd";
import { LoadingOutlined, PlayCircleOutlined } from "@ant-design/icons";
import type { RefObject } from "react";
import { CopySnippetButton } from "../../components/CopySnippetButton.js";
import type { StartupProgress } from "./KnowledgePage.js";

const { Text, Title } = Typography;

const START_COMMAND = "docker compose up -d butler-rag-anythingllm";

export interface StartupPanelProps {
  startupProgress: StartupProgress | null;
  currentStep: number;
  launchingInWeb: boolean;
  handleLaunchInWeb: () => void;
  terminalBottomRef: RefObject<HTMLDivElement | null>;
}

export function StartupPanel({
  startupProgress,
  currentStep,
  launchingInWeb,
  handleLaunchInWeb,
  terminalBottomRef,
}: StartupPanelProps) {
  return (
    <Card
      style={{
        borderRadius: 12,
        border: "1px solid var(--ant-color-border-secondary)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
      }}
    >
      <Flex vertical gap={20}>
        {/* 顶部标题与一键拉起按钮 */}
        <Flex justify="space-between" align="center" wrap="wrap" gap={12}>
          <div>
            <Flex align="center" gap={8}>
              <Title level={4} style={{ margin: 0 }}>
                本地知识库容器启动与进度
              </Title>
              {startupProgress?.active ? (
                <Tag icon={<LoadingOutlined />} color="processing">
                  启动流式输出中
                </Tag>
              ) : (
                <Tag color="warning">待启动</Tag>
              )}
            </Flex>
            <Text type="secondary" style={{ fontSize: 13 }}>
              后台雷达正在自动侦听回环端口 127.0.0.1:3001；服务就绪后界面将自动切入工作台，无需手动刷新。
            </Text>
          </div>

          <Space wrap>
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              onClick={handleLaunchInWeb}
              loading={launchingInWeb || startupProgress?.active}
            >
              立即在网页中拉起容器
            </Button>
          </Space>
        </Flex>

        {/* 异常状态智能诊断提示条 */}
        {startupProgress?.stage === "failed" && (
          <Alert
            type="error"
            showIcon
            title={startupProgress.stageLabel || "容器启动未就绪"}
            description={
              <Flex vertical gap={6}>
                <Text style={{ fontSize: 13 }}>
                  {startupProgress.error || "未在预期时间内检测到容器就绪，请根据下方日志排查或在宿主终端手动启动。"}
                </Text>
                <Flex align="center" gap={8} wrap="wrap" style={{ marginTop: 2 }}>
                  <Text strong style={{ fontSize: 12 }}>宿主终端拉起命令：</Text>
                  <Text code style={{ fontSize: 12 }}>{START_COMMAND}</Text>
                  <CopySnippetButton text={START_COMMAND} label="一键复制" />
                </Flex>
              </Flex>
            }
            action={
              <Button
                size="small"
                danger
                onClick={handleLaunchInWeb}
                loading={launchingInWeb}
              >
                重新尝试
              </Button>
            }
            style={{ borderRadius: 8 }}
          />
        )}

        {/* 四步流水线步骤条 */}
        <Card size="small" style={{ background: "var(--ant-color-fill-quaternary)" }}>
          <Steps
            current={currentStep}
            status={startupProgress?.stage === "failed" ? "error" : undefined}
            size="small"
            items={[
              {
                title: "环境预检",
                description:
                  startupProgress?.stage === "failed" && currentStep === 0
                    ? (startupProgress.stageLabel || "环境受限")
                    : "校验调度环境与权限",
              },
              {
                title: "拉取镜像",
                description:
                  startupProgress?.stage === "failed" && currentStep === 1
                    ? (startupProgress.stageLabel || "拉取失败")
                    : "mintplexlabs/anythingllm",
              },
              {
                title: "端口探活",
                description:
                  startupProgress?.stage === "failed" && currentStep === 2
                    ? "探活响应超时"
                    : "127.0.0.1:3001",
              },
              { title: "就绪上线", description: "接入资料收集箱" },
            ]}
          />
        </Card>

        {/* 真实百分比动态进度条 */}
        <Flex vertical gap={6}>
          <Flex justify="space-between" align="center">
            <Text strong style={{ fontSize: 13 }}>
              当前阶段：{startupProgress?.stageLabel || "准备就绪"}
            </Text>
            <Text strong style={{ color: "var(--ant-color-primary)" }}>
              {startupProgress?.percent ?? 0}%
            </Text>
          </Flex>
          <Progress
            percent={startupProgress?.percent ?? 0}
            status={
              startupProgress?.stage === "failed"
                ? "exception"
                : startupProgress?.ready
                  ? "success"
                  : "active"
            }
            strokeColor={{ "0%": "#1677ff", "100%": "#52c41a" }}
            showInfo={false}
          />
        </Flex>

        {/* 实时终端控制台窗口 (Live Terminal Window) */}
        <div
          style={{
            borderRadius: 8,
            overflow: "hidden",
            border: "1px solid var(--ab-border)",
            background: "var(--ab-sunken)",
            boxShadow: "inset 0 1px 4px rgba(0,0,0,0.25)",
          }}
        >
          {/* 仿终端顶栏 */}
          <Flex
            justify="space-between"
            align="center"
            style={{
              padding: "6px 12px",
              background: "var(--ab-surface-2)",
              borderBottom: "1px solid var(--ab-border)",
            }}
          >
            <Flex align="center" gap={6}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: "var(--ab-error)",
                  display: "inline-block",
                }}
              />
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: "var(--ab-warn)",
                  display: "inline-block",
                }}
              />
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: "var(--ab-ok)",
                  display: "inline-block",
                }}
              />
              <Text
                style={{
                  color: "var(--ab-text-3)",
                  fontSize: 12,
                  marginLeft: 8,
                  fontFamily: "var(--ab-mono)",
                }}
              >
                AnythingLLM 实时终端输出 (Docker Compose)
              </Text>
            </Flex>
            <Space size="small">
              <CopySnippetButton
                text={startupProgress?.logs.join("\n") || START_COMMAND}
                label="复制日志"
              />
            </Space>
          </Flex>

          {/* 滚动日志区域 */}
          <div
            style={{
              padding: "12px 14px",
              minHeight: 180,
              maxHeight: 280,
              overflowY: "auto",
              fontFamily: "var(--ab-mono)",
              fontSize: 12,
              lineHeight: "1.6",
              color: "var(--ab-ok)",
            }}
          >
            {startupProgress?.logs && startupProgress.logs.length > 0 ? (
              startupProgress.logs.map((log, idx) => (
                <div
                  key={idx}
                  style={{
                    color: log.includes("[Success]")
                      ? "var(--ab-ok)"
                      : log.includes("[Warn]") || log.includes("[Notice]")
                        ? "var(--ab-warn)"
                        : log.includes("[Error]")
                          ? "var(--ab-error)"
                          : log.startsWith(">>>")
                            ? "var(--ab-primary)"
                            : "var(--ab-text-2)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                  }}
                >
                  {log}
                </div>
              ))
            ) : (
              <div style={{ color: "var(--ab-text-3)", fontStyle: "italic" }}>
                &gt; 等待指令。点击上方「立即在网页中拉起容器」可直接在网页中启动，或复制下方命令在外部终端运行。
              </div>
            )}
            <div ref={terminalBottomRef} />
          </div>
        </div>

        {/* 外部命令行备用参考 */}
        <Card size="small" style={{ background: "var(--ant-color-fill-quaternary)" }}>
          <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
            <Flex vertical gap={2}>
              <Text strong style={{ fontSize: 12 }}>
                外部宿主终端执行命令参考：
              </Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                若容器环境权限受限，直接在宿主终端运行此命令，网页将自动感应到端口亮起并切入工作台。
              </Text>
            </Flex>
            <Flex align="center" gap={8}>
              <Text code style={{ fontSize: 12 }}>
                {START_COMMAND}
              </Text>
              <CopySnippetButton text={START_COMMAND} label="复制代码" />
            </Flex>
          </Flex>
        </Card>
      </Flex>
    </Card>
  );
}
