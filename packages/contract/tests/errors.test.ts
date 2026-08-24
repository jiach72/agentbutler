import { describe, expect, it } from "vitest";
import {
  CONTRACT_VERSION,
  ERROR_TABLE,
  isContractVersionSupported,
  isRetryable,
  KERNEL_SUPPORTED_CONTRACT_RANGE,
  type ErrorCode,
} from "../src/errors";

const ALL_CODES: ErrorCode[] = [
  "E001",
  "E002",
  "E101",
  "E102",
  "E103",
  "E201",
  "E202",
  "E203",
  "E204",
  "E301",
  "E302",
  "E303",
  "E401",
  "E402",
  "E403",
];

const RETRYABLE_CODES = new Set<ErrorCode>(["E101", "E103", "E202", "E302"]);

describe("ERROR_TABLE", () => {
  it("覆盖全部 15 个错误码，条目自洽", () => {
    expect(Object.keys(ERROR_TABLE).sort()).toEqual(ALL_CODES);
    for (const code of ALL_CODES) {
      const entry = ERROR_TABLE[code];
      expect(entry.code).toBe(code);
      expect(entry.name.length).toBeGreaterThan(0);
      expect(typeof entry.retryable).toBe("boolean");
    }
  });

  it("可重试映射：仅 E101/E103/E202/E302 可重试", () => {
    for (const code of ALL_CODES) {
      expect(isRetryable(code)).toBe(RETRYABLE_CODES.has(code));
      expect(isRetryable(code)).toBe(ERROR_TABLE[code].retryable);
    }
  });

  it("错误码符号名与契约一致", () => {
    expect(ERROR_TABLE.E001.name).toBe("CONTRACT_VERSION");
    expect(ERROR_TABLE.E002.name).toBe("INVALID_ARGS");
    expect(ERROR_TABLE.E101.name).toBe("FRAMEWORK_NOT_FOUND");
    expect(ERROR_TABLE.E102.name).toBe("AMBIGUOUS_INSTANCE");
    expect(ERROR_TABLE.E103.name).toBe("SCAN_FAILED");
    expect(ERROR_TABLE.E201.name).toBe("CONTROL_NOT_DECLARED");
    expect(ERROR_TABLE.E202.name).toBe("CONTROL_TIMEOUT");
    expect(ERROR_TABLE.E203.name).toBe("CONTROL_REJECTED");
    expect(ERROR_TABLE.E204.name).toBe("SNAPSHOT_CONFLICT");
    expect(ERROR_TABLE.E301.name).toBe("MESSAGING_NOT_DECLARED");
    expect(ERROR_TABLE.E302.name).toBe("ENDPOINT_UNREACHABLE");
    expect(ERROR_TABLE.E303.name).toBe("AUTH_FAILED");
    expect(ERROR_TABLE.E401.name).toBe("DRIVER_NOT_REGISTERED");
    expect(ERROR_TABLE.E402.name).toBe("FORMAT_UNRECOGNIZED");
    expect(ERROR_TABLE.E403.name).toBe("READ_ONLY");
  });
});

describe("契约版本区间", () => {
  it("CONTRACT_VERSION 为 1.0，内核区间为 1.x", () => {
    expect(CONTRACT_VERSION).toBe("1.0");
    expect(KERNEL_SUPPORTED_CONTRACT_RANGE).toEqual(["1.x"]);
  });

  it("isContractVersionSupported：1.x 支持，2.x 不支持", () => {
    expect(isContractVersionSupported("1.x")).toBe(true);
    expect(isContractVersionSupported("1.0")).toBe(true);
    expect(isContractVersionSupported("1")).toBe(true);
    expect(isContractVersionSupported("2.x")).toBe(false);
    expect(isContractVersionSupported("0.9")).toBe(false);
    expect(isContractVersionSupported("")).toBe(false);
    expect(isContractVersionSupported("abc")).toBe(false);
  });
});
