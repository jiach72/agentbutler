/**
 * 降级横幅：服务不可达 / 数据降级的唯一视觉出口（antd Alert），
 * severity 三级语义对齐 PRODUCT.md「同一套颜色与文案」要求。
 */
import { Alert } from "antd";

export type DegradedSeverity = "info" | "warn" | "critical";

const ALERT_TYPE = {
  info: "info",
  warn: "warning",
  critical: "error",
} as const;

interface DegradedBannerProps {
  severity: DegradedSeverity;
  message: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}

export function DegradedBanner({ severity, message, description, action }: DegradedBannerProps) {
  return (
    <Alert
      banner
      showIcon
      type={ALERT_TYPE[severity]}
      title={message}
      description={description}
      action={action}
      role="status"
    />
  );
}
