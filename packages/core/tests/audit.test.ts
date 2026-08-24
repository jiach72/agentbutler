import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditLog } from "../src/audit";
import { EventBus } from "../src/events";
import { SqliteStore } from "../src/store";
import { makeTempDir, rmTempDir } from "./helpers";

describe("AuditLog", () => {
  let tmp: string;
  let store: SqliteStore;
  let bus: EventBus;
  let audit: AuditLog;

  beforeEach(() => {
    tmp = makeTempDir();
    store = new SqliteStore(path.join(tmp, "butler.db"));
    bus = new EventBus();
    audit = new AuditLog({ store, bus });
  });

  afterEach(() => {
    store.close();
    rmTempDir(tmp);
  });

  it("append 增查回程一致（含 detail JSON）", () => {
    const row = audit.append({ actor: "watchdog", action: "restart", target: "ins-1", detail: { attempt: 2 } });
    expect(row.id).toBeGreaterThan(0);
    expect(row.ts).toBeTruthy();

    const list = audit.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ actor: "watchdog", action: "restart", target: "ins-1" });
    expect(list[0]!.detail).toEqual({ attempt: 2 });
  });

  it("每次 append 广播 audit-appended 事件", () => {
    const handler = vi.fn();
    bus.on("audit-appended", handler);

    const first = audit.append({ actor: "a", action: "start", target: "ins-1" });
    const second = audit.append({ actor: "b", action: "stop", target: "ins-1" });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0]![0].payload).toEqual({
      id: first.id,
      actor: "a",
      action: "start",
      target: "ins-1",
    });
    expect(handler.mock.calls[1]![0].payload.id).toBe(second.id);
    expect(second.id).toBeGreaterThan(first.id);
  });

  it("list 支持 action/target/limit 过滤", () => {
    audit.append({ actor: "k", action: "start", target: "ins-1" });
    audit.append({ actor: "k", action: "stop", target: "ins-1" });
    audit.append({ actor: "k", action: "start", target: "ins-2" });

    expect(audit.list({ action: "start" })).toHaveLength(2);
    expect(audit.list({ target: "ins-1" })).toHaveLength(2);
    expect(audit.list({ action: "start", target: "ins-2" })).toHaveLength(1);
    expect(audit.list({ limit: 2 })).toHaveLength(2);
  });

  it("只增不改：不提供 update/delete 能力", () => {
    const methods = Object.getOwnPropertyNames(AuditLog.prototype);
    expect(methods).toContain("append");
    expect(methods).toContain("list");
    expect(methods.filter((m) => /update|delete|remove|patch/i.test(m))).toEqual([]);
  });
});
