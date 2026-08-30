/**
 * 导出脱敏诊断报告。
 *
 * 用户自己修不好时，总得有个东西能发给别人。这份报告由后端生成，
 * 已经剔除密钥、聊天正文和原始日志样本，可以直接贴到 Issue 里。
 */
import { App } from "antd";
import { fetchText } from "../../lib/api.js";

export function useExportReport() {
  const { message } = App.useApp();

  const exportReport = async (): Promise<void> => {
    const result = await fetchText("/api/diagnostics/report", 30_000);
    if (!result.ok) {
      message.error(`报告没有生成：${result.reason}`);
      return;
    }
    const blob = new Blob([result.text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `agent-butler-diagnostic-${new Date().toISOString().slice(0, 10)}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
    message.success("诊断报告已下载，可以把它贴到 Issue 里求助。");
  };

  return { exportReport };
}
