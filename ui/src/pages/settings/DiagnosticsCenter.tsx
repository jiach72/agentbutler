/**
 * 设置页右栏诊断面板：一键生成脱敏诊断报告。
 * 保留文本响应处理；超时与失败文案走 pickErrorText / 固定文案，成败均有 message 提示。
 */
import { useState } from "react";
import { App, Button, Space } from "antd";
import { fetchBlob, fetchText } from "../../lib/api.js";

interface DiagnosticsCenterProps {
  /** 页面级危险操作进行中时禁用入口。 */
  actionBusy: boolean;
}

interface DiagnosticState {
  busy: boolean;
  text: string | null;
  error: string | null;
}

const OFFLINE_TEXT = "管家服务暂时连不上，请稍后再试。";

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
    message.success("脱敏诊断包已下载，可以直接附到 Issue。 ");
  };

  return (
    <div className="settings-subsection diagnostic-tool-panel">
      <div className="settings-section-head is-compact">
        <div>
          <span className="product-kicker">诊断报告</span>
          <h2>一键生成诊断报告</h2>
        </div>
      </div>
      <p className="hint">
        打包脱敏的日志问题、错误指纹、巡检快照和配置摘要；不含密钥和聊天正文。
      </p>
      <div className="backup-actions">
        <Button
          type="primary"
          loading={diagnostic.busy}
          disabled={actionBusy || diagnostic.busy}
          onClick={() => void runDiagnostic()}
        >
          生成诊断报告
        </Button>
      </div>
      {diagnostic.error !== null && (
        <p className="diagnostic-error hint" role="status">
          {diagnostic.error}
        </p>
      )}
      {diagnostic.text !== null && (
        <details className="advanced-details settings-advanced" open>
          <summary>查看报告（可下载）</summary>
          <div className="advanced-details-body">
            <pre className="diagnostic-preview">{diagnostic.text}</pre>
            <Space wrap>
              <Button onClick={() => downloadDiagnostic(diagnostic.text!)}>下载 Markdown</Button>
              <Button type="primary" onClick={() => void downloadDiagnosticZip()}>下载诊断 ZIP</Button>
            </Space>
          </div>
        </details>
      )}
    </div>
  );
}
