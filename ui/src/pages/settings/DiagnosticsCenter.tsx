/**
 * 设置页右栏诊断面板：一键生成脱敏诊断报告。
 * 保留文本响应处理；超时与失败文案走固定文案，成败均有 message 提示。
 */
import { useState, type CSSProperties } from "react";
import { App, Button, Flex, Space, Typography } from "antd";
import { fetchBlob, fetchText } from "../../lib/api.js";
import { AdvancedDetails } from "../../components/AdvancedDetails.js";
import { SectionHeader } from "../../components/SectionHeader.js";

const { Paragraph, Text } = Typography;

const OFFLINE_TEXT = "管家服务暂时连不上，请稍后再试。";

/** 报告预览：等宽字体、限高滚动，配色走 antd Token。 */
const REPORT_PREVIEW_STYLE: CSSProperties = {
  margin: 0,
  padding: 12,
  background: "var(--ant-color-fill-tertiary)",
  borderRadius: "var(--ant-border-radius-lg)",
  fontFamily: "var(--butler-mono-font)",
  fontSize: 12,
  lineHeight: 1.6,
  maxHeight: 320,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

interface DiagnosticsCenterProps {
  /** 页面级危险操作进行中时禁用入口。 */
  actionBusy: boolean;
}

interface DiagnosticState {
  busy: boolean;
  text: string | null;
  error: string | null;
}

export function DiagnosticsCenter({ actionBusy }: DiagnosticsCenterProps) {
  const { message } = App.useApp();
  const [diagnostic, setDiagnostic] = useState<DiagnosticState>({
    busy: false,
    text: null,
    error: null,
  });

  const runDiagnostic = async () => {
    if (diagnostic.busy) return;
    setDiagnostic({ busy: true, text: null, error: null });
    try {
      const result = await fetchText("/api/diagnostics/report", 20_000);
      if (!result.ok) {
        setDiagnostic({ busy: false, text: null, error: result.reason });
        message.error(result.reason);
        return;
      }
      setDiagnostic({ busy: false, text: result.text, error: null });
      message.success("诊断报告已生成，可在下方查看并下载。");
    } catch {
      setDiagnostic({ busy: false, text: null, error: OFFLINE_TEXT });
      message.error(OFFLINE_TEXT);
    }
  };

  const downloadDiagnostic = (text: string) => {
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `agent-butler-diagnostic-${new Date().toISOString().slice(0, 10)}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const downloadDiagnosticZip = async () => {
    const result = await fetchBlob("/api/diagnostics/report?format=zip");
    if (!result.ok) {
      message.error(`诊断包没有生成：${result.reason}`);
      return;
    }
    const blob = result.blob;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `agent-butler-diagnostic-${new Date().toISOString().slice(0, 10)}.zip`;
    anchor.click();
    URL.revokeObjectURL(url);
    message.success("脱敏诊断包已下载，可以直接附到 Issue。");
  };

  return (
    <section>
      <Flex vertical gap={12}>
        <SectionHeader compact kicker="诊断报告" title="一键生成诊断报告" />
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          打包脱敏的日志问题、错误指纹、巡检快照和配置摘要；不含密钥和聊天正文。
        </Paragraph>
        <Space wrap>
          <Button
            type="primary"
            loading={diagnostic.busy}
            disabled={actionBusy || diagnostic.busy}
            onClick={() => void runDiagnostic()}
          >
            生成诊断报告
          </Button>
        </Space>
        {diagnostic.error !== null && (
          <Text role="status" type="danger">
            {diagnostic.error}
          </Text>
        )}
        {diagnostic.text !== null && (
          <AdvancedDetails summary="查看报告（可下载）" defaultActive>
            <Flex vertical gap={12}>
              <pre style={REPORT_PREVIEW_STYLE}>{diagnostic.text}</pre>
              <Space wrap>
                <Button onClick={() => downloadDiagnostic(diagnostic.text!)}>
                  下载 Markdown
                </Button>
                <Button type="primary" onClick={() => void downloadDiagnosticZip()}>
                  下载诊断 ZIP
                </Button>
              </Space>
            </Flex>
          </AdvancedDetails>
        )}
      </Flex>
    </section>
  );
}