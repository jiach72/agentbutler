import { Flex } from "antd";
import { PageHeader } from "../components/PageHeader.js";
import { ConclusionBar } from "../components/ConclusionBar.js";
import { LogPanel } from "./dashboard/LogPanel.js";
import "./logs.css";

export function LogsPage() {
  return (
    <section className="logs-page">
      <Flex vertical gap={16}>
        <PageHeader
          title="系统日志"
          description="查看管家与智能体日志，按级别筛选；分析结论与修复建议在下方。"
        />
        <ConclusionBar
          tone="info"
          title="日志实时滚动，分析结论看下方「智能分析」面板"
          copy="分析结论由模型归纳，修复操作都会先确认再执行。"
        />
        <LogPanel embedded />
      </Flex>
    </section>
  );
}
