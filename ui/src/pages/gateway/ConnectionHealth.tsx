/**
 * 连接健康概览：四张状态摘要卡片（接管状态 / 等待发送 / 常用路径 / 送达结果）。
 */
import { CheckCircleOutlined, WarningOutlined } from "@ant-design/icons";
import { Card, Statistic } from "antd";
import { COVERAGE_LABELS } from "./helpers.js";
import type { MessageBridgeView } from "./helpers.js";

interface ConnectionHealthProps {
  messageBridge: MessageBridgeView | null;
  bridgeReady: boolean;
  messageCounts: Record<string, number>;
}

const ACTIVE_STATES = [
  "captured",
  "policy_pending",
  "held_dnd",
  "held_pacing",
  "ready",
  "delivering",
  "retry_wait",
];
const EXCEPTION_STATES = ["delivery_unknown", "policy_error", "dead_letter"];

export function ConnectionHealth({ messageBridge, bridgeReady, messageCounts }: ConnectionHealthProps) {
  const coverageEntries = Object.entries(messageBridge?.coverage ?? {}).filter(
    ([path]) => COVERAGE_LABELS[path] !== undefined,
  );
  const coverageOk = coverageEntries.filter(([, status]) => status === "ok").length;
  const activeMessages = ACTIVE_STATES.reduce(
    (total, state) => total + (messageCounts[state] ?? 0),
    0,
  );
  const exceptionMessages = EXCEPTION_STATES.reduce(
    (total, state) => total + (messageCounts[state] ?? 0),
    0,
  );

  return (
    <div className="gateway-overview" aria-label="消息通知状态摘要">
      <Card size="small">
        <Statistic
          title="消息管理"
          value={bridgeReady ? "已接管" : messageBridge === null ? "正在读取" : "未就绪"}
          prefix={bridgeReady ? <CheckCircleOutlined /> : <WarningOutlined />}
        />
        <span>管家会自动发现并接管本机 AI 的消息</span>
      </Card>
      <Card size="small">
        <Statistic title="等待发送" value={activeMessages} suffix="条" />
        <span>{messageBridge?.outboxWritable === true ? "队列可写入" : "等待连接恢复"}</span>
      </Card>
      <Card size="small">
        <Statistic
          title="常用路径"
          value={coverageEntries.length === 0 ? "—" : `${coverageOk}/${coverageEntries.length}`}
        />
        <span>
          {coverageEntries.length === 12 && coverageOk === 12 ? "常用路径已验证" : "按最新消息记录显示"}
        </span>
      </Card>
      <Card size="small">
        <Statistic title="送达结果" value={messageCounts["delivered"] ?? 0} suffix="条" />
        <span>已送达 · {exceptionMessages} 条需关注</span>
      </Card>
    </div>
  );
}
