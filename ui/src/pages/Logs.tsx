import { Flex } from "antd";
import { PageHeader } from "../components/PageHeader.js";
import { LogPanel } from "./dashboard/LogPanel.js";

export function LogsPage() {
  return (
    <section className="logs-page">
      <Flex vertical gap={24}>
        <PageHeader
          eyebrow="系统日志"
          title="日志与修复建议"
          description="只读查看 Hermes、网关和管家日志；修复动作会先确认，再显示实时执行进度。"
        />
        <LogPanel embedded />
      </Flex>
    </section>
  );
}
