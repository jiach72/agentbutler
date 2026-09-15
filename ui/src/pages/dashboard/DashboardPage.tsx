import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { App, Button, Collapse, Skeleton } from "antd";
import { DashboardOutlined, ReloadOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { postJson } from "../../lib/api.js";
import { PageHeader } from "../../components/PageHeader.js";
import { AttentionList, TaskPreview } from "./HealthOverview.js";
import { capabilityLabel } from "./userHealth.js";
import { useUserHealthData } from "./useUserHealthData.js";
import "./dashboard.css";

interface RuntimeDetailsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/** Retained for existing consumers; operational controls live in expert views. */
export function RuntimeDetails({ open, onOpenChange, children }: RuntimeDetailsProps) {
  return <div id="runtime-details"><Collapse
    className="advanced-details runtime-details"
    activeKey={open ? ["runtime"] : []}
    onChange={(keys) => onOpenChange(Array.isArray(keys) && keys.includes("runtime"))}
    items={[{ key: "runtime", label: "运行详情", children }]}
  /></div>;
}

export function DashboardPage() {
  const data = useUserHealthData();
  const { message } = App.useApp();
  const [inspecting, setInspecting] = useState(false);
  const inspect = async () => {
    setInspecting(true);
    try {
      const result = await postJson("/api/inspect/run");
      if (result.status === 202) { message.success("已开始检查，结果会自动更新"); await data.refresh(); }
      else if (result.status === 409) message.info("检查正在进行中");
      else message.error("暂时无法开始检查，请检查管家连接");
    } finally { setInspecting(false); }
  };
  const { health, input, onlineInstances, totalInstances } = data;
  const messageState = input.messages?.connected === true
    && input.messages.failed === 0 && input.messages.unknown === 0 ? "可用"
    : input.messages?.connected === false ? "连接中断"
      : (input.messages?.failed ?? 0) + (input.messages?.unknown ?? 0) > 0 ? "需核对投递" : "待确认";
  return (
    <section className="dashboard-page dashboard-simple">
      <PageHeader title="首页" extra={<Link className="health-wall-link" to="/wall"><DashboardOutlined />大屏模式</Link>} />
      {data.loading ? <Skeleton active paragraph={{ rows: 4 }} /> : <>
        <section className="health-conclusion" data-status={health.status} aria-labelledby="health-headline">
          <div><h2 id="health-headline">{health.headline}</h2><p>{health.explanation}</p></div>
          <Button icon={<SafetyCertificateOutlined />} loading={inspecting} onClick={() => { void inspect(); }}>立即检查</Button>
        </section>
        <div className="health-main">
          <section className="health-issues" aria-labelledby="health-attention-title">
            <div className="health-section-heading"><h2 id="health-attention-title">需要处理 <span>{health.attention.length}</span></h2><Button icon={<ReloadOutlined />} loading={data.refreshing} onClick={() => { void data.refresh(); }}>刷新</Button></div>
            <AttentionList attention={health.attention} />
          </section>
          <TaskPreview tasks={data.tasks} />
        </div>
        <section aria-labelledby="health-capabilities-title" className="health-capabilities">
          <h2 id="health-capabilities-title">核心能力</h2>
          <dl className="health-capability-list">
            <div><dt><Link to="/setup">智能体</Link></dt><dd>{totalInstances === null ? "待确认" : `${onlineInstances}/${totalInstances} 在线`}</dd></div>
            <div><dt><Link to="/gateway">消息</Link></dt><dd>{messageState}</dd></div>
            <div><dt><Link to="/setup">模型</Link></dt><dd>{capabilityLabel(input.model)}</dd></div>
            <div><dt><Link to="/skills?tab=memory">记忆</Link></dt><dd>{capabilityLabel(input.memory)}</dd></div>
          </dl>
        </section>
      </>}
    </section>
  );
}
