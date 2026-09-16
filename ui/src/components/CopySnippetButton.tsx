/**
 * 形态流转复制按钮（Morphing Copy Button）：
 * 点击前展示复制图标与文字，点击后原地平滑过渡为打勾与浅绿高光微晕，
 * 2 秒后自动平滑复原。省去跳出全局 Toast 的视觉打扰。
 */
import { useState, useCallback } from "react";
import { CheckOutlined, CopyOutlined } from "@ant-design/icons";

export interface CopySnippetButtonProps {
  /** 待复制的文本内容，或返回文本的函数/异步函数 */
  text: string | (() => string | Promise<string>);
  /** 未复制时的文字，默认"复制" */
  label?: string;
  /** 复制成功后的文字，默认"已复制" */
  copiedLabel?: string;
  /** 复制成功后的可选回调 */
  onCopied?: () => void;
  className?: string;
}

export function CopySnippetButton({
  text,
  label = "复制",
  copiedLabel = "已复制",
  onCopied,
  className,
}: CopySnippetButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      const content = typeof text === "function" ? await text() : text;
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(content);
      }
      setCopied(true);
      onCopied?.();
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 降级兜底
    }
  }, [text, onCopied]);

  return (
    <button
      type="button"
      className={`ab-btn-copy${copied ? " is-copied" : ""}${className ? ` ${className}` : ""}`}
      onClick={() => void handleCopy()}
      aria-label={copied ? copiedLabel : label}
    >
      {copied ? (
        <CheckOutlined style={{ color: "var(--ab-success)", fontSize: 12 }} />
      ) : (
        <CopyOutlined style={{ fontSize: 12 }} />
      )}
      <span>{copied ? copiedLabel : label}</span>
    </button>
  );
}
