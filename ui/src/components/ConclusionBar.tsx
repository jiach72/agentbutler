/**
 * 通用结论条（品牌规范 §2.3 第二段"结论条"）。
 *
 * 一屏每个区块上限 1 个主按钮：本组件的 `action` 是页面内**唯一**被允许的 primary
 * 位置（其他 secondary 操作以 `extra` 数组传入）。
 *
 * tone 推断规则（与 `<StatusBadge>` / `<Tag>` 同源）：
 *   - ok      → 已正常可用
 *   - warn    → 需要关注
 *   - error   → 已阻塞
 *   - info    → 工具性陈述（不是错误、但需要看一眼）
 *   - offline → 后端不可达
 *   - unknown → 数据加载中、状态尚未确定
 *
 * @example
 * <ConclusionBar
 *   tone="warn"
 *   title="当前版本 1.4 落后推荐 1.6"
 *   copy="已下载 1.6 包，零停机升级预计 30 秒。"
 *   action={<Button type="primary" onClick={onUpgrade}>立即升级</Button>}
 *   extra={
 *     <>
 *       <a href="/docs/changelog">查看更新说明</a>
 *       <span>下次计划：凌晨 03:00</span>
 *     </>
 *   }
 * />
 */
import { Alert, Flex } from "antd";
import type { ReactNode } from "react";

export type ConclusionTone = "ok" | "warn" | "error" | "info" | "offline" | "unknown";

const TONE_TO_ALERT_TYPE: Record<ConclusionTone, "success" | "info" | "warning" | "error"> = {
  ok: "success",
  info: "info",
  warn: "warning",
  error: "error",
  /** offline/unknown 用 info：表达"中性陈述"，避免 antd 红/黄加粗误导用户。 */
  offline: "info",
  unknown: "info",
};

interface ConclusionBarProps {
  tone: ConclusionTone;
  /** 一句话结论（3 秒可读："现在好不好、要不要点一下"）。 */
  title: ReactNode;
  /** 一句补充说明（可省略）。 */
  copy?: ReactNode;
  /** 唯一主操作（按钮形态由调用方控制：本组件不强制 type="primary"）。 */
  action?: ReactNode;
  /** 元信息条（多段以 divider 分隔；放在 Alert 下方一行的次级位）。 */
  extra?: ReactNode;
}

/**
 * 页面级结论条的视图模型：`ConclusionBar` 的 props 与它结构一致。
 *
 * 页面把「结论该说什么」建成一个对象再展开，而不是在 JSX 里堆三元表达式——
 * 分支（加载中 / 读不到 / 离线 / 有异常 / 正常）在数据层就穷举完，渲染层只管展示（评审 P0-2）。
 */
export type PageConclusionView = ConclusionBarProps;

export function ConclusionBar({ tone, title, copy, action, extra }: ConclusionBarProps) {
  return (
    <Flex vertical gap={12}>
      <Alert
        type={TONE_TO_ALERT_TYPE[tone]}
        showIcon
        title={title}
        description={copy}
        action={action ? <Flex gap={8}>{action}</Flex> : undefined}
      />
      {extra ? (
        <Flex wrap="wrap" align="center" gap={8}>
          {extra}
        </Flex>
      ) : null}
    </Flex>
  );
}
