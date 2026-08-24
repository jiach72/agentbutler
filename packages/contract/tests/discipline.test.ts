import { describe, expect, it } from "vitest";
import { CALL_DISCIPLINE, getDiscipline } from "../src/discipline";

describe("CALL_DISCIPLINE 纪律表", () => {
  it("五个类别齐全且取值符合契约", () => {
    expect(Object.keys(CALL_DISCIPLINE).sort()).toEqual(
      ["control", "long-op", "messaging", "probe", "read-only"].sort(),
    );
    expect(CALL_DISCIPLINE["read-only"]).toMatchObject({
      timeoutMs: 10_000,
      maxAutoRetries: 2,
      idempotent: true,
    });
    expect(CALL_DISCIPLINE.probe).toMatchObject({ timeoutMs: 30_000, maxAutoRetries: 0 });
    expect(CALL_DISCIPLINE.control).toMatchObject({
      timeoutMs: 120_000,
      maxAutoRetries: 0,
      idempotent: true,
    });
    expect(CALL_DISCIPLINE["long-op"]).toMatchObject({
      timeoutMs: 1_800_000,
      maxAutoRetries: 0,
      idempotent: true,
    });
    expect(CALL_DISCIPLINE.messaging).toMatchObject({ timeoutMs: 5_000, maxAutoRetries: 1 });
  });
});

describe("getDiscipline(methodName)", () => {
  it("只读探测：10s、最多 2 次自动重试、天然幂等", () => {
    for (const m of ["detect", "stats", "enumerate", "capabilityScan", "logSources", "preview", "parse"]) {
      expect(getDiscipline(m).timeoutMs, m).toBe(10_000);
      expect(getDiscipline(m).maxAutoRetries, m).toBe(2);
      expect(getDiscipline(m).idempotent, m).toBe(true);
    }
  });

  it("探针：30s、不自动重试", () => {
    for (const m of ["verifyIntegrity", "prewarm", "prewarmChannel"]) {
      expect(getDiscipline(m).timeoutMs, m).toBe(30_000);
      expect(getDiscipline(m).maxAutoRetries, m).toBe(0);
    }
  });

  it("常规控制：120s、不自动重试、必须幂等", () => {
    for (const m of ["start", "stop", "restart", "validateConfig"]) {
      expect(getDiscipline(m).timeoutMs, m).toBe(120_000);
      expect(getDiscipline(m).maxAutoRetries, m).toBe(0);
      expect(getDiscipline(m).idempotent, m).toBe(true);
    }
  });

  it("长操作：1800s、不自动重试、幂等（idempotencyKey）", () => {
    for (const m of ["upgrade", "rollback", "snapshot", "rollbackVersion", "archiveCold", "planMigration"]) {
      expect(getDiscipline(m).timeoutMs, m).toBe(1_800_000);
      expect(getDiscipline(m).maxAutoRetries, m).toBe(0);
      expect(getDiscipline(m).idempotent, m).toBe(true);
    }
  });

  it("消息转发：5s、最多 1 次自动重试", () => {
    const d = getDiscipline("forwardInbound");
    expect(d.timeoutMs).toBe(5_000);
    expect(d.maxAutoRetries).toBe(1);
    expect(d.idempotent).toBe(true);
  });

  it("未知方法回落 read-only 纪律", () => {
    const d = getDiscipline("totally-unknown");
    expect(d.category).toBe("read-only");
    expect(d.timeoutMs).toBe(10_000);
  });
});
