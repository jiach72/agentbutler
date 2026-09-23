import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeTempDir, makeUiDist, rmTempDir } from "./helpers.js";
import { createWebServer } from "../src/server.js";

describe("本地知识库 (AnythingLLM RAG) API 路由", () => {
  let tempRoot: string;
  let home: string;
  let uiDist: string;
  const apps: FastifyInstance[] = [];

  beforeEach(() => {
    tempRoot = makeTempDir();
    home = tempRoot;
    uiDist = makeUiDist(tempRoot);
  });

  afterEach(async () => {
    for (const app of apps) {
      await app.close();
    }
    apps.length = 0;
    rmTempDir(tempRoot);
  });

  function createApp(): FastifyInstance {
    const app = createWebServer({
      home,
      uiDist,
      fetchImpl: () => Promise.reject(new Error("unreachable in test")),
    });
    apps.push(app);
    return app;
  }

  it("GET /api/knowledge/status 初始状态返回未开启且未运行", async () => {
    const app = createApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/knowledge/status",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      enabled: false,
      running: false,
      vectorDb: "LanceDB (内置嵌入式)",
      volume: "anythingllm-data",
      profile: "rag-anythingllm",
    });
    expect(body.externalUrl).toContain(":3001");
  });

  it("POST /api/knowledge/toggle 支持切换开启并持久化偏好", async () => {
    const app = createApp();

    // 1. 开启
    const toggleOn = await app.inject({
      method: "POST",
      url: "/api/knowledge/toggle",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(toggleOn.statusCode).toBe(200);
    expect(toggleOn.json()).toEqual({ ok: true, enabled: true });

    // 2. 回读状态应反映 enabled: true
    const statusOn = await app.inject({
      method: "GET",
      url: "/api/knowledge/status",
    });
    expect(statusOn.statusCode).toBe(200);
    expect(statusOn.json().enabled).toBe(true);

    // 3. 关闭
    const toggleOff = await app.inject({
      method: "POST",
      url: "/api/knowledge/toggle",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(toggleOff.statusCode).toBe(200);
    expect(toggleOff.json()).toEqual({ ok: true, enabled: false });

    // 4. 回读状态应反映 enabled: false
    const statusOff = await app.inject({
      method: "GET",
      url: "/api/knowledge/status",
    });
    expect(statusOff.statusCode).toBe(200);
    expect(statusOff.json().enabled).toBe(false);
  });

  it("GET /api/knowledge/start-progress 初始状态返回进度结构", async () => {
    const app = createApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/knowledge/start-progress",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("active");
    expect(body).toHaveProperty("stage");
    expect(body).toHaveProperty("percent");
    expect(body).toHaveProperty("logs");
    expect(Array.isArray(body.logs)).toBe(true);
  });

  it("POST /api/knowledge/start 触发容器启动任务并返回启动状态", async () => {
    const app = createApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/knowledge/start",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.progress).toBeDefined();
    expect(body.progress.percent).toBeGreaterThanOrEqual(10);
    expect(body.progress.logs.length).toBeGreaterThan(0);
  });

  it("GET /api/knowledge/embedding-status 返回嵌入模型状态与推荐模型", async () => {
    const app = createApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/knowledge/embedding-status",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("ready");
    expect(body).toHaveProperty("recommended");
    expect(body.recommended).toBe("nomic-embed-text:latest");
  });

  it("支持文档上传、列表查询与删除闭环", async () => {
    const app = createApp();

    // 1. 上传文档
    const uploadRes = await app.inject({
      method: "POST",
      url: "/api/knowledge/upload",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "test-note.md",
        content: "# Test Note\n\n[[TargetDoc]]\n#architect #rag\nContent here.",
      }),
    });
    expect(uploadRes.statusCode).toBe(200);
    expect(uploadRes.json().ok).toBe(true);
    const docId = uploadRes.json().document.id;

    // 2. 查询文档列表
    const listRes = await app.inject({
      method: "GET",
      url: "/api/knowledge/documents",
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().documents.some((d: { id: string }) => d.id === docId)).toBe(true);

    // 3. 删除文档
    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/knowledge/documents/${encodeURIComponent(docId)}`,
    });
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.json().ok).toBe(true);
  });

  it("重复清理必须显式确认，且不能删除扫描标记的主版本", async () => {
    const app = createApp();
    const upload = (filename: string, content: string) =>
      app.inject({
        method: "POST",
        url: "/api/knowledge/upload",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename, content }),
      });

    await upload("primary.md", "identical duplicate content");
    await app.inject({
      method: "POST",
      url: "/api/knowledge/obsidian/upload-vault",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "notes/copy.md", content: "identical duplicate content" }],
      }),
    });

    const scan = await app.inject({ method: "GET", url: "/api/knowledge/dedup/scan" });
    expect(scan.statusCode).toBe(200);
    const group = scan.json().groups.find(
      (item: { reason: string }) => item.reason === "exact_content",
    );
    expect(group).toBeDefined();
    const primaryId = group.items.find((item: { isPrimary: boolean }) => item.isPrimary).id;
    const duplicateId = group.items.find((item: { isPrimary: boolean }) => !item.isPrimary).id;

    const unconfirmed = await app.inject({
      method: "POST",
      url: "/api/knowledge/dedup/clean",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ removeIds: [duplicateId] }),
    });
    expect(unconfirmed.statusCode).toBe(400);

    const primarySelection = await app.inject({
      method: "POST",
      url: "/api/knowledge/dedup/clean",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scanId: scan.json().scanId, confirmed: true, removeIds: [primaryId] }),
    });
    expect(primarySelection.statusCode).toBe(409);

    const unchanged = await app.inject({
      method: "GET",
      url: "/api/knowledge/documents",
    });
    expect(unchanged.json().documents).toHaveLength(2);

    const clean = await app.inject({
      method: "POST",
      url: "/api/knowledge/dedup/clean",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scanId: scan.json().scanId,
        confirmed: true,
        removeIds: [duplicateId],
      }),
    });
    expect(clean.statusCode).toBe(200);
    expect(clean.json()).toMatchObject({ ok: true, removedCount: 1 });

    const remaining = await app.inject({
      method: "GET",
      url: "/api/knowledge/documents",
    });
    expect(remaining.json().documents.map((item: { id: string }) => item.id)).toEqual([
      primaryId,
    ]);
  });

  it("拒绝清理扫描后已不再重复的过期候选", async () => {
    const app = createApp();
    await app.inject({
      method: "POST",
      url: "/api/knowledge/upload",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "stale.md", content: "same content" }),
    });
    await app.inject({
      method: "POST",
      url: "/api/knowledge/obsidian/upload-vault",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "copy.md", content: "same content" }],
      }),
    });
    const scan = await app.inject({ method: "GET", url: "/api/knowledge/dedup/scan" });
    const duplicateId = scan
      .json()
      .groups[0].items.find((item: { isPrimary: boolean }) => !item.isPrimary).id as string;

    await app.inject({
      method: "DELETE",
      url: `/api/knowledge/documents/${encodeURIComponent(duplicateId)}`,
    });
    const staleClean = await app.inject({
      method: "POST",
      url: "/api/knowledge/dedup/clean",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scanId: scan.json().scanId,
        confirmed: true,
        removeIds: [duplicateId],
      }),
    });

    expect(staleClean.statusCode).toBe(409);
  });

  it("同名但内容不同的资料仅作为核对线索，不计为可清理副本", async () => {
    const app = createApp();
    const first = await app.inject({
      method: "POST",
      url: "/api/knowledge/upload",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "project.md", content: "version one" }),
    });
    const firstId = first.json().document.id as string;
    await app.inject({
      method: "POST",
      url: "/api/knowledge/obsidian/upload-vault",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "archive/project.md", content: "version two" }],
      }),
    });

    const scan = await app.inject({ method: "GET", url: "/api/knowledge/dedup/scan" });
    expect(scan.json()).toMatchObject({ duplicateCount: 0, reclaimableBytes: 0 });
    expect(scan.json().groups[0].reason).toBe("same_name_different_path");

    const attemptedClean = await app.inject({
      method: "POST",
      url: "/api/knowledge/dedup/clean",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scanId: scan.json().scanId,
        confirmed: true,
        removeIds: [scan.json().groups[0].items.find((item: { id: string }) => item.id !== firstId).id],
      }),
    });
    expect(attemptedClean.statusCode).toBe(409);

    const documents = await app.inject({ method: "GET", url: "/api/knowledge/documents" });
    expect(documents.json().documents).toHaveLength(2);
  });

  it("支持扫描真实聊天文件并一键归纳入库", async () => {
    const app = createApp();

    // 在 hermes 缓存目录放置一个真实微信文档
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const hermesCache = join(home, "hermes", "cache", "documents");
    mkdirSync(hermesCache, { recursive: true });
    writeFileSync(
      join(hermesCache, "doc_123456789abc_大湾区可行性研究.pdf"),
      "PDF binary mock content",
      "utf8",
    );

    // 1. 查询收件箱列表
    const inboxRes = await app.inject({
      method: "GET",
      url: "/api/knowledge/inbox",
    });
    expect(inboxRes.statusCode).toBe(200);
    const files = inboxRes.json().files;
    expect(files.length).toBeGreaterThan(0);
    expect(files[0].filename).toBe("大湾区可行性研究.pdf");
    expect(files[0].channel).toBe("微信 (WeChat)");

    // 2. 一键入库
    const ingestRes = await app.inject({
      method: "POST",
      url: "/api/knowledge/inbox/ingest",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileIds: [files[0].id] }),
    });
    expect(ingestRes.statusCode).toBe(200);
    expect(ingestRes.json().ok).toBe(true);
    expect(ingestRes.json().ingestedCount).toBe(1);
  });

  it("支持通过 upload-vault 批量上传同步本地文件夹笔记", async () => {
    const app = createApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/knowledge/obsidian/upload-vault",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        files: [
          { path: "Notes/Arch.md", content: "# Architecture\n\n[[SystemDesign]]" },
          { path: "Notes/Plan.md", content: "# Planning\n\n#milestone" },
        ],
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().uploadedCount).toBe(2);
  });

  it("支持在线预览文档内容与原生检索问答", async () => {
    const app = createApp();

    // 先上传一份文档
    const up = await app.inject({
      method: "POST",
      url: "/api/knowledge/upload",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "Report.md",
        content: "# 智算中心研究报告\n\n本项目建设地点位于广州南沙新区，计划于2026年12月投产运营。",
      }),
    });
    const docId = up.json().document.id;

    // 1. 预览
    const prevRes = await app.inject({
      method: "GET",
      url: `/api/knowledge/documents/${encodeURIComponent(docId)}/preview`,
    });
    expect(prevRes.statusCode).toBe(200);
    expect(prevRes.json().ok).toBe(true);
    expect(prevRes.json().content).toContain("广州南沙新区");

    // 2. 知识检索问答
    const queryRes = await app.inject({
      method: "POST",
      url: "/api/knowledge/query",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "建设地点在哪里？" }),
    });
    expect(queryRes.statusCode).toBe(200);
    expect(queryRes.json().ok).toBe(true);
    expect(queryRes.json().citations.length).toBeGreaterThan(0);
    expect(queryRes.json().citations[0].snippet).toContain("广州南沙新区");
  });

  it("GET /api/knowledge/graph 生成知识图谱与星图节点拓扑", async () => {
    const app = createApp();

    // 先创建两个带有关联关系的文档
    await app.inject({
      method: "POST",
      url: "/api/knowledge/upload",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "Alpha.md",
        content: "# Alpha Note\n\n[[Beta]]\n#core",
      }),
    });

    await app.inject({
      method: "POST",
      url: "/api/knowledge/upload",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "Beta.md",
        content: "# Beta Note\n\n#core #security",
      }),
    });

    const graphRes = await app.inject({
      method: "GET",
      url: "/api/knowledge/graph",
    });
    expect(graphRes.statusCode).toBe(200);
    const graph = graphRes.json();
    expect(graph).toHaveProperty("nodes");
    expect(graph).toHaveProperty("links");
    expect(graph).toHaveProperty("stats");
    expect(graph.nodes.length).toBeGreaterThanOrEqual(2);
    expect(graph.stats.totalNodes).toBeGreaterThanOrEqual(2);
  });
});
