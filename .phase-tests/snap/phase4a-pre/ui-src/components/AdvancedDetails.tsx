/**
 * 高级详情折叠区：专业字段默认收起，替代裸 <details>。
 * antd Collapse 自带展开态指示，修复此前「展开」文案不随状态更新的缺陷。
 *
 * 规范依据 docs/brand/03 §3.11：
 *   · 默认收起，标题固定为「高级详情 · <摘要>」；
 *   · **展开状态按页面记忆（localStorage）** —— 同一个 P3 用户反复展开同一块，
 *     不该每次进来都要再点一次。
 *   · 里面保留专业术语（Runbook、holdout、baseline、P0/P1、cursor、outbox），
 *     这是给 P3 用户看的，不做术语降维。
 */
import { Collapse } from "antd";
import type { CollapseProps } from "antd";
import { useEffect, useState } from "react";

const STORAGE_PREFIX = "butler.advanced-details.";

/** localStorage 可能被隐私模式拒绝，读写一律包 try/catch 并退化为不记忆。 */
function readStored(key: string): boolean | null {
  try {
    const value = window.localStorage.getItem(STORAGE_PREFIX + key);
    return value === null ? null : value === "1";
  } catch {
    return null;
  }
}

function writeStored(key: string, open: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, open ? "1" : "0");
  } catch {
    /* 存储不可用时静默退化为不记忆 */
  }
}

interface AdvancedDetailsProps {
  /** 折叠条标题，如「巡检明细」「修复方案」。 */
  summary: React.ReactNode;
  children: React.ReactNode;
  defaultActive?: boolean;
  /** 折叠条右侧附加信息（如计数）。 */
  extra?: React.ReactNode;
  /**
   * 记忆键。缺省时若 summary 是字符串则用 summary ——
   * 同一个页面上多块同名的「高级详情」应显式传不同的 key。
   */
  storageKey?: string;
}

export function AdvancedDetails({
  summary,
  children,
  defaultActive = false,
  extra,
  storageKey,
}: AdvancedDetailsProps) {
  const key =
    storageKey ?? (typeof summary === "string" ? summary : null);
  const [active, setActive] = useState<boolean>(defaultActive);

  // 挂载后读取记忆值（不能在首帧读：SSR/静态渲染时没有 window）。
  useEffect(() => {
    if (key === null) return;
    const stored = readStored(key);
    if (stored !== null) setActive(stored);
  }, [key]);

  const items: CollapseProps["items"] = [
    {
      key: "panel",
      label: (
        <span className="advanced-details-summary">
          <span>高级详情 · {summary}</span>
          {extra !== undefined && <span className="advanced-details-extra">{extra}</span>}
        </span>
      ),
      children,
    },
  ];

  return (
    <Collapse
      className="advanced-details"
      size="small"
      activeKey={active ? ["panel"] : []}
      onChange={(keys) => {
        const open = Array.isArray(keys) ? keys.includes("panel") : keys === "panel";
        setActive(open);
        if (key !== null) writeStored(key, open);
      }}
      items={items}
    />
  );
}
