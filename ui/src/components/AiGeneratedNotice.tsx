/**
 * AI 生成内容标识条。
 *
 * 规范依据 docs/brand/03 §1 P3「真实即边界」：
 *   自进化建议、日志分析结论、模型给出的优化方案，**一律带来源标记**
 *   （"由模型生成 · 未经人工确认"），不能和管家实测结论混在同一视觉层级。
 *
 * 视觉上刻意克制：黄铜（品牌记忆色）+ 发丝线，不用状态色 ——
 * 它表达的是"来源"，不是"好坏"（§1.1：信号色只表达状态）。
 * 不带图标、不闪烁，避免抢走结论条的注意力（§P4 静默优先）。
 */
interface AiGeneratedNoticeProps {
  /** 补充说明，例如"请自行判断后再采纳"。 */
  detail?: React.ReactNode;
  /** 紧凑模式：用于卡片内部，不撑高。 */
  compact?: boolean;
}

export function AiGeneratedNotice({ detail, compact = false }: AiGeneratedNoticeProps) {
  return (
    <p className={compact ? "ai-notice is-compact" : "ai-notice"}>
      <span className="ai-notice-mark">由模型生成</span>
      <span className="ai-notice-text">
        未经人工确认
        {detail !== undefined && (
          <>
            {" · "}
            {detail}
          </>
        )}
      </span>
    </p>
  );
}
