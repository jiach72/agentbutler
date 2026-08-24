import { describe, expect, it } from "vitest";
import type { StoredEvent } from "@butler/core";
import { recentEventsAscending, selectNewEvents } from "../src/events-pump";

const ev = (id: number): StoredEvent => ({
  id,
  ts: `2026-01-01T00:00:${String(id).padStart(2, "0")}Z`,
  type: `type-${id}`,
  severity: "info",
  source: "test",
  payload: null,
});

describe("events-pump 纯函数", () => {
  it("recentEventsAscending：取前 limit 条并翻转为 id 升序（首推批次）", () => {
    // listEvents 语义：最新在前
    const desc = [ev(5), ev(4), ev(3), ev(2), ev(1)];
    expect(recentEventsAscending(desc, 3).map((e) => e.id)).toEqual([3, 4, 5]);
    expect(recentEventsAscending(desc, 50).map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
    expect(recentEventsAscending([], 50)).toEqual([]);
  });

  it("selectNewEvents：只保留 id > lastId 并按 id 升序（增量批次）", () => {
    const desc = [ev(5), ev(3), ev(1)];
    expect(selectNewEvents(desc, 0).map((e) => e.id)).toEqual([1, 3, 5]);
    expect(selectNewEvents(desc, 3).map((e) => e.id)).toEqual([5]);
  });

  it("selectNewEvents：无新事件时返回空数组", () => {
    expect(selectNewEvents([ev(2), ev(1)], 2)).toEqual([]);
    expect(selectNewEvents([], 0)).toEqual([]);
  });
});
