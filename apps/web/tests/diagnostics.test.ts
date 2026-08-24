import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createWebServer } from "../src/server";
import { makeTempDir, makeUiDist, rmTempDir } from "./helpers";

const WATCH_URL = "http://127.0.0.1:7533";
const MARKDOWN = "# Agent Butler 诊断报告\n\n## 1. 环境信息\n- 管家版本：1.7.0\n";

describe("butler-web 诊断报告代理", () => {
  let tmp: string;
  let uiDist: string;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    const warmup = Fastify({ logger: false });
    await warmup.close();
  }, 30_000);

  beforeEach(() => {
    tmp = makeTempDir();
    uiDist = makeUiDist(tmp);
  });

  afterEach(async () => {
    for (const app of apps) await app.close();
    apps.length = 0;
    rmTempDir(tmp);
  });

  function build(fetchImpl: typeof fetch): FastifyInstance {
    const app = createWebServer({ home: tmp, uiDist, watchUrl: WATCH_URL, fetchImpl });
    apps.push(app);
    return app;
  }

  it("watch 可达时透传 markdown 与附件头", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      expect(url).toBe(`${WATCH_URL}/api/diagnostics/report`);
      return new Response(MARKDOWN, {
        status: 200,
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": 'attachment; filename="agent-butler-diagnostic-2026082303.md"',
        },
      });
    };
    const app = build(fetchImpl);
    const res = await app.inject({ method: "GET", url: "/api/diagnostics/report" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.headers["content-disposition"]).toContain("agent-butler-diagnostic-2026082303.md");
    expect(res.body).toContain("# Agent Butler 诊断报告");
  });

  it("watch 不可达时返回 502 降级", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("unreachable");
    };
    const app = build(fetchImpl);
    const res = await app.inject({ method: "GET", url: "/api/diagnostics/report" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "watch-unreachable" });
  });
});
