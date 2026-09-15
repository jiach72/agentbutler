import { describe, expect, it } from "vitest";
import { classifyRuntimeState } from "../src/runtime-diagnosis.js";
import { parsePortProxyOutput } from "../src/runtime.js";

describe("classifyRuntimeState", () => {
  it("does not turn warnings into a root cause when probes are healthy", () => {
    const result = classifyRuntimeState([
      { id: "connection", status: "pass", detail: "消息通道正常" },
      { id: "logs", status: "warn", detail: "最近一天发现 1 类提醒" },
    ]);
    expect(result.stateCode).toBe("healthy");
    expect(result.severity).toBe("warn");
    expect(result.summary).toContain("运行检查已通过");
  });

  it("classifies a missing token as non-retryable", () => {
    const result = classifyRuntimeState([{ id: "auth", status: "fail", detail: "gateway token missing" }]);
    expect(result.stateCode).toBe("auth_missing");
    expect(result.safeToRetry).toBe(false);
    expect(result.evidence[0]?.source).toBe("auth");
    expect(result.summary).not.toContain("gateway token");
    expect(result.summary).toContain("访问凭据");
  });

  it("does not report healthy when no runtime checks are available", () => {
    const result = classifyRuntimeState([]);
    expect(result.stateCode).toBe("unknown");
    expect(result.severity).toBe("unknown");
    expect(result.safeToRetry).toBe(false);
  });

  it("keeps raw paths and internal errors in evidence, not the user conclusion", () => {
    const result = classifyRuntimeState([{ id: "config", status: "fail", detail: "config JSON /home/user/private.json invalid" }]);
    expect(result.summary).not.toContain("/home");
    expect(result.summary).not.toContain("JSON");
    expect(result.evidence[0]?.message).toContain("/home/user/private.json");
  });
});

describe("parsePortProxyOutput", () => {
  it("从不同语言表头中提取 IPv4 portproxy 规则", () => {
    const rules = parsePortProxyOutput(`
Listen on ipv4:             Connect to ipv4:
Address         Port        Address         Port
--------------- ----------  --------------- ----------
127.0.0.1       7531        172.26.64.1    7531
0.0.0.0         8755        127.0.0.1      8754
`);

    expect(rules).toEqual([
      { listenAddress: "127.0.0.1", listenPort: 7531, connectAddress: "172.26.64.1", connectPort: 7531 },
      { listenAddress: "0.0.0.0", listenPort: 8755, connectAddress: "127.0.0.1", connectPort: 8754 },
    ]);
  });

  it("忽略 IPv6、空行与不完整记录", () => {
    expect(parsePortProxyOutput("::1 7531 172.26.64.1 7531\n127.0.0.1 7531 172.26.64.1")).toEqual([]);
  });
});
