/**
 * 顶栏告警条：每 10s 轮询 /api/alerts，收敛成一条“需要处理 / 需要留意”汇总条。
 * - 未送达 critical、发送失败或网关不可达 → 红色汇总条（附“去消息通知”入口）；
 * - 已送达 critical 或 warn 级提醒 → 黄色汇总条。
 * 未配置备用通知方式不是故障，不在全局提醒中展示。
 * 拉取失败（null）时不渲染 —— 服务端降级载荷已覆盖有意义的降级场景。
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchJson } from "../lib/api.js";
import { usePolling } from "../hooks/usePolling.js";

interface AlertsPayload {
  reachable: boolean;
  counts?: Record<string, number>;
  items?: Array<{ severity?: string; status?: string; title?: string }>;
}

/** 未送达状态集合：待投递 / 投递中 / 失败均视为"未送达"。 */
const UNDELIVERED = new Set(["pending", "delivering", "failed"]);

export function AlertBanner() {
  const [alerts, setAlerts] = useState<AlertsPayload | null>(null);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      const data = await fetchJson<AlertsPayload>("/api/alerts");
      if (!stopped && data !== null) setAlerts(data);
    };
    void tick();
    return () => {
      stopped = true;
    };
  }, []);
  usePolling(() => {
    void (async () => {
      const data = await fetchJson<AlertsPayload>("/api/alerts");
      if (data !== null) setAlerts(data);
    })();
  }, 10000);

  if (alerts === null) return null;

  const items = alerts.items ?? [];
  const undeliveredCritical = items.filter(
    (item) => item.severity === "critical" && UNDELIVERED.has(String(item.status ?? "")),
  );
  const deliveredCritical = items.filter(
    (item) => item.severity === "critical" && item.status === "delivered",
  );
  const warningItems = items.filter((item) => item.severity === "warn");
  const failedCount = alerts.counts?.["failed"] ?? 0;

  const hasError = !alerts.reachable || undeliveredCritical.length > 0 || failedCount > 0;
  const hasWarn = deliveredCritical.length > 0 || warningItems.length > 0;

  if (!hasError && !hasWarn) return null;

  const parts: string[] = [];
  if (hasError) {
    if (!alerts.reachable) parts.push("通知服务暂时连不上，提醒不会丢");
    if (undeliveredCritical.length > 0) parts.push(`${undeliveredCritical.length} 条紧急提醒还没送到`);
    if (failedCount > 0) parts.push(`${failedCount} 条提醒发送失败`);
    if (parts.length === 0) parts.push("有提醒需要处理");
  } else {
    if (deliveredCritical.length > 0) parts.push(`${deliveredCritical.length} 条紧急提醒已送到面板`);
    if (warningItems.length > 0) parts.push(`${warningItems.length} 条提醒需要留意`);
    if (parts.length === 0) parts.push("有提醒需要留意");
  }

  return (
    <div
      className={`banner ${hasError ? "banner-critical" : "banner-warn"} alert-banner-summary`}
      role="status"
    >
      <span>
        {hasError ? "需要处理" : "需要留意"}：{parts.join("，")}
      </span>
      <Link to="/gateway">去消息通知 →</Link>
    </div>
  );
}
