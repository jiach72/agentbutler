/**
 * 统一空态：三件套 —— 一句结论 + 一句怎么做 + 一个按钮。
 *
 * 规范依据 docs/brand/03 §3.9：
 *   · 一句结论（说清"还没有什么"，不是"暂无数据"四个字了事）
 *   · 一句怎么做（怎么做能产生它；说不出为什么没有也算合格）
 *   · 一个按钮（可选的下一步）
 *   · 插画用 §2.6 的品牌角色（管家机器人），不用演示数据。
 *
 * 禁用：演示数据、占屏大插画、"暂无数据"。
 */
import { BrandMascot } from "./BrandMascot.js";

interface EmptyProps {
  /** 一句结论，如「还没有备份」。 */
  title: React.ReactNode;
  /** 一句怎么做，如「升级或回滚前，管家会自动做一次」。 */
  hint?: React.ReactNode;
  /** 一个按钮（可选）。 */
  action?: React.ReactNode;
  /** 是否显示品牌角色。规范禁"占屏大插画"，所以默认只在有空间的场合开。 */
  mascot?: boolean;
  /** 品牌角色宽度。规范 §2.6 分档：空状态 96–160px。 */
  mascotWidth?: number;
  className?: string;
}

export function Empty({
  title,
  hint,
  action,
  mascot = true,
  mascotWidth = 96,
  className,
}: EmptyProps) {
  return (
    <div className={className ? `empty-state ${className}` : "empty-state"}>
      {mascot && <BrandMascot width={mascotWidth} />}
      <p className="empty-state-title">{title}</p>
      {hint !== undefined && <p className="empty-state-hint">{hint}</p>}
      {action !== undefined && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
