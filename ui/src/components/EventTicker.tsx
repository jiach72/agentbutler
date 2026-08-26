/**
 * 事件 ticker：订阅共享 /ws 事件流（useEventStream 单连接），
 * 底部常驻条滚动显示最近事件。
 */
import { useEffect, useState } from "react";
import { subscribeEventStream, useEventStreamStatus, type EventFrame } from "../hooks/useEventStream.js";

interface TickerEvent {
  id: number;
  ts: string;
  type: string;
}

/** ticker 最多保留的最近事件条数。 */
const MAX_EVENTS = 20;

function formatTs(ts: string): string {
  return ts.replace("T", " ").replace(/(\.\d+)?Z$/, "");
}

function humanizeEvent(type: string): string {
  if (type.startsWith("inspection-")) return "管家检查";
  if (type.startsWith("runbook-")) return "修复方案";
  if (type.startsWith("fingerprint-")) return "重复问题";
  if (type.startsWith("job-event")) return "版本升级/还原";
  if (type.startsWith("message-")) return "消息记录";
  if (type.startsWith("alert-")) return "通知";
  if (type.startsWith("prompt-")) return "消息优化";
  if (type.startsWith("upgrade-") || type.startsWith("snapshot-")) return "版本变更";
  if (type.startsWith("skill-")) return "技能动态";
  if (type.startsWith("evolution-")) return "改进记录";
  if (type.startsWith("gateway-") || type.startsWith("delivery-") || type.startsWith("dnd-"))
    return "消息处理";
  if (type.startsWith("patch-")) return "消息服务";
  if (type.startsWith("security-") || type.startsWith("service-")) return "服务状态";
  if (type.startsWith("instance-")) return "管家动态";
  return "管家动态";
}

export function EventTicker() {
  const [events, setEvents] = useState<TickerEvent[]>([]);
  const connected = useEventStreamStatus();

  useEffect(
    () =>
      subscribeEventStream((frame: EventFrame) => {
        if (frame.type !== "events" || !Array.isArray(frame.items)) return;
        const items = frame.items as TickerEvent[];
        // 服务端按 id 升序推送，翻转后新的在前，截断保留最近 MAX_EVENTS 条
        setEvents((prev) => [...[...items].reverse(), ...prev].slice(0, MAX_EVENTS));
      }),
    [],
  );

  return (
    <footer className="ticker">
      <span
        className={`ticker-dot${connected ? " on" : ""}`}
        title={connected ? "已连接" : "已断开，5s 后重连"}
      />
      <ul>
        {events.length === 0 && <li className="ticker-empty">等待管家动态…</li>}
        {events.map((event) => (
          <li key={event.id} title={humanizeEvent(event.type)}>
            <span className="ticker-ts">{formatTs(event.ts)}</span> {humanizeEvent(event.type)}
          </li>
        ))}
      </ul>
    </footer>
  );
}
