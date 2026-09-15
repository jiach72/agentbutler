import { Button, Flex } from "antd";
import { AdvancedEvidence } from "../components/AdvancedEvidence.js";
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
        />
        <ConclusionBar
          tone="info"
          title="日志记录不等于当前故障"
          copy="先检查当前影响与修复建议；历史日志只用于核实原因。"
          action={<Button href="/troubleshoot">排查当前问题</Button>}
        />
        <AdvancedEvidence title="原始日志与分析记录"><LogPanel embedded /></AdvancedEvidence>
      </Flex>
    </section>
  );
}
