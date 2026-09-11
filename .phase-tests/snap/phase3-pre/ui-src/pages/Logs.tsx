import { Flex } from "antd";
import { PageHeader } from "../components/PageHeader.js";
import { LogPanel } from "./dashboard/LogPanel.js";
import "./logs.css";

export function LogsPage() {
  return (
    <section className="logs-page">
      <Flex vertical gap={16}>
        <PageHeader
          eyebrow="维护与升级"
          title="系统日志"
          description="查看管家与智能体日志，按级别筛选；分析结论与修复建议在下方。"
        />
        <LogPanel embedded />
      </Flex>
    </section>
  );
}
