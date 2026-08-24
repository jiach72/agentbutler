/**
 * llm-probe 测试：端点探测 + 1 token 补全 + 余额 note 语义。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLlmProbeStage, LLM_PROBE_NOT_CONFIGURED_NOTE } from "../src/probes/llm-probe.js";
import type { FetchLike, ResponseLike } from "../src/dashboard-signal.js";
import type { InspectionContext } from "../src/pipeline.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "watch-llmprobe-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function ctxOf(): InspectionContext {
  return { instanceId: "hermes-main", frameworkId: "hermes", rootPath: tmp, runtime: "process", shared: {} };
}

interface FetchRecord {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function recorder(handler: (record: FetchRecord) => Partial<ResponseLike> | Promise<Partial<ResponseLike>>): {
  fetchFn: FetchLike;
  calls: FetchRecord[];
} {
  const calls: FetchRecord[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const record: FetchRecord = { url, method: init?.method, headers: init?.headers, body: init?.body };
    calls.push(record);
    const partial = await handler(record);
    return { ok: true, status: 200, json: async () => ({}), ...partial } as ResponseLike;
  };
  return { fetchFn, calls };
}

describe("llm-probe（LLM 端点）", () => {
  it("端点探测 + 1 token 补全成功 → pass（POST body/auth 正确）", async () => {
    const { fetchFn, calls } = recorder(() => ({ ok: true, status: 200 }));
    const result = await createLlmProbeStage({
      env: { baseUrl: "http://llm.local/v1/", apiKey: "sk-llm", model: "test-model" },
      fetchFn,
    }).run(ctxOf());

    expect(result.status).toBe("pass");
    expect(result.detail).toContain("http://llm.local/v1"); // 尾斜杠归一
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ url: "http://llm.local/v1", method: "GET" });

    expect(calls[1]!.url).toBe("http://llm.local/v1/chat/completions");
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.headers!["authorization"]).toBe("Bearer sk-llm");
    const body = JSON.parse(calls[1]!.body!) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      max_tokens: number;
    };
    expect(body.model).toBe("test-model");
    expect(body.messages).toEqual([{ role: "user", content: "ping" }]);
    expect(body.max_tokens).toBe(1);
  });

  it("端点探测：GET base 有响应即视为可达（404 也继续补全）", async () => {
    const { fetchFn, calls } = recorder((record) =>
      record.method === "GET" ? { ok: false, status: 404 } : { ok: true, status: 200 },
    );
    const result = await createLlmProbeStage({
      env: { baseUrl: "http://llm.local/v1" },
      fetchFn,
    }).run(ctxOf());
    expect(result.status).toBe("pass");
    expect(calls).toHaveLength(2);
  });

  it("端点不可达（GET 异常）→ fail 不再发补全", async () => {
    const calls: FetchRecord[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, method: init?.method });
      throw new Error("connect ETIMEDOUT");
    };
    const result = await createLlmProbeStage({
      env: { baseUrl: "http://llm.local/v1" },
      fetchFn,
    }).run(ctxOf());
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("不可达");
    expect(result.detail).toContain("ETIMEDOUT");
    expect(calls).toHaveLength(1);
  });

  it("补全请求响应非 2xx → fail", async () => {
    const { fetchFn } = recorder((record) =>
      record.method === "POST" ? { ok: false, status: 500 } : { ok: true, status: 200 },
    );
    const result = await createLlmProbeStage({
      env: { baseUrl: "http://llm.local/v1", model: "m" },
      fetchFn,
    }).run(ctxOf());
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("补全请求失败");
    expect(result.detail).toContain("500");
  });

  it("未配置 BASE_URL → skipped（LLM 为可选依赖）", async () => {
    const result = await createLlmProbeStage({ env: {} }).run(ctxOf());
    expect(result.status).toBe("skipped");
    expect(result.detail).toBe(LLM_PROBE_NOT_CONFIGURED_NOTE);
  });

  it("余额查询失败仅记 note 不 fail；成功则无 note", async () => {
    const { fetchFn } = recorder((record) =>
      record.url.includes("/balance") ? { ok: false, status: 503 } : { ok: true, status: 200 },
    );
    const result = await createLlmProbeStage({
      env: { baseUrl: "http://llm.local/v1", balanceUrl: "http://llm.local/balance" },
      fetchFn,
    }).run(ctxOf());
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("余额查询");
    expect(result.detail).toContain("503");
  });

  it("余额查询成功 → pass 且无余额 note", async () => {
    const { fetchFn } = recorder(() => ({ ok: true, status: 200 }));
    const result = await createLlmProbeStage({
      env: { baseUrl: "http://llm.local/v1", balanceUrl: "http://llm.local/balance" },
      fetchFn,
    }).run(ctxOf());
    expect(result.status).toBe("pass");
    expect(result.detail).not.toContain("余额查询");
  });
});
