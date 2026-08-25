import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogSource } from "@butler/contract";
import { EventBus } from "../src/events";
import { LogTailer, type TailedBatch } from "../src/tail";
import { SqliteStore } from "../src/store";
import { makeTempDir, rmTempDir } from "./helpers";

describe("LogTailer", () => {
  let tmp: string;
  let store: SqliteStore;
  let bus: EventBus;
  let logFile: string;
  let source: LogSource;

  beforeEach(() => {
    tmp = makeTempDir();
    store = new SqliteStore(path.join(tmp, "data", "butler.db"));
    bus = new EventBus();
    logFile = path.join(tmp, "logs", "hermes.log");
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    source = { id: "hermes-log", path: logFile, format: "text" };
  });

  afterEach(() => {
    store.close();
    rmTempDir(tmp);
  });

  function newTailer(): LogTailer {
    const tailer = new LogTailer({ store, bus });
    tailer.registerSources([source]);
    return tailer;
  }

  async function drain(tailer: LogTailer): Promise<TailedBatch[]> {
    const batches: TailedBatch[] = [];
    await tailer.poll((batch) => {
      batches.push(batch);
    });
    return batches;
  }

  it("追加行后 poll 拿到新行且 offset 推进，重复 poll 不重复", async () => {
    fs.writeFileSync(logFile, "line-1\n");
    let tailer = newTailer();
    let batches = await drain(tailer);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.lines.map((l) => l.raw)).toEqual(["line-1"]);
    expect(batches[0]!.startOffset).toBe(0);
    expect(batches[0]!.endOffset).toBe(7);
    expect(store.getTailPosition("hermes-log")).toBe(7);

    // 已消费内容不再吐出
    expect(await drain(tailer)).toHaveLength(0);

    // 追加后只拿新增行；重启（新实例同 store）位点延续
    fs.appendFileSync(logFile, "line-2\n");
    tailer = newTailer();
    batches = await drain(tailer);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.lines.map((l) => l.raw)).toEqual(["line-2"]);
    expect(batches[0]!.startOffset).toBe(7);
    expect(batches[0]!.endOffset).toBe(14);
  });

  it("handler 抛错时位点不提交，重启后重读不丢（at-least-once）", async () => {
    fs.writeFileSync(logFile, "a\nb\n");
    const tailer = newTailer();
    await expect(
      tailer.poll(() => {
        throw new Error("downstream crash");
      }),
    ).rejects.toThrow("downstream crash");
    expect(store.getTailPosition("hermes-log")).toBeUndefined();

    // 重启（新 LogTailer 实例同 store）：整批重读
    const batches = await drain(newTailer());
    expect(batches).toHaveLength(1);
    expect(batches[0]!.lines.map((l) => l.raw)).toEqual(["a", "b"]);
    expect(store.getTailPosition("hermes-log")).toBe(4);
  });

  it("截断/轮转：文件变短 → 位点重置 0 全量重读并广播 tail-rotated", async () => {
    fs.writeFileSync(logFile, "aaaa\nbbbb\ncccc\n");
    const tailer = newTailer();
    expect(await drain(tailer)).toHaveLength(1);
    expect(store.getTailPosition("hermes-log")).toBe(15);

    const rotated: { sourceId: string; path: string; oldOffset: number }[] = [];
    bus.on("tail-rotated", (e) => rotated.push(e.payload));

    fs.writeFileSync(logFile, "xxxx\n"); // 轮转后新文件更短
    const batches = await drain(tailer);
    expect(rotated).toEqual([{ sourceId: "hermes-log", path: logFile, oldOffset: 15 }]);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.startOffset).toBe(0);
    expect(batches[0]!.lines.map((l) => l.raw)).toEqual(["xxxx"]);
    expect(store.getTailPosition("hermes-log")).toBe(5);
  });

  it("jsonl 格式解析 tsField 提取 ts，text 格式无 ts", async () => {
    fs.writeFileSync(
      logFile,
      [
        JSON.stringify({ ts: "2026-08-19T21:04:11.000Z", level: "error", msg: "boom" }),
        JSON.stringify({ time: "2026-08-19T21:04:12.000Z", level: "error", msg: "bang" }),
        "not-json",
      ].join("\n") + "\n",
    );
    source = { id: "jsonl-log", path: logFile, format: "jsonl", tsField: "ts" };
    const batches = await drain(newTailer());
    const lines = batches[0]!.lines;
    expect(lines).toHaveLength(3);
    expect(lines[0]!.ts).toBe("2026-08-19T21:04:11.000Z");
    expect(lines[1]!.ts).toBeUndefined(); // tsField 不存在的行
    expect(lines[2]!.ts).toBeUndefined(); // 非 JSON 行按 text 透传
  });

  it("末尾无换行的部分行不吐出、位点不越过", async () => {
    fs.writeFileSync(logFile, "complete\npartial");
    const tailer = newTailer();
    const batches = await drain(tailer);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.lines.map((l) => l.raw)).toEqual(["complete"]);
    expect(batches[0]!.endOffset).toBe(9); // 只推进到最后一个完整换行符之后
    expect(store.getTailPosition("hermes-log")).toBe(9);

    // 补全剩余部分后整行吐出
    fs.appendFileSync(logFile, " rest\n");
    const next = await drain(tailer);
    expect(next[0]!.lines.map((l) => l.raw)).toEqual(["partial rest"]);
    expect(store.getTailPosition("hermes-log")).toBe(22);
  });

  it("文件不存在 → 跳过不报错，不影响其他源", async () => {
    const missing: LogSource = { id: "gone", path: path.join(tmp, "nope.log"), format: "text" };
    fs.writeFileSync(logFile, "hello\n");
    const tailer = new LogTailer({ store, bus });
    tailer.registerSources([missing, source]);
    const batches = await drain(tailer);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.source.id).toBe("hermes-log");
    expect(store.getTailPosition("gone")).toBeUndefined();
  });

  it("一个源只有部分行时仍继续处理后续源", async () => {
    const nextFile = path.join(tmp, "logs", "next.log");
    const nextSource: LogSource = { id: "next-log", path: nextFile, format: "text" };
    fs.writeFileSync(logFile, "partial");
    fs.writeFileSync(nextFile, "complete\n");
    const tailer = new LogTailer({ store, bus });
    tailer.registerSources([source, nextSource]);

    const batches = await drain(tailer);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.source.id).toBe("next-log");
    expect(batches[0]!.lines.map((line) => line.raw)).toEqual(["complete"]);
    expect(store.getTailPosition("hermes-log")).toBeUndefined();
  });

  it("大增量读取按固定块分配，不一次性申请整个文件", async () => {
    fs.writeFileSync(logFile, `${"x".repeat(256 * 1024)}\n`);
    const alloc = vi.spyOn(Buffer, "alloc");
    try {
      const batches = await drain(newTailer());
      expect(batches).toHaveLength(1);
      expect(batches[0]!.lines[0]!.raw).toHaveLength(256 * 1024);
      const sizes = alloc.mock.calls.map(([size]) => Number(size));
      expect(Math.max(...sizes)).toBeLessThanOrEqual(64 * 1024);
    } finally {
      alloc.mockRestore();
    }
  });

  it("UTF-8 多字节字符跨读取块边界时保持完整", async () => {
    const raw = `${"x".repeat(64 * 1024 - 1)}界`;
    fs.writeFileSync(logFile, `${raw}\n`);

    const batches = await drain(newTailer());
    expect(batches).toHaveLength(1);
    expect(batches[0]!.lines.map((line) => line.raw)).toEqual([raw]);
  });

  it("超长未换行尾部在后续补全后完整交付", async () => {
    const raw = "x".repeat(128 * 1024);
    fs.writeFileSync(logFile, raw);
    const tailer = newTailer();
    expect(await drain(tailer)).toHaveLength(0);
    expect(store.getTailPosition("hermes-log")).toBeUndefined();

    fs.appendFileSync(logFile, "\n");
    const batches = await drain(tailer);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.lines.map((line) => line.raw)).toEqual([raw]);
    expect(store.getTailPosition("hermes-log")).toBe(Buffer.byteLength(`${raw}\n`));
  });
});
