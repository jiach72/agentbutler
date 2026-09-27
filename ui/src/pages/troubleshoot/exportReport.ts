/**
 * 导出脱敏诊断报告。
 *
 * 用户自己修不好时，总得有个东西能发给别人。这份报告由后端生成，
 * 已经剔除密钥、聊天正文和原始日志样本，可以直接贴到 Issue 里。
 */
import { useState } from "react";
import { App } from "antd";
import { fetchText } from "../../lib/api.js";
import { downloadBlob } from "../../lib/download.js";

export function useExportReport() {
  const { message } = App.useApp();
  const [copying, setCopying] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const copyReport = async (): Promise<boolean> => {
    setCopying(true);
    try {
      const result = await fetchText("/api/diagnostics/report", 30_000);
      if (!result.ok) {
        message.error(`未能生成诊断报告：${result.reason}`);
        return false;
      }
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(result.text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = result.text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      message.success("脱敏诊断报告已复制到剪贴板，可直接粘贴求助");
      return true;
    } catch {
      message.error("复制失败，请尝试直接点击「下载诊断报告」");
      return false;
    } finally {
      setCopying(false);
    }
  };

  const exportReport = async (): Promise<void> => {
    setDownloading(true);
    try {
      const result = await fetchText("/api/diagnostics/report", 30_000);
      if (!result.ok) {
        message.error(`报告没有生成：${result.reason}`);
        return;
      }
      const blob = new Blob([result.text], { type: "text/markdown;charset=utf-8" });
      downloadBlob(blob, `agent-butler-diagnostic-${new Date().toISOString().slice(0, 10)}.md`);
      message.success("诊断报告已下载，可以把它贴到 Issue 里求助。");
    } finally {
      setDownloading(false);
    }
  };

  return { exportReport, copyReport, copying, downloading };
}
