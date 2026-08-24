import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LogSource } from "@butler/contract";
import { EventBus, type FingerprintAggregatedPayload, type FingerprintEscalatedPayload } from "../src/events";
import { FingerprintEngine, normalizeErrorLine } from "../src/fingerprint";
import { SqliteStore } from "../src/store";
import { makeTempDir, rmTempDir } from "./helpers";

const TEXT_SOURCE: LogSource = { id: "hermes-log", path: "/tmp/hermes.log", format: "text" };
const JSONL_SOURCE: LogSource = { id: "jsonl-log", path: "/tmp/x.jsonl", format: "jsonl" };

/** Hermes 风格错误行：仅时间戳/路径/数值变化，模板相同。 */
function hermesErrorLine(i: number, minute = 11): string {
  return `[2026-08-19 21:0${minute}:12] ERROR cannot import name 'cli_output' from '/home/u/dir${i}/hermes_cli/cli_output.py' (attempt ${i})`;
}

const T0 = "2026-08-19T21:00:00Z";

describe("FingerprintEngine", () => {
  let tmp: string;
  let store: SqliteStore;
  let bus: EventBus;
  let aggregated: FingerprintAggregatedPayload[];
  let escalated: FingerprintEscalatedPayload[];
  let engine: FingerprintEngine;

  beforeEach(() => {
    tmp = makeTempDir();
    store = new SqliteStore(path.join(tmp, "data", "butler.db"));
    bus = new EventBus();
    aggregated = [];
    escalated = [];
    bus.on("fingerprint-aggregated", (e) => aggregated.push(e.payload));
    bus.on("fingerprint-escalated", (e) => escalated.push(e.payload));
    engine = new FingerprintEngine({ store, bus });
  });

  afterEach(() => {
    engine.close();
    store.close();
    rmTempDir(tmp);
  });

  it("60 条同模板错误聚合为 1 个 fingerprint-aggregated 事件，count=60", () => {
    for (let i = 0; i < 60; i++) {
      engine.ingest({ source: TEXT_SOURCE, raw: hermesErrorLine(i), ts: T0 }, "hermes-main");
    }
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0]!.count).toBe(1); // 窗口开启时 count 恒为 1
    expect(aggregated[0]!.instanceId).toBe("hermes-main");
    expect(aggregated[0]!.isFirstEver).toBe(true);
    expect(aggregated[0]!.alert).toBe(true);
    expect(escalated).toHaveLength(0); // 无上一窗口，不升级

    const row = store.findFingerprint(aggregated[0]!.signature)!;
    expect(row.count).toBe(60);
    expect(row.status).toBe("open"); // 活跃窗口期间保持 open
    expect(row.lastSample).toBe(aggregated[0]!.template); // 归一化模板作为 sample
    expect(row.instance).toBe("hermes-main"); // 影响组件归属
  });

  it("归一化稳定性：不同路径/数字/时间戳得到相同模板与签名", () => {
    const a = "[2026-08-19 21:04:11] ERROR cannot import name 'cli_output' from '/home/u/aaa/cli.py' (attempt 3)";
    const b = "[2027-01-02 08:30:59] ERROR cannot import name 'cli_output' from 'c:\\Users\\jiach\\Agent Butler\\pkg\\cli.py' (attempt 47)";
    expect(normalizeErrorLine(a)).toBe(normalizeErrorLine(b));
    expect(normalizeErrorLine(a)).toBe(
      "[<TS>] ERROR cannot import name 'cli_output' from '<PATH>' (attempt <NUM>)",
    );

    engine.ingest({ source: TEXT_SOURCE, raw: a, ts: T0 });
    engine.ingest({ source: TEXT_SOURCE, raw: b, ts: T0 });
    expect(aggregated).toHaveLength(1); // 同签名只开一个窗口
    expect(store.listFingerprints()).toHaveLength(1);
    expect(store.listFingerprints()[0]!.count).toBe(2);
  });

  it("跨 5 分钟窗口：两个窗口两条聚合事件，旧窗口关闭写入 fingerprint_windows", () => {
    engine.ingest({ source: TEXT_SOURCE, raw: hermesErrorLine(1), ts: T0 });
    engine.ingest({ source: TEXT_SOURCE, raw: hermesErrorLine(2), ts: "2026-08-19T21:06:00Z" }); // 超窗
    engine.ingest({ source: TEXT_SOURCE, raw: hermesErrorLine(3), ts: "2026-08-19T21:07:00Z" }); // 新窗内

    expect(aggregated).toHaveLength(2);
    expect(aggregated[0]!.signature).toBe(aggregated[1]!.signature);
    expect(aggregated[0]!.windowStart).toBe("2026-08-19T21:00:00.000Z");
    expect(aggregated[1]!.windowStart).toBe("2026-08-19T21:06:00.000Z");

    const windows = store.listFingerprintWindows({ signature: aggregated[0]!.signature });
    expect(windows).toHaveLength(1); // 仅第一窗已关闭
    expect(windows[0]!.count).toBe(1);
    expect(windows[0]!.endedAt).not.toBeNull();

    engine.close();
    expect(store.listFingerprintWindows({ signature: aggregated[0]!.signature })).toHaveLength(2);
    expect(store.findFingerprint(aggregated[0]!.signature)!.status).toBe("known");
  });

  it("告警语义：新签名 alert=true；已知签名复现 alert=false 只记档，状态流转 open→known→open", () => {
    engine.ingest({ source: TEXT_SOURCE, raw: hermesErrorLine(1), ts: T0 });
    expect(aggregated[0]!.alert).toBe(true);
    expect(aggregated[0]!.isFirstEver).toBe(true);
    engine.close();
    expect(store.findFingerprint(aggregated[0]!.signature)!.status).toBe("known");

    engine.ingest({ source: TEXT_SOURCE, raw: hermesErrorLine(2), ts: "2026-08-19T21:30:00Z" }); // 已知自愈复现
    expect(aggregated).toHaveLength(2);
    expect(aggregated[1]!.alert).toBe(false);
    expect(aggregated[1]!.isFirstEver).toBe(false);
    expect(store.findFingerprint(aggregated[1]!.signature)!.status).toBe("open"); // 活跃窗口回到 open
  });

  it("升级趋势：上窗 5 条、本窗涨到 11 条 → fingerprint-escalated 恰好一次", () => {
    const sig = (() => {
      for (let i = 0; i < 5; i++) engine.ingest({ source: TEXT_SOURCE, raw: hermesErrorLine(i), ts: T0 });
      expect(escalated).toHaveLength(0);
      return aggregated[0]!.signature;
    })();

    for (let i = 5; i < 5 + 11; i++) {
      engine.ingest({ source: TEXT_SOURCE, raw: hermesErrorLine(i), ts: "2026-08-19T21:10:00Z" });
    }
    expect(escalated).toHaveLength(1);
    expect(escalated[0]!.prevCount).toBe(5);
    expect(escalated[0]!.count).toBe(11); // 首次超过 2×5 的那一条
    expect(escalated[0]!.signature).toBe(sig);
    expect(aggregated).toHaveLength(2); // 每窗仍只有一条聚合事件

    // 本窗继续涨不再重复升级
    engine.ingest({ source: TEXT_SOURCE, raw: hermesErrorLine(99), ts: "2026-08-19T21:11:00Z" });
    expect(escalated).toHaveLength(1);
  });

  it("close() 冲刷未关闭窗口写入 fingerprint_windows", () => {
    engine.ingest({ source: TEXT_SOURCE, raw: hermesErrorLine(1), ts: T0 });
    engine.ingest({ source: TEXT_SOURCE, raw: hermesErrorLine(2), ts: T0 });
    engine.ingest({ source: TEXT_SOURCE, raw: hermesErrorLine(3), ts: T0 });
    expect(store.listFingerprintWindows()).toHaveLength(0);

    engine.close();
    const windows = store.listFingerprintWindows();
    expect(windows).toHaveLength(1);
    expect(windows[0]!.count).toBe(3);
    expect(windows[0]!.endedAt).not.toBeNull();
    expect(store.findFingerprint(windows[0]!.signature)!.status).toBe("known");
  });

  it("错误行过滤：text 按关键词、jsonl 按 level/severity，非错误行不产生指纹", () => {
    engine.ingest({ source: TEXT_SOURCE, raw: "INFO request served in 12ms", ts: T0 });
    engine.ingest({ source: TEXT_SOURCE, raw: "DEBUG checkpoint ok", ts: T0 });
    expect(store.listFingerprints()).toHaveLength(0);

    engine.ingest({ source: TEXT_SOURCE, raw: "npm warn Unknown env config 'x'", ts: T0 }); // warn 关键词
    expect(store.listFingerprints()).toHaveLength(1);

    engine.ingest({ source: JSONL_SOURCE, raw: JSON.stringify({ level: "info", msg: "fine" }), ts: T0 });
    engine.ingest({ source: JSONL_SOURCE, raw: JSON.stringify({ severity: "fatal", msg: "dead" }), ts: T0 });
    engine.ingest({ source: JSONL_SOURCE, raw: JSON.stringify({ level: "error", msg: "bad" }), ts: T0 });
    expect(store.listFingerprints()).toHaveLength(3); // info 被过滤，warn/fatal/error 各一签名
    expect(store.listFingerprints().reduce((n, f) => n + f.count, 0)).toBe(3);
  });

  it("总线事件经 onAny 落 events 表持久化（模拟 createCore 接线）", () => {
    bus.onAny((event) =>
      store.insertEvent({ type: event.type, severity: "info", source: "fingerprint", payload: event.payload }),
    );
    engine.ingest({ source: TEXT_SOURCE, raw: hermesErrorLine(1), ts: T0 });
    for (let i = 0; i < 5; i++) {
      engine.ingest({ source: TEXT_SOURCE, raw: hermesErrorLine(i + 10), ts: "2026-08-19T21:20:00Z" });
    }

    const persisted = store.listEvents({ type: "fingerprint-aggregated" });
    expect(persisted).toHaveLength(2);
    expect(persisted[0]!.payload).toMatchObject({ count: 1, alert: false });
    expect(store.listEvents({ type: "fingerprint-escalated" })).toHaveLength(0); // 上窗 1 条 < 3，不升级
  });
});
