/**
 * 事件推送纯函数（Task 9）：从"最新在前"的事件列表派生 WebSocket 推送批次。
 *
 * 抽成纯函数是为了让 /ws 的轮询增量逻辑可以脱离真实 WebSocket
 * 连接与 SQLite 做单测（见 tests/events-pump.test.ts）。
 */
import type { StoredEvent } from "@butler/core";

/**
 * 首推批次：取列表前 limit 条（listEvents 最新在前，即"最近 limit 条"），
 * 翻转为 id 升序返回，方便面板按时间顺序追加渲染。
 */
export function recentEventsAscending(events: StoredEvent[], limit: number): StoredEvent[] {
  return events.slice(0, limit).reverse();
}

/** 增量批次：筛选 id > lastId 的事件并按 id 升序排列；空数组表示无新事件。 */
export function selectNewEvents(events: StoredEvent[], lastId: number): StoredEvent[] {
  return events
    .filter((e) => e.id > lastId)
    .sort((a, b) => a.id - b.id);
}
