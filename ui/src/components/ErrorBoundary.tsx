import React, { Component, type ReactNode } from "react";
import { Button, Card, Flex, Typography } from "antd";
import {
  ReloadOutlined,
  HomeOutlined,
  MedicineBoxOutlined,
  CopyOutlined,
  CheckOutlined,
  AlertOutlined,
} from "@ant-design/icons";

export interface ErrorBoundaryProps {
  children: ReactNode;
  fallbackTitle?: string;
  fallbackSubtitle?: string;
  retryLabel?: string;
  onReset?: () => void;
  compact?: boolean;
}

export interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  copied: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = {
    hasError: false,
    error: null,
    errorInfo: null,
    copied: false,
  };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.setState({ errorInfo: info });
    console.error("ErrorBoundary caught render exception:", error, info);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, errorInfo: null, copied: false });
    this.props.onReset?.();
  };

  handleGoHome = () => {
    this.setState({ hasError: false, error: null, errorInfo: null, copied: false });
    if (typeof window !== "undefined") {
      window.history.pushState(null, "", "/dashboard");
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  };

  handleGoTroubleshoot = () => {
    this.setState({ hasError: false, error: null, errorInfo: null, copied: false });
    if (typeof window !== "undefined") {
      window.history.pushState(null, "", "/troubleshoot");
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  };

  handleCopy = () => {
    const { error, errorInfo } = this.state;
    const content = [
      `Error: ${error?.name}: ${error?.message}`,
      error?.stack ? `\nStack:\n${error.stack}` : "",
      errorInfo?.componentStack ? `\nComponent Stack:\n${errorInfo.componentStack}` : "",
    ].join("");

    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(content).then(() => {
        this.setState({ copied: true });
        setTimeout(() => this.setState({ copied: false }), 2000);
      });
    }
  };

  override render() {
    if (this.state.hasError) {
      const { fallbackTitle, fallbackSubtitle, compact } = this.props;
      const { error, errorInfo, copied } = this.state;

      if (compact) {
        return (
          <div
            role="alert"
            style={{
              padding: "12px 16px",
              borderRadius: 8,
              background: "var(--ab-error-soft)",
              border: "1px solid var(--ab-error)",
              margin: "8px 0",
            }}
          >
            <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
              <Flex align="center" gap={8}>
                <AlertOutlined style={{ color: "var(--ab-error)" }} />
                <Typography.Text strong style={{ fontSize: 13 }}>
                  {fallbackTitle || "组件视图渲染异常"}
                </Typography.Text>
              </Flex>
              <Button size="small" icon={<ReloadOutlined />} onClick={this.handleRetry}>
                重试加载
              </Button>
            </Flex>
          </div>
        );
      }

      return (
        <div role="alert" style={{ padding: "16px 0", maxWidth: 960, margin: "0 auto" }}>
          <Card
            className="error-boundary-card"
            style={{
              borderRadius: 16,
              border: "1px solid var(--ab-border)",
              background: "var(--ab-surface)",
              boxShadow: "var(--ab-shadow-2)",
              overflow: "hidden",
            }}
          >
            <Flex vertical gap={16}>
              {/* 头部提示与隔离保护说明 */}
              <Flex align="flex-start" gap={14}>
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 12,
                    background: "var(--ab-warn-soft)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <AlertOutlined style={{ fontSize: 22, color: "var(--ab-warn)" }} />
                </div>
                <Flex vertical gap={4} style={{ flex: 1, minWidth: 0 }}>
                  <Typography.Title level={4} style={{ margin: 0, fontSize: 17 }}>
                    {fallbackTitle || "页面区域渲染受阻 (Render Boundary Protected)"}
                  </Typography.Title>
                  <Typography.Paragraph type="secondary" style={{ margin: 0, fontSize: 13 }}>
                    {fallbackSubtitle ||
                      "此模块渲染时捕获到未预期的异常。为保护全局系统控制台，管家已对该区域执行安全隔离，侧边导航、紧急熔断与后端服务均保持正常可用。"}
                  </Typography.Paragraph>
                </Flex>
              </Flex>

              {/* 错误简报摘要 */}
              <div
                style={{
                  padding: "10px 14px",
                  borderRadius: 8,
                  background: "var(--ab-surface-2)",
                  border: "1px solid var(--ab-border)",
                  fontFamily: "var(--ab-mono, monospace)",
                  fontSize: 12.5,
                  color: "var(--ab-error)",
                  wordBreak: "break-all",
                }}
              >
                <strong>{error?.name || "RenderError"}</strong>: {error?.message || "未捕获的渲染异常"}
              </div>

              {/* 动作栏 */}
              <Flex wrap="wrap" gap={10} align="center">
                <Button type="primary" icon={<ReloadOutlined />} onClick={this.handleRetry}>
                  {this.props.retryLabel || "重试加载组件"}
                </Button>
                <Button icon={<HomeOutlined />} onClick={this.handleGoHome}>
                  返回系统仪表盘
                </Button>
                <Button icon={<MedicineBoxOutlined />} onClick={this.handleGoTroubleshoot}>
                  前往排障与自愈向导
                </Button>
              </Flex>

              {/* 可折叠的技术诊断堆栈 */}
              <details
                style={{
                  marginTop: 4,
                  fontSize: 12,
                  color: "var(--ab-text-3)",
                  borderTop: "1px solid var(--ab-border)",
                  paddingTop: 12,
                }}
              >
                <summary style={{ cursor: "pointer", userSelect: "none", fontWeight: 500 }}>
                  查看技术诊断信息与组件堆栈 (Technical Diagnostics)
                </summary>
                <div style={{ marginTop: 8 }}>
                  <Flex justify="flex-end" style={{ marginBottom: 6 }}>
                    <Button
                      size="small"
                      type="text"
                      icon={copied ? <CheckOutlined style={{ color: "var(--ab-ok)" }} /> : <CopyOutlined />}
                      onClick={this.handleCopy}
                    >
                      {copied ? "已复制到剪贴板" : "复制完整诊断信息"}
                    </Button>
                  </Flex>
                  <pre
                    style={{
                      margin: 0,
                      padding: 12,
                      borderRadius: 8,
                      background: "var(--ab-sunken)",
                      color: "var(--ab-text)",
                      fontSize: 11,
                      fontFamily: "var(--ab-mono, monospace)",
                      maxHeight: 180,
                      overflow: "auto",
                      whiteSpace: "pre-wrap",
                      lineHeight: 1.5,
                    }}
                  >
                    {error?.stack || error?.message || "无可用堆栈信息"}
                    {errorInfo?.componentStack}
                  </pre>
                </div>
              </details>
            </Flex>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
