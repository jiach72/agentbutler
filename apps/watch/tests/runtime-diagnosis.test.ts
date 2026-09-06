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
    expect(result.summary).toContain("当前运行正常");
  });

  it("classifies a missing token as non-retryable", () => {
    const result = classifyRuntimeState([{ id: "auth", status: "fail", detail: "gateway token missing" }]);
    expect(result.stateCode).toBe("auth_missing");
    expect(result.safeToRetry).toBe(false);
    expect(result.evidence[0]?.source).toBe("auth");
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
