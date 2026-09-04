import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCore, type Core, type FingerprintAggregatedPayload, type FingerprintEscalatedPayload } from "@butler/core";
import { ALERT_FORWARD_FAILED_ACTION, describeFingerprint, startAlertForwarder, type AlertForwardBody } from "../src/alert-forward.js";
import type { FetchInitLike, FetchLike } from "../src/dashboard-signal.js";

let tmp: string;
let core: Core;
let posts: Array<{ url: string; init?: FetchInitLike }>;
let fetchImpl: FetchLike;
let failFetch: boolean;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "watch-alert-"));
  core = createCore({ home: tmp });
  posts = [];
  failFetch = false;
  fetchImpl = async (url, init) => {
    posts.push({ url, init });
    if (failFetch) throw new Error("gateway down");
    return { ok: true, status: 202, json: async () => ({ id: posts.length }) };
  };
});

afterEach(() => {
  core.close();
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function aggregatedPayload(overrides: Partial<FingerprintAggregatedPayload> = {}): FingerprintAggregatedPayload {
  return {
    instanceId: "hermes-main",
    signature: "abc123def4567890",
    template: "Connection to <PATH> refused",
    windowStart: "2026-08-20T10:00:00.000Z",
    count: 3,
    isFirstEver: true,
    escalated: false,
    alert: true,
    sample: "raw line",
    ...overrides,
  };
}

describe("startAlertForwarder", () => {
  it("fingerprint-aggregated alert=true → POST 正确 body 与 dedupeKey", async () => {
    const forwarder = startAlertForwarder({ bus: core.bus, audit: core.audit, gatewayUrl: "http://127.0.0.1:7532", fetchFn: fetchImpl });
    core.bus.emit("fingerprint-aggregated", aggregatedPayload());
    await forwarder.flush();

    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("http://127.0.0.1:7532/api/alerts");
    expect(posts[0]!.init?.method).toBe("POST");
    const body = JSON.parse(posts[0]!.init!.body!) as AlertForwardBody;
    expect(body).toMatchObject({
      kind: "fingerprint",
      severity: "warn",
      source: "butler-watch",
      dedupeKey: "abc123def4567890",
    });
    expect(body.title).toBe("外部服务连接失败");
    expect(body.title).not.toContain("<PATH>");
    expect(body.body).toContain("abc123def4567890");
    expect(body.body).toContain("3 条");
    expect(body.body).toContain("2026-08-20T10:00:00.000Z");
    forwarder.stop();
  });

  it("alert=false（已知模式复现）→ 不转发", async () => {
    const forwarder = startAlertForwarder({ bus: core.bus, audit: core.audit, gatewayUrl: "http://gw", fetchFn: fetchImpl });
    core.bus.emit("fingerprint-aggregated", aggregatedPayload({ alert: false, isFirstEver: false }));
    await forwarder.flush();
    expect(posts).toHaveLength(0);
    forwarder.stop();
  });

  it("fingerprint-escalated → severity critical 且 body 含窗口对比", async () => {
    const forwarder = startAlertForwarder({ bus: core.bus, audit: core.audit, gatewayUrl: "http://gw", fetchFn: fetchImpl });
    const payload: FingerprintEscalatedPayload = {
      instanceId: "hermes-main",
      signature: "sig-escalate",
      template: "Timeout after <NUM>ms waiting upstream",
      prevCount: 3,
      count: 12,
    };
    core.bus.emit("fingerprint-escalated", payload);
    await forwarder.flush();

    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0]!.init!.body!) as AlertForwardBody;
    expect(body.severity).toBe("critical");
    expect(body.dedupeKey).toBe("sig-escalate");
    expect(body.body).toContain("12 条");
    expect(body.body).toContain("3 条");
    forwarder.stop();
  });

  it("内部指纹模板只用于归类，通知标题使用可读摘要", () => {
    expect(describeFingerprint("HTTP 402 Insufficient Balance")).toEqual({
      title: "模型账户余额不足",
      advice: expect.stringContaining("重启服务无法解决"),
    });
    expect(describeFingerprint("Timeout after <NUM>ms").title).toBe("外部服务响应超时");
    expect(describeFingerprint("x".repeat(120)).title).toBe("智能体任务执行失败");
  });

  it("fetch 失败 → 不崩溃且 audit 记录 alert-forward-failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    failFetch = true;
    const forwarder = startAlertForwarder({ bus: core.bus, audit: core.audit, gatewayUrl: "http://gw", fetchFn: fetchImpl });
    core.bus.emit("fingerprint-aggregated", aggregatedPayload());
    await forwarder.flush();

    expect(warn).toHaveBeenCalled();
    const audits = core.audit.list({ action: ALERT_FORWARD_FAILED_ACTION });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor).toBe("butler-watch");
    expect(audits[0]!.target).toBe("abc123def4567890");
    forwarder.stop();
  });

  it("gateway 响应非 2xx → 同样记录 audit 失败", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const forwarder = startAlertForwarder({
      bus: core.bus,
      audit: core.audit,
      gatewayUrl: "http://gw",
      fetchFn: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    core.bus.emit("fingerprint-aggregated", aggregatedPayload());
    await forwarder.flush();
    expect(core.audit.list({ action: ALERT_FORWARD_FAILED_ACTION })).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    forwarder.stop();
  });

  it("stop 后退订，不再转发", async () => {
    const forwarder = startAlertForwarder({ bus: core.bus, audit: core.audit, gatewayUrl: "http://gw", fetchFn: fetchImpl });
    forwarder.stop();
    core.bus.emit("fingerprint-aggregated", aggregatedPayload());
    await forwarder.flush();
    expect(posts).toHaveLength(0);
  });
});
