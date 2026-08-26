import { afterEach, describe, expect, it, vi } from "vitest";
import { loadJson } from "../src/lib/api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadJson", () => {
  it("成功时返回 data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ value: 42 }), { status: 200 }),
      ),
    );
    const result = await loadJson<{ value: number }>("/api/x");
    expect(result).toEqual({ ok: true, data: { value: 42 } });
  });

  it("非 2xx 提取 error 文案而非吞错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "watch-unreachable" }), { status: 502 }),
      ),
    );
    const result = await loadJson("/api/x");
    expect(result).toEqual({ ok: false, reason: "watch-unreachable" });
  });

  it("传输层失败返回可读原因", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    const result = await loadJson("/api/x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("网络连接失败");
  });
});
