/**
 * channel-probe 测试：dry-run 配置路径（POST payload / Bearer / 探针会话标识）
 * 与静态检查降级路径（weixin 声明 + 端口探活）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HermesConfig } from "@butler/adapter-hermes";
import { CHANNEL_PROBE_STATIC_NOTE, createChannelProbeStage } from "../src/probes/channel-probe.js";
import type { FetchInitLike, FetchLike } from "../src/dashboard-signal.js";
import type { InspectionContext } from "../src/pipeline.js";

let tmp: string;
const NOW = 1_800_000_000_000;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "watch-chanprobe-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function ctxOf(): InspectionContext {
  return { instanceId: "hermes-main", frameworkId: "hermes", rootPath: tmp, runtime: "process", shared: {} };
}

function configOf(overrides: Partial<HermesConfig> = {}): HermesConfig {
  return {
    apiServer: { host: "127.0.0.1", port: 8642, key: "sk-test" },
    weixinExtra: { min_send_interval_seconds: 1 },
    hasDashboard: false,
    ...overrides,
  };
}

describe("channel-probe（通道收发 dry-run）", () => {
  it("配置 dry-run → POST 正确 payload（探针专用会话标识 + Bearer），响应 2xx → pass", async () => {
    const calls: Array<{ url: string; init?: FetchInitLike }> = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 201, json: async () => ({}) };
    };
    const result = await createChannelProbeStage({
      dryRun: { endpointTemplate: "http://127.0.0.1:8642/api/sessions" },
      fetchFn,
      configLoader: async () => configOf(),
      now: () => NOW,
    }).run(ctxOf());

    expect(result.status).toBe("pass");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8642/api/sessions");
    expect(calls[0]!.init?.method).toBe("POST");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sk-test");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(calls[0]!.init!.body!) as { id: string; source: string };
    expect(body.id).toBe(`butler-probe-${NOW}`); // 探针专用会话标识，绝不进用户会话流
    expect(body.source).toBe("butler-probe");
    // 密钥只进请求头，绝不进 detail。
    expect(result.detail).not.toContain("sk-test");
    expect(result.detail).toContain(`butler-probe-${NOW}`);
  });

  it("dry-run 模板占位渲染：{{probeSession}} / {{ts}}", async () => {
    const calls: Array<{ url: string; init?: FetchInitLike }> = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const result = await createChannelProbeStage({
      dryRun: {
        endpointTemplate: "http://gw.example/api/sessions/{{probeSession}}/chat",
        payloadTemplate: '{"session":"{{probeSession}}","ts":{{ts}}}',
      },
      fetchFn,
      configLoader: async () => configOf({ apiServer: { host: "127.0.0.1", port: 8642, key: null } }),
      now: () => NOW,
    }).run(ctxOf());

    expect(result.status).toBe("pass");
    expect(calls[0]!.url).toBe(`http://gw.example/api/sessions/butler-probe-${NOW}/chat`);
    expect(calls[0]!.init?.body).toBe(`{"session":"butler-probe-${NOW}","ts":${NOW}}`);
  });

  it("dry-run 响应非 2xx → fail", async () => {
    const fetchFn: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const result = await createChannelProbeStage({
      dryRun: { endpointTemplate: "http://127.0.0.1:8642/api/sessions" },
      fetchFn,
      configLoader: async () => configOf(),
      now: () => NOW,
    }).run(ctxOf());
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("HTTP 500");
  });

  it("dry-run 网络异常 → fail", async () => {
    const fetchFn: FetchLike = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const result = await createChannelProbeStage({
      dryRun: { endpointTemplate: "http://127.0.0.1:8642/api/sessions" },
      fetchFn,
      configLoader: async () => configOf(),
      now: () => NOW,
    }).run(ctxOf());
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("dry-run 发送异常");
    expect(result.detail).toContain("ECONNREFUSED");
  });

  it("未配置 dry-run + weixin 已声明 + 端口活 → 静态检查 pass with note", async () => {
    const probeCalls: Array<{ host: string; port: number }> = [];
    const result = await createChannelProbeStage({
      fetchFn: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      prober: async (host, port) => {
        probeCalls.push({ host, port });
        return true;
      },
      configLoader: async () => configOf(),
    }).run(ctxOf());

    expect(result.status).toBe("pass");
    expect(result.detail).toContain(CHANNEL_PROBE_STATIC_NOTE);
    expect(result.detail).toContain("127.0.0.1:8642");
    expect(probeCalls).toEqual([{ host: "127.0.0.1", port: 8642 }]);
  });

  it("未配置 dry-run + weixin 已声明 + 端口不活 → fail", async () => {
    const result = await createChannelProbeStage({
      prober: async () => false,
      configLoader: async () => configOf(),
    }).run(ctxOf());
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("端口不活");
  });

  it("未配置 dry-run + config 未声明 weixin → skipped", async () => {
    const result = await createChannelProbeStage({
      configLoader: async () => configOf({ weixinExtra: null }),
    }).run(ctxOf());
    expect(result.status).toBe("skipped");
    expect(result.detail).toContain("platforms.weixin");
  });
});
