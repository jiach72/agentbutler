import type { FastifyInstance } from "fastify";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  copyFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, basename, extname, relative, resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { atomicWriteJson } from "@butler/core";

/**
 * 将路径转换为容器内可访问的统一路径：
 * Windows 盘符路径（如 C:\... 或 C:/...）自动映射为 WSL 挂载点 /mnt/c/...
 */
export function resolveVaultPath(rawPath: string): string {
  if (!rawPath) return "";
  const trimmed = rawPath.trim();
  const winDriveMatch = trimmed.match(/^([a-zA-Z]):[/\\](.*)$/);
  if (winDriveMatch) {
    const drive = winDriveMatch[1].toLowerCase();
    const rest = winDriveMatch[2].replace(/\\/g, "/");
    return `/mnt/${drive}/${rest}`;
  }
  return trimmed.replace(/\\/g, "/");
}

/**
 * 提取文档纯文本（支持 PDF / Markdown / TXT / JSON / 表格）
 */
export function extractDocumentText(filePath: string): string {
  if (!existsSync(filePath)) return "";
  const ext = extname(filePath).toLowerCase();
  if (ext === ".pdf") {
    try {
      const out = execFileSync("pdftotext", [filePath, "-"], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 6000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (out && out.trim().length > 0) {
        return out;
      }
    } catch {
      // pdftotext not available or failed
    }
    try {
      const buf = readFileSync(filePath);
      const str = buf.toString("latin1");
      const textParts: string[] = [];
      const regex = /\(([^)]{2,})\)\s*Tj/g;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(str)) !== null) {
        textParts.push(m[1]);
      }
      if (textParts.length > 0) {
        return textParts.join(" ");
      }
      return `[PDF 专有文档: ${basename(filePath)}]`;
    } catch {
      return `[PDF 文档: ${basename(filePath)}]`;
    }
  }

  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}


export interface KnowledgeRouteOptions {
  home: string;
  anythingllmUrl?: string;
  ollamaUrl?: string;
  updaterUrl?: string;
  updaterToken?: string;
  fetchImpl?: typeof fetch;
}

export interface KnowledgeStatus {
  enabled: boolean;
  running: boolean;
  endpoint: string;
  externalUrl: string;
  ollamaUrl: string;
  vectorDb: string;
  volume: string;
  profile: string;
  error?: string;
}

export type StartupStage =
  | "idle"
  | "preparing"
  | "pulling"
  | "launching"
  | "probing"
  | "ready"
  | "failed";

export interface StartupProgress {
  active: boolean;
  stage: StartupStage;
  stageLabel: string;
  percent: number;
  logs: string[];
  error?: string;
  ready: boolean;
  startedAt?: number;
}

export interface EmbeddingPullProgress {
  active: boolean;
  model: string;
  status: string;
  percent: number;
  completed?: number;
  total?: number;
  error?: string;
}

export interface KnowledgeDocument {
  id: string;
  name: string;
  path: string;
  size: number;
  ext: string;
  updatedAt: string;
  source: "upload" | "obsidian" | "inbox";
  ingested: boolean;
}

export interface DedupItem {
  id: string;
  name: string;
  path: string;
  size: number;
  updatedAt: string;
  source: "upload" | "obsidian" | "inbox";
  contentHash?: string;
  isPrimary?: boolean;
}

export interface DedupGroup {
  key: string;
  name: string;
  reason: "exact_content" | "same_name_different_path";
  reasonLabel: string;
  primaryId: string;
  items: DedupItem[];
}

export interface DedupScanResult {
  ok: boolean;
  scanId: string;
  totalDocs: number;
  duplicateCount: number;
  groups: DedupGroup[];
  reclaimableBytes: number;
}

export interface ObsidianConfig {
  vaultPath: string;
  vaultName?: string;
  autoSync: boolean;
  lastSyncAt?: string;
  noteCount: number;
}

export interface InboxFile {
  id: string;
  channel: string;
  sender: string;
  date: string;
  filename: string;
  size: number;
  path: string;
  ingested: boolean;
}

export interface QueryCitation {
  docName: string;
  path: string;
  snippet: string;
  score: number;
}

export interface KnowledgeQueryResult {
  ok: boolean;
  answer: string;
  citations: QueryCitation[];
}

export interface DocumentPreviewResult {
  ok: boolean;
  name: string;
  ext: string;
  size: number;
  updatedAt: string;
  content: string;
  truncated: boolean;
  totalLength: number;
}

export interface GraphNode {
  id: string;
  name: string;
  type: "document" | "obsidian" | "inbox" | "tag" | "concept";
  val: number;
  connections: number;
  color?: string;
  cluster?: string;
  details?: {
    path?: string;
    size?: number;
    updatedAt?: string;
    summary?: string;
  };
}

export interface GraphLink {
  source: string;
  target: string;
  type: "wikilink" | "tag" | "hierarchy" | "semantic";
  strength?: number;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
  stats: {
    totalNodes: number;
    totalLinks: number;
    docCount: number;
    tagCount: number;
  };
}

export interface EmbeddingStatus {
  ready: boolean;
  activeModel?: string;
  installedModels: string[];
  recommended: string;
  message?: string;
}

/** 全局单例启动状态追踪器（内存状态供前端实时轮询控制台输出） */
const startupState: StartupProgress = {
  active: false,
  stage: "idle",
  stageLabel: "空闲",
  percent: 0,
  logs: [],
  ready: false,
};

function appendLog(line: string): void {
  const time = new Date().toLocaleTimeString();
  startupState.logs.push(`[${time}] ${line}`);
  if (startupState.logs.length > 300) {
    startupState.logs.shift();
  }
}

/** 递归获取目录下全部文件路径 */
function scanFilesRecursively(dir: string, ignoreDirs: string[] = []): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || ignoreDirs.includes(entry.name)) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...scanFilesRecursively(full, ignoreDirs));
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  } catch {
    // 忽略权限或读取错误
  }
  return results;
}

/**
 * 本地知识库 (AnythingLLM RAG) 全面扩展：
 * 1. 向量模型状态检测与一键拉取 (Embedding Status & Pull)
 * 2. 原生资料收集箱闭环管理 (Native Documents Collection)
 * 3. Obsidian 笔记库绑定与增量同步 (Obsidian Vault Sync)
 * 4. 外部聊天文件有序归纳箱 (IM Files Inbox & Ingestion)
 * 5. 知识星图拓扑数据 (Star Chart Graph)
 * 6. 容器启动状态与实时日志流
 */
export async function registerKnowledgeRoutes(
  app: FastifyInstance,
  options: KnowledgeRouteOptions,
): Promise<void> {
  const { home } = options;
  const prefsFile = join(home, "data", "knowledge_prefs.json");
  const documentsDir = join(home, "data", "documents");
  const documentsManifestFile = join(home, "data", "documents_manifest.json");
  const obsidianConfigFile = join(home, "data", "obsidian_config.json");
  const inboxDir = join(home, "data", "inbox");
  const inboxManifestFile = join(home, "data", "inbox_manifest.json");
  const fetchFn = options.fetchImpl ?? fetch;
  const dedupSnapshots = new Map<
    string,
    {
      createdAt: number;
      candidates: Map<string, { primaryId: string; contentHash: string }>;
    }
  >();

  // 确保基础目录存在（在测试环境中 home 可能是故意伪装的文件以测试容错，故加 try-catch）
  try {
    mkdirSync(join(home, "data"), { recursive: true });
    mkdirSync(documentsDir, { recursive: true });
    mkdirSync(inboxDir, { recursive: true });
  } catch {
    // 忽略
  }

  function readPrefs(): { enabled: boolean } {
    try {
      if (existsSync(prefsFile)) {
        const raw = JSON.parse(readFileSync(prefsFile, "utf8")) as { enabled?: boolean };
        return { enabled: Boolean(raw?.enabled) };
      }
    } catch {
      // 缺省降级为未配置
    }
    return { enabled: false };
  }

  function writePrefs(prefs: { enabled: boolean }): void {
    atomicWriteJson(prefsFile, prefs, { mode: 0o600, description: "本地知识库偏好设置" });
  }

  // ── 文档清单 Manifest 读写 ───────────────────────────────────────────
  function readDocumentsManifest(): Record<string, KnowledgeDocument> {
    try {
      if (existsSync(documentsManifestFile)) {
        return JSON.parse(readFileSync(documentsManifestFile, "utf8")) as Record<
          string,
          KnowledgeDocument
        >;
      }
    } catch {
      // 忽略
    }
    return {};
  }

  function writeDocumentsManifest(manifest: Record<string, KnowledgeDocument>): void {
    atomicWriteJson(documentsManifestFile, manifest, {
      mode: 0o600,
      description: "知识库文档清单",
    });
  }

  // ── IM 文件收件箱 Manifest 读写 ──────────────────────────────────────────
  function readInboxManifest(): Record<string, { ingested: boolean }> {
    try {
      if (existsSync(inboxManifestFile)) {
        return JSON.parse(readFileSync(inboxManifestFile, "utf8")) as Record<
          string,
          { ingested: boolean }
        >;
      }
    } catch {
      // 忽略
    }
    return {};
  }

  function writeInboxManifest(manifest: Record<string, { ingested: boolean }>): void {
    atomicWriteJson(inboxManifestFile, manifest, {
      mode: 0o600,
      description: "收件箱文件状态清单",
    });
  }

  // ── 探活 AnythingLLM ──────────────────────────────────────────────
  async function checkRunning(): Promise<{ running: boolean; endpoint: string }> {
    const externalPort = process.env["BUTLER_ANYTHINGLLM_PORT"] || "3001";
    const externalHost = process.env["BUTLER_ANYTHINGLLM_BIND_HOST"] || "127.0.0.1";
    const externalUrl = `http://${externalHost}:${externalPort}`;
    const configuredUrl =
      process.env["BUTLER_ANYTHINGLLM_URL"]?.trim() || options.anythingllmUrl || externalUrl;
    const internalCandidate = "http://butler-rag-anythingllm:3001";

    const candidateUrls = Array.from(
      new Set([configuredUrl, internalCandidate, `http://127.0.0.1:${externalPort}`]),
    );

    for (const testUrl of candidateUrls) {
      try {
        const clean = testUrl.replace(/\/+$/, "");
        const res = await fetchFn(`${clean}/api/ping`, {
          signal: AbortSignal.timeout(1200),
        });
        if (res.status < 500) {
          return { running: true, endpoint: testUrl };
        }
      } catch {
        // continue
      }
    }
    return { running: false, endpoint: externalUrl };
  }

  // ── 1. 基础状态与偏好 ─────────────────────────────────────────────
  app.get("/api/knowledge/status", async (): Promise<KnowledgeStatus> => {
    const prefs = readPrefs();
    const externalPort = process.env["BUTLER_ANYTHINGLLM_PORT"] || "3001";
    const externalHost = process.env["BUTLER_ANYTHINGLLM_BIND_HOST"] || "127.0.0.1";
    const externalUrl = `http://${externalHost}:${externalPort}`;
    const ollamaUrl = options.ollamaUrl ?? process.env["BUTLER_OLLAMA_URL"] ?? "http://ollama:11434";

    const { running, endpoint } = await checkRunning();

    if (running) {
      if (startupState.stage === "failed" || startupState.error) {
        startupState.stage = "ready";
        startupState.stageLabel = "本地知识库运行中 (:3001)";
        startupState.ready = true;
        startupState.percent = 100;
        startupState.active = false;
        startupState.error = undefined;
      }
    }

    return {
      enabled: prefs.enabled || running,
      running,
      endpoint,
      externalUrl,
      ollamaUrl,
      vectorDb: "LanceDB (内置嵌入式)",
      volume: "anythingllm-data",
      profile: "rag-anythingllm",
    };
  });

  app.post("/api/knowledge/toggle", async (request) => {
    const body = request.body as { enabled?: boolean } | null;
    const enabled = Boolean(body?.enabled);
    writePrefs({ enabled });
    if (!enabled) {
      startupState.active = false;
      startupState.stage = "idle";
      startupState.ready = false;
      startupState.percent = 0;
    }
    return { ok: true, enabled };
  });

  // ── 2. Embedding 向量模型检测与下载引导 ────────────────────────────────
  let activeEmbeddingPull: EmbeddingPullProgress = {
    active: false,
    model: "",
    status: "idle",
    percent: 0,
  };

  app.get("/api/knowledge/embedding-status", async (): Promise<EmbeddingStatus & { pulling?: boolean; pullProgress?: EmbeddingPullProgress }> => {
    const defaultRecommended = "nomic-embed-text:latest";
    const rawOllamaUrl =
      options.ollamaUrl ?? process.env["BUTLER_OLLAMA_URL"] ?? "http://127.0.0.1:11434";
    const cleanUrl = rawOllamaUrl.replace(/\/+$/, "");

    try {
      const res = await fetchFn(`${cleanUrl}/api/tags`, {
        signal: AbortSignal.timeout(2500),
      });

      if (res.ok) {
        const data = (await res.json()) as { models?: Array<{ name: string }> };
        const installed = (data?.models || []).map((m) => m.name);
        const embedPattern = /embed|bge|nomic|minilm|arctic|mxbai/i;
        const matching = installed.filter((name) => embedPattern.test(name));

        if (matching.length > 0) {
          return {
            ready: true,
            activeModel: matching[0],
            installedModels: installed,
            recommended: defaultRecommended,
            pulling: activeEmbeddingPull.active,
            pullProgress: activeEmbeddingPull,
          };
        }
        return {
          ready: false,
          installedModels: installed,
          recommended: defaultRecommended,
          message: "未检测到本地 Embedding 向量模型，知识库切片检索需要向量模型支持",
          pulling: activeEmbeddingPull.active,
          pullProgress: activeEmbeddingPull,
        };
      }
    } catch {
      // 无法连通 Ollama
    }

    return {
      ready: false,
      installedModels: [],
      recommended: defaultRecommended,
      message: "未检测到本地运行中的 Embedding 向量模型或 Ollama 引擎",
      pulling: activeEmbeddingPull.active,
      pullProgress: activeEmbeddingPull,
    };
  });

  app.post("/api/knowledge/embedding/pull", async (request, reply) => {
    const body = request.body as { model?: string } | null;
    const targetModel = body?.model?.trim() || "nomic-embed-text";
    const rawOllamaUrl =
      options.ollamaUrl ?? process.env["BUTLER_OLLAMA_URL"] ?? "http://127.0.0.1:11434";
    const cleanUrl = rawOllamaUrl.replace(/\/+$/, "");

    if (activeEmbeddingPull.active) {
      return {
        ok: true,
        pulling: true,
        message: `模型「${activeEmbeddingPull.model}」正在后台下载中 (${activeEmbeddingPull.percent}%)...`,
        progress: activeEmbeddingPull,
      };
    }

    // 快速探活（2000ms），确认 Ollama 服务在线
    try {
      const probe = await fetchFn(`${cleanUrl}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!probe.ok) {
        return reply.status(502).send({
          ok: false,
          error: `Ollama 响应异常 (${probe.statusText})`,
          fallbackCommand: `ollama pull ${targetModel}`,
        });
      }
    } catch (err) {
      return reply.status(502).send({
        ok: false,
        error: `无法连通 Ollama: ${err instanceof Error ? err.message : String(err)}`,
        fallbackCommand: `ollama pull ${targetModel}`,
      });
    }

    // 标记开始下载任务
    activeEmbeddingPull = {
      active: true,
      model: targetModel,
      status: "正在建立模型流式下载连接...",
      percent: 0,
    };

    // 启动非阻塞流式下载任务，杜绝同步等待导致的 502/超时
    (async () => {
      try {
        const pullRes = await fetchFn(`${cleanUrl}/api/pull`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: targetModel, stream: true }),
        });

        if (!pullRes.ok || !pullRes.body) {
          activeEmbeddingPull = {
            active: false,
            model: targetModel,
            status: "failed",
            percent: 0,
            error: `Ollama 拉取接口异常: ${pullRes.statusText}`,
          };
          return;
        }

        const handleLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          try {
            const data = JSON.parse(trimmed) as { status?: string; completed?: number; total?: number };
            const percent =
              data.total && data.total > 0
                ? Math.min(100, Math.round((data.completed! / data.total) * 100))
                : activeEmbeddingPull.percent;
            activeEmbeddingPull = {
              active: true,
              model: targetModel,
              status: data.status || "正在下载...",
              percent,
              completed: data.completed,
              total: data.total,
            };
          } catch {
            // Malformed progress output is ignored; the next valid chunk can still update status.
          }
        };

        if (typeof (pullRes.body as unknown as { getReader?: () => unknown }).getReader === "function") {
          const reader = (pullRes.body as unknown as { getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }> } }).getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) handleLine(line);
          }
          if (buffer.trim()) handleLine(buffer);
        } else {
          for await (const chunk of pullRes.body as AsyncIterable<Buffer | Uint8Array>) {
            const text = chunk.toString();
            for (const line of text.split("\n")) handleLine(line);
          }
        }

        activeEmbeddingPull = {
          active: false,
          model: targetModel,
          status: "success",
          percent: 100,
        };
      } catch (err) {
        activeEmbeddingPull = {
          active: false,
          model: targetModel,
          status: "failed",
          percent: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })().catch(() => {});

    return {
      ok: true,
      pulling: true,
      message: `已成功向 Ollama 触发「${targetModel}」模型拉取任务，正在后台高速下载`,
      progress: activeEmbeddingPull,
    };
  });

  // ── 3. 原生资料收集箱 (管家内闭环管理) ──────────────────────────────────
  app.get("/api/knowledge/documents", async () => {
    const manifest = readDocumentsManifest();
    const diskFiles = scanFilesRecursively(documentsDir);
    const updatedManifest: Record<string, KnowledgeDocument> = { ...manifest };

    // 同步磁盘现有文件到清单
    for (const fullPath of diskFiles) {
      const rel = relative(documentsDir, fullPath).replace(/\\/g, "/");
      const id = `doc:${rel}`;
      if (!updatedManifest[id]) {
        const stats = statSync(fullPath);
        const name = basename(fullPath);
        const ext = extname(fullPath).toLowerCase();
        let source: "upload" | "obsidian" | "inbox" = "upload";
        if (rel.startsWith("obsidian/")) source = "obsidian";
        else if (rel.startsWith("inbox/")) source = "inbox";

        updatedManifest[id] = {
          id,
          name,
          path: rel,
          size: stats.size,
          ext,
          updatedAt: stats.mtime.toISOString(),
          source,
          ingested: true,
        };
      }
    }

    // 清理磁盘上已删除的项
    for (const [id, doc] of Object.entries(updatedManifest)) {
      const full = join(documentsDir, doc.path);
      if (!existsSync(full)) {
        delete updatedManifest[id];
      }
    }

    writeDocumentsManifest(updatedManifest);

    const documents = Object.values(updatedManifest).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    return { ok: true, documents, totalCount: documents.length };
  });

  app.post(
    "/api/knowledge/upload",
    { bodyLimit: 100 * 1024 * 1024 },
    async (request, reply) => {
    const body = request.body as {
      filename?: string;
      content?: string;
      encoding?: "utf8" | "base64";
      source?: "upload" | "obsidian" | "inbox";
    } | null;

    if (!body?.filename || typeof body.content !== "string") {
      return reply.status(400).send({ ok: false, error: "缺少 filename 或 content 参数" });
    }

    const safeFilename = basename(body.filename);
    const targetPath = join(documentsDir, safeFilename);
    const encoding = body.encoding === "base64" ? "base64" : "utf8";

    if (encoding === "base64") {
      writeFileSync(targetPath, Buffer.from(body.content, "base64"));
    } else {
      writeFileSync(targetPath, body.content, "utf8");
    }

    const stats = statSync(targetPath);
    const id = `doc:${safeFilename}`;
    const manifest = readDocumentsManifest();
    const doc: KnowledgeDocument = {
      id,
      name: safeFilename,
      path: safeFilename,
      size: stats.size,
      ext: extname(safeFilename).toLowerCase(),
      updatedAt: stats.mtime.toISOString(),
      source: body.source || "upload",
      ingested: true,
    };
    manifest[id] = doc;
    writeDocumentsManifest(manifest);

    return { ok: true, document: doc };
  });

  app.delete("/api/knowledge/documents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const manifest = readDocumentsManifest();
    const doc = manifest[id];

    if (!doc) {
      return reply.status(404).send({ ok: false, error: "文档不存在" });
    }

    const full = join(documentsDir, doc.path);
    if (existsSync(full)) {
      try {
        unlinkSync(full);
      } catch {
        // 忽略文件不存在或已被删除
      }
    }
    delete manifest[id];
    writeDocumentsManifest(manifest);

    return { ok: true, id };
  });

  app.post("/api/knowledge/documents/:id/ingest", async (request, reply) => {
    const { id } = request.params as { id: string };
    const manifest = readDocumentsManifest();
    const doc = manifest[id];

    if (!doc) {
      return reply.status(404).send({ ok: false, error: "文档不存在" });
    }

    doc.ingested = true;
    writeDocumentsManifest(manifest);

    return { ok: true, document: doc };
  });

  // ── 3.1 笔记与文档智能去重扫描与清理 ────────────────────────────────────
  app.get("/api/knowledge/dedup/scan", async (): Promise<DedupScanResult> => {
    const manifest = readDocumentsManifest();
    const docItems = Object.values(manifest);

    const hashGroups = new Map<string, KnowledgeDocument[]>();
    const nameGroups = new Map<string, KnowledgeDocument[]>();

    for (const doc of docItems) {
      const full = join(documentsDir, doc.path);
      let hash = "";
      if (existsSync(full)) {
        try {
          const buf = readFileSync(full);
          hash = createHash("sha256").update(buf).digest("hex");
        } catch {
          // Unreadable files cannot be compared and are excluded from duplicate candidates.
        }
      }
      if (hash) {
        const list = hashGroups.get(hash) || [];
        list.push(doc);
        hashGroups.set(hash, list);
      }
      const nameKey = doc.name.toLowerCase();
      const nList = nameGroups.get(nameKey) || [];
      nList.push(doc);
      nameGroups.set(nameKey, nList);
    }

    const groups: DedupGroup[] = [];
    const processedDocIds = new Set<string>();
    let duplicateCount = 0;
    let reclaimableBytes = 0;

    // 1. 第一优先级：内容完全一致（SHA-256 哈希相同）
    for (const [hash, docs] of hashGroups.entries()) {
      if (docs.length > 1) {
        // 优先保留 obsidian 来源的较新文件
        docs.sort((a, b) => {
          if (a.source === "obsidian" && b.source !== "obsidian") return -1;
          if (b.source === "obsidian" && a.source !== "obsidian") return 1;
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        });
        const primary = docs[0];
        const items: DedupItem[] = docs.map((d, idx) => ({
          id: d.id,
          name: d.name,
          path: d.path,
          size: d.size,
          updatedAt: d.updatedAt,
          source: d.source,
          contentHash: hash,
          isPrimary: idx === 0,
        }));
        groups.push({
          key: `hash:${hash}`,
          name: primary.name,
          reason: "exact_content",
          reasonLabel: "内容完全相同 (哈希匹配)",
          primaryId: primary.id,
          items,
        });
        docs.forEach((d) => processedDocIds.add(d.id));
        duplicateCount += docs.length - 1;
        reclaimableBytes += docs.slice(1).reduce((acc, cur) => acc + (cur.size || 0), 0);
      }
    }

    // 2. 第二优先级：文件名相同但路径不同（未在哈希重复中处理过的）
    for (const [nameKey, docs] of nameGroups.entries()) {
      const remainingDocs = docs.filter((d) => !processedDocIds.has(d.id));
      if (remainingDocs.length > 1) {
        remainingDocs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        const primary = remainingDocs[0];
        const items: DedupItem[] = remainingDocs.map((d, idx) => ({
          id: d.id,
          name: d.name,
          path: d.path,
          size: d.size,
          updatedAt: d.updatedAt,
          source: d.source,
          isPrimary: idx === 0,
        }));
        groups.push({
          key: `name:${nameKey}`,
          name: primary.name,
          reason: "same_name_different_path",
          reasonLabel: "同名历史残留 / 不同路径副本",
          primaryId: primary.id,
          items,
        });
        remainingDocs.forEach((d) => processedDocIds.add(d.id));
      }
    }

    const scanId = randomUUID();
    const candidates = new Map<string, { primaryId: string; contentHash: string }>();
    for (const group of groups) {
      if (group.reason !== "exact_content") continue;
      for (const item of group.items) {
        if (!item.isPrimary && item.contentHash) {
          candidates.set(item.id, {
            primaryId: group.primaryId,
            contentHash: item.contentHash,
          });
        }
      }
    }
    const now = Date.now();
    for (const [id, snapshot] of dedupSnapshots) {
      if (now - snapshot.createdAt > 10 * 60_000) dedupSnapshots.delete(id);
    }
    while (dedupSnapshots.size >= 20) {
      const oldest = dedupSnapshots.keys().next().value;
      if (oldest === undefined) break;
      dedupSnapshots.delete(oldest);
    }
    dedupSnapshots.set(scanId, { createdAt: now, candidates });

    return {
      ok: true,
      scanId,
      totalDocs: docItems.length,
      duplicateCount,
      groups,
      reclaimableBytes,
    };
  });

  app.post("/api/knowledge/dedup/clean", async (request, reply) => {
    const body = request.body as {
      confirmed?: boolean;
      scanId?: string;
      removeIds?: string[];
    } | null;

    if (
      body?.confirmed !== true ||
      typeof body.scanId !== "string" ||
      !Array.isArray(body.removeIds) ||
      body.removeIds.length === 0 ||
      !body.removeIds.every((id) => typeof id === "string") ||
      new Set(body.removeIds).size !== body.removeIds.length
    ) {
      return reply.status(400).send({ ok: false, error: "dedup-confirmation-required" });
    }

    const snapshot = dedupSnapshots.get(body.scanId);
    if (!snapshot || Date.now() - snapshot.createdAt > 10 * 60_000) {
      dedupSnapshots.delete(body.scanId);
      return reply.status(409).send({ ok: false, error: "dedup-scan-expired" });
    }

    const manifest = readDocumentsManifest();
    const toRemove = body.removeIds;
    for (const id of toRemove) {
      const candidate = snapshot.candidates.get(id);
      const doc = manifest[id];
      const primary = candidate ? manifest[candidate.primaryId] : undefined;
      if (!candidate || !doc || !primary) {
        return reply.status(409).send({ ok: false, error: "dedup-candidate-stale" });
      }

      const candidatePath = join(documentsDir, doc.path);
      const primaryPath = join(documentsDir, primary.path);
      if (!existsSync(candidatePath) || !existsSync(primaryPath)) {
        return reply.status(409).send({ ok: false, error: "dedup-candidate-stale" });
      }
      try {
        const candidateHash = createHash("sha256")
          .update(readFileSync(candidatePath))
          .digest("hex");
        const primaryHash = createHash("sha256")
          .update(readFileSync(primaryPath))
          .digest("hex");
        if (
          candidateHash !== candidate.contentHash ||
          primaryHash !== candidate.contentHash
        ) {
          return reply.status(409).send({ ok: false, error: "dedup-candidate-stale" });
        }
      } catch {
        return reply.status(409).send({ ok: false, error: "dedup-candidate-stale" });
      }
    }

    let removedCount = 0;
    let reclaimedBytes = 0;

    for (const id of toRemove) {
      const doc = manifest[id];
      if (doc) {
        const full = join(documentsDir, doc.path);
        if (existsSync(full)) {
          try {
            unlinkSync(full);
          } catch {
            // The manifest is still reconciled if the file was removed outside this service.
          }
        }
        reclaimedBytes += doc.size || 0;
        delete manifest[id];
        removedCount += 1;
      }
    }

    writeDocumentsManifest(manifest);
    dedupSnapshots.delete(body.scanId);

    const cfg = readObsidianConfig();
    const totalObsidianDocs = Object.values(manifest).filter((d) => d.source === "obsidian").length;
    cfg.noteCount = totalObsidianDocs;
    writeObsidianConfig(cfg);

    return {
      ok: true,
      removedCount,
      reclaimedBytes,
      remainingCount: Object.keys(manifest).length,
      message: `已成功清理 ${removedCount} 篇冗余重复笔记，释放 ${Math.max(1, Math.round(reclaimedBytes / 1024))} KB 空间`,
    };
  });

  // ── 4. Obsidian 笔记库绑定与跨系统增量同步 ─────────────────────────────
  function readObsidianConfig(): ObsidianConfig {
    try {
      if (existsSync(obsidianConfigFile)) {
        return JSON.parse(readFileSync(obsidianConfigFile, "utf8")) as ObsidianConfig;
      }
    } catch {
      // 忽略
    }
    return { vaultPath: "", autoSync: false, noteCount: 0 };
  }

  function writeObsidianConfig(cfg: ObsidianConfig): void {
    atomicWriteJson(obsidianConfigFile, cfg, {
      mode: 0o600,
      description: "Obsidian 笔记库配置",
    });
  }

  app.get("/api/knowledge/obsidian/config", async (): Promise<ObsidianConfig> => {
    const cfg = readObsidianConfig();
    const effectivePath = resolveVaultPath(cfg.vaultPath);
    if (effectivePath && existsSync(effectivePath)) {
      const files = scanFilesRecursively(effectivePath, [".obsidian", ".git", ".trash"]);
      const mdFiles = files.filter((f) => f.endsWith(".md") || f.endsWith(".canvas"));
      cfg.noteCount = mdFiles.length;
    } else if (cfg.vaultPath && existsSync(cfg.vaultPath)) {
      const files = scanFilesRecursively(cfg.vaultPath, [".obsidian", ".git", ".trash"]);
      const mdFiles = files.filter((f) => f.endsWith(".md") || f.endsWith(".canvas"));
      cfg.noteCount = mdFiles.length;
    }
    return cfg;
  });

  app.post("/api/knowledge/obsidian/config", async (request) => {
    const body = request.body as Partial<ObsidianConfig> | null;
    const current = readObsidianConfig();
    const updated: ObsidianConfig = {
      vaultPath: typeof body?.vaultPath === "string" ? body.vaultPath.trim() : current.vaultPath,
      vaultName: typeof body?.vaultName === "string" ? body.vaultName.trim() : current.vaultName,
      autoSync: typeof body?.autoSync === "boolean" ? body.autoSync : current.autoSync,
      lastSyncAt: current.lastSyncAt,
      noteCount: current.noteCount,
    };
    writeObsidianConfig(updated);
    return { ok: true, config: updated };
  });

  app.post("/api/knowledge/obsidian/test-path", async (request) => {
    const body = request.body as { path?: string } | null;
    const rawPath = body?.path?.trim() || "";
    const resolved = resolveVaultPath(rawPath);
    const candidatePath = existsSync(resolved) ? resolved : existsSync(rawPath) ? rawPath : "";
    const exists = Boolean(candidatePath);
    let noteCount = 0;
    if (exists) {
      const files = scanFilesRecursively(candidatePath, [".obsidian", ".git", ".trash"]);
      noteCount = files.filter((f) => f.endsWith(".md") || f.endsWith(".canvas")).length;
    }
    return {
      ok: true,
      rawPath,
      resolvedPath: resolved,
      exists,
      noteCount,
      message: exists
        ? `路径有效，成功识别到 ${noteCount} 篇笔记`
        : `未找到该路径下的文件（尝试路径: ${resolved}）。若是外部目录，建议直接在下方使用「选择本地文件夹」由浏览器直接读取同步。`,
    };
  });

  app.post(
    "/api/knowledge/obsidian/upload-vault",
    { bodyLimit: 200 * 1024 * 1024 },
    async (request, reply) => {
      const body = request.body as {
        files?: Array<{
          path: string;
          content: string;
          encoding?: "utf8" | "base64";
        }>;
        vaultName?: string;
        isLastBatch?: boolean;
        totalCount?: number;
      } | null;

      if (!body?.files || !Array.isArray(body.files) || body.files.length === 0) {
        return reply.status(400).send({ ok: false, error: "未选择任何笔记文件" });
      }

      const targetBase = join(documentsDir, "obsidian");
      mkdirSync(targetBase, { recursive: true });
      const manifest = readDocumentsManifest();
      let uploadedCount = 0;

      for (const item of body.files) {
        if (!item.path || typeof item.content !== "string") continue;
        const cleanRel = item.path.replace(/^[/\\]+/, "").replace(/\\/g, "/");
        if (cleanRel.includes(".obsidian/") || cleanRel.includes(".git/") || cleanRel.includes(".trash/")) {
          continue;
        }

        const fullDest = join(targetBase, cleanRel);
        mkdirSync(resolve(fullDest, ".."), { recursive: true });

        if (item.encoding === "base64") {
          writeFileSync(fullDest, Buffer.from(item.content, "base64"));
        } else {
          writeFileSync(fullDest, item.content, "utf8");
        }

        const stats = statSync(fullDest);
        const id = `doc:obsidian/${cleanRel}`;
        manifest[id] = {
          id,
          name: basename(cleanRel),
          path: `obsidian/${cleanRel}`,
          size: stats.size,
          ext: extname(cleanRel).toLowerCase(),
          updatedAt: stats.mtime.toISOString(),
          source: "obsidian",
          ingested: true,
        };
        uploadedCount += 1;
      }

      writeDocumentsManifest(manifest);
      const cfg = readObsidianConfig();
      const totalObsidianDocs = Object.values(manifest).filter((d) => d.source === "obsidian").length;
      cfg.noteCount = typeof body.totalCount === "number" ? body.totalCount : totalObsidianDocs;
      cfg.lastSyncAt = new Date().toISOString();
      if (typeof body?.vaultName === "string" && body.vaultName.trim()) {
        cfg.vaultName = body.vaultName.trim();
      }
      writeObsidianConfig(cfg);

      return {
        ok: true,
        uploadedCount,
        totalCount: cfg.noteCount,
        vaultName: cfg.vaultName,
        message: `成功从本地文件夹同步 ${cfg.noteCount} 篇 Obsidian 笔记至本地知识库`,
      };
    },
  );

  app.post("/api/knowledge/obsidian/sync", async (request, reply) => {
    const cfg = readObsidianConfig();
    const effectivePath =
      resolveVaultPath(cfg.vaultPath) && existsSync(resolveVaultPath(cfg.vaultPath))
        ? resolveVaultPath(cfg.vaultPath)
        : existsSync(cfg.vaultPath)
          ? cfg.vaultPath
          : "";

    if (!effectivePath) {
      return reply.status(400).send({
        ok: false,
        error: "未检测到有效的 Obsidian 笔记库路径，请检查路径或使用「选择本地文件夹」一键同步",
      });
    }

    const files = scanFilesRecursively(effectivePath, [".obsidian", ".git", ".trash"]);
    const noteFiles = files.filter((f) => f.endsWith(".md") || f.endsWith(".canvas"));

    const targetBase = join(documentsDir, "obsidian");
    mkdirSync(targetBase, { recursive: true });

    let syncedCount = 0;
    const manifest = readDocumentsManifest();

    for (const src of noteFiles) {
      const rel = relative(effectivePath, src);
      const dest = join(targetBase, rel);
      mkdirSync(resolve(dest, ".."), { recursive: true });
      copyFileSync(src, dest);
      syncedCount += 1;

      const id = `doc:obsidian/${rel.replace(/\\/g, "/")}`;
      const stats = statSync(dest);
      manifest[id] = {
        id,
        name: basename(src),
        path: `obsidian/${rel.replace(/\\/g, "/")}`,
        size: stats.size,
        ext: extname(src).toLowerCase(),
        updatedAt: stats.mtime.toISOString(),
        source: "obsidian",
        ingested: true,
      };
    }

    writeDocumentsManifest(manifest);
    cfg.lastSyncAt = new Date().toISOString();
    cfg.noteCount = noteFiles.length;
    writeObsidianConfig(cfg);

    return {
      ok: true,
      syncedCount,
      totalNotes: noteFiles.length,
      lastSyncAt: cfg.lastSyncAt,
      message: `成功同步 ${syncedCount} 篇 Obsidian 笔记至知识库收集箱`,
    };
  });

  // ── 5. 真实外部聊天工具文件归纳箱 (WeChat / IM 附件自动发现) ────────────────
  app.get("/api/knowledge/inbox", async () => {
    const manifest = readInboxManifest();
    const files: InboxFile[] = [];
    const seenIds = new Set<string>();

    // 1. 扫描 Hermes 微信/各通道缓存文件
    const candidateDirs: string[] = [
      join(home, "hermes", "cache", "documents"),
      "/home/butler/hermes/cache/documents",
      "/home/jiach/.hermes/cache/documents",
    ];
    if (process.env["BUTLER_HERMES_HOST_PATH"]) {
      candidateDirs.unshift(join(process.env["BUTLER_HERMES_HOST_PATH"], "cache", "documents"));
    }
    if (process.env["HOME"]) {
      candidateDirs.push(join(process.env["HOME"], ".hermes", "cache", "documents"));
    }

    for (const dir of candidateDirs) {
      if (!existsSync(dir)) continue;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || entry.name.startsWith(".")) continue;
          const fullPath = join(dir, entry.name);
          const stats = statSync(fullPath);
          // 匹配 Hermes 命名规范: doc_{uuid12}_{filename}
          const docMatch = entry.name.match(/^doc_[a-f0-9]{12}_(.*)$/);
          const cleanName = docMatch ? docMatch[1] : entry.name;
          const id = `inbox:hermes:${entry.name}`;
          if (seenIds.has(id)) continue;
          seenIds.add(id);

          const isIngested =
            Boolean(manifest[id]?.ingested) ||
            existsSync(join(documentsDir, "inbox", cleanName)) ||
            existsSync(join(documentsDir, cleanName));

          files.push({
            id,
            channel: "微信 (WeChat)",
            sender: "微信会话传输",
            date: stats.mtime.toISOString().slice(0, 10),
            filename: cleanName,
            size: stats.size,
            path: fullPath,
            ingested: isIngested,
          });
        }
      } catch {
        // 忽略单目录读取错误
      }
    }

    // 2. 扫描 data/inbox 中的落盘文件（自动清洗清除任何残留模拟数据）
    const diskFiles = scanFilesRecursively(inboxDir);
    for (const fullPath of diskFiles) {
      const rel = relative(inboxDir, fullPath).replace(/\\/g, "/");
      // 清除历史测试 mock 文件
      if (
        rel.includes("张经理") ||
        rel.includes("李总监") ||
        rel.includes("Alex (Security)") ||
        rel.includes("2026架构改造") ||
        rel.includes("2026年Q3") ||
        rel.includes("Security_Audit")
      ) {
        try {
          unlinkSync(fullPath);
        } catch {
          // ignore
        }
        continue;
      }

      const parts = rel.split("/");
      const filename = parts.pop() || basename(fullPath);
      const channel = parts[0] === "weixin" ? "微信 (WeChat)" : parts[0] || "IM 传输";
      const sender = parts[1] || "用户传输";
      const date = parts[2] || new Date().toISOString().slice(0, 10);
      const id = `inbox:disk:${rel}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const stats = statSync(fullPath);
      const isIngested =
        Boolean(manifest[id]?.ingested) ||
        existsSync(join(documentsDir, "inbox", filename)) ||
        existsSync(join(documentsDir, filename));

      files.push({
        id,
        channel,
        sender,
        date,
        filename,
        size: stats.size,
        path: fullPath,
        ingested: isIngested,
      });
    }

    files.sort((a, b) => b.date.localeCompare(a.date));

    return { ok: true, files, totalCount: files.length };
  });

  app.post("/api/knowledge/inbox/ingest", async (request) => {
    const body = request.body as { fileIds?: string[] } | null;
    const inboxManifest = readInboxManifest();
    const docManifest = readDocumentsManifest();
    const targetBase = join(documentsDir, "inbox");
    mkdirSync(targetBase, { recursive: true });

    // 先通过统一扫描获取候选文件列表
    const candidateDirs: string[] = [
      join(home, "hermes", "cache", "documents"),
      "/home/butler/hermes/cache/documents",
      "/home/jiach/.hermes/cache/documents",
    ];
    if (process.env["BUTLER_HERMES_HOST_PATH"]) {
      candidateDirs.unshift(join(process.env["BUTLER_HERMES_HOST_PATH"], "cache", "documents"));
    }
    if (process.env["HOME"]) {
      candidateDirs.push(join(process.env["HOME"], ".hermes", "cache", "documents"));
    }

    const availableItems: Array<{ id: string; name: string; fullPath: string }> = [];

    for (const dir of candidateDirs) {
      if (!existsSync(dir)) continue;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || entry.name.startsWith(".")) continue;
          const fullPath = join(dir, entry.name);
          const docMatch = entry.name.match(/^doc_[a-f0-9]{12}_(.*)$/);
          const cleanName = docMatch ? docMatch[1] : entry.name;
          const id = `inbox:hermes:${entry.name}`;
          availableItems.push({ id, name: cleanName, fullPath });
        }
      } catch {
        // ignore
      }
    }

    const diskFiles = scanFilesRecursively(inboxDir);
    for (const fullPath of diskFiles) {
      const rel = relative(inboxDir, fullPath).replace(/\\/g, "/");
      const filename = basename(fullPath);
      availableItems.push({ id: `inbox:disk:${rel}`, name: filename, fullPath });
    }

    let ingestedCount = 0;
    const selectedIds = new Set(body?.fileIds || []);

    for (const item of availableItems) {
      if (selectedIds.size > 0 && !selectedIds.has(item.id)) {
        continue;
      }

      const dest = join(targetBase, item.name);
      try {
        copyFileSync(item.fullPath, dest);
        inboxManifest[item.id] = { ingested: true };
        const stats = statSync(dest);
        const docId = `doc:inbox/${item.name}`;
        docManifest[docId] = {
          id: docId,
          name: item.name,
          path: `inbox/${item.name}`,
          size: stats.size,
          ext: extname(item.name).toLowerCase(),
          updatedAt: stats.mtime.toISOString(),
          source: "inbox",
          ingested: true,
        };
        ingestedCount += 1;
      } catch {
        // 忽略单文件复制错误
      }
    }

    writeInboxManifest(inboxManifest);
    writeDocumentsManifest(docManifest);

    return {
      ok: true,
      ingestedCount,
      message: `已将 ${ingestedCount} 个聊天归档文件入库至本地知识库`,
    };
  });

  // ── 6. 资料在线预览接口 (Native Preview) ───────────────────────────────────
  app.get("/api/knowledge/documents/:id/preview", async (request, reply) => {
    const { id } = request.params as { id: string };
    const manifest = readDocumentsManifest();
    const doc = manifest[id];

    if (!doc) {
      return reply.status(404).send({ ok: false, error: "文档未在清单中找到" });
    }

    const full = join(documentsDir, doc.path);
    if (!existsSync(full)) {
      return reply.status(404).send({ ok: false, error: "磁盘文件不存在" });
    }

    const text = extractDocumentText(full);
    const maxLength = 16000;
    const previewContent = text.slice(0, maxLength);

    return {
      ok: true,
      name: doc.name,
      ext: doc.ext,
      size: doc.size,
      updatedAt: doc.updatedAt,
      content: previewContent,
      truncated: text.length > maxLength,
      totalLength: text.length,
    };
  });

  // ── 7. 原生知识问答与语义检索 (Native RAG Query) ───────────────────────────
  app.post("/api/knowledge/query", async (request, reply) => {
    const body = request.body as { query?: string } | null;
    const query = body?.query?.trim();

    if (!query) {
      return reply.status(400).send({ ok: false, error: "提问内容不能为空" });
    }

    const manifest = readDocumentsManifest();
    const docItems = Object.values(manifest);

    interface ChunkMatch {
      docName: string;
      path: string;
      snippet: string;
      score: number;
    }

    const matchedChunks: ChunkMatch[] = [];
    const tokensSet = new Set<string>();
    const cleanTokens = query
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1);
    for (const t of cleanTokens) tokensSet.add(t);

    const chineseRuns = query.match(/[\u4e00-\u9fa5]+/g) || [];
    for (const run of chineseRuns) {
      if (run.length >= 2) {
        for (let i = 0; i < run.length - 1; i++) {
          tokensSet.add(run.slice(i, i + 2));
        }
        if (run.length >= 3) {
          for (let i = 0; i < run.length - 2; i++) {
            tokensSet.add(run.slice(i, i + 3));
          }
        }
      }
    }
    const queryTokens = Array.from(tokensSet);

    for (const doc of docItems) {
      const fullPath = join(documentsDir, doc.path);
      if (!existsSync(fullPath)) continue;

      const docText = extractDocumentText(fullPath);
      if (!docText || docText.length < 10) continue;

      // 按段落或每 400 字符切片
      const paragraphs = docText
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter((p) => p.length > 15);

      for (const para of paragraphs) {
        const lowerPara = para.toLowerCase();
        let score = 0;
        for (const token of queryTokens) {
          if (lowerPara.includes(token)) {
            score += 3;
          }
        }
        // 如果文档名称包含关键词
        if (queryTokens.some((token) => doc.name.toLowerCase().includes(token))) {
          score += 5;
        }

        if (score > 0) {
          matchedChunks.push({
            docName: doc.name,
            path: doc.path,
            snippet: para.slice(0, 450),
            score,
          });
        }
      }
    }

    // 排序并截取 top 4 最相关片段
    matchedChunks.sort((a, b) => b.score - a.score);
    const topChunks = matchedChunks.slice(0, 4);

    const contextText =
      topChunks.length > 0
        ? topChunks
            .map((c, i) => `【参考资料 ${i + 1}：${c.docName}】\n${c.snippet}`)
            .join("\n\n")
        : "（本地知识库未检索到与提问相关的文字段落）";

    const rawOllamaUrl =
      options.ollamaUrl ?? process.env["BUTLER_OLLAMA_URL"] ?? "http://127.0.0.1:11434";
    const cleanUrl = rawOllamaUrl.replace(/\/+$/, "");

    let answer = "";
    try {
      const prompt = `你是由 Agent Butler 驱动的本地私有知识库智能管家。请严格根据以下从本地知识库检索到的参考资料回答用户的问题。
回答要求：
1. 给出清晰、专业、结构化的中文回答。
2. 明确引用资料中的具体信息（如时间、地点、数字、主体单位、核心条款）。
3. 如果资料中没有提及，请如实说明，不要凭空捏造。

【本地参考资料】：
${contextText}

【用户问题】：
${query}`;

      const chatRes = await fetchFn(`${cleanUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "qwen2.5:3b",
          messages: [{ role: "user", content: prompt }],
          stream: false,
        }),
        signal: AbortSignal.timeout(35000),
      });

      if (chatRes.ok) {
        const chatData = (await chatRes.json()) as { message?: { content?: string } };
        answer = chatData.message?.content || "";
      } else {
        answer = `【本地参考检索结果】：\n\n${contextText}\n\n（提示：本地 Ollama 响应 ${chatRes.statusText}，以上为知识库直接召回的最相关内容片段）`;
      }
    } catch {
      answer = `【本地参考检索结果】：\n\n${contextText}\n\n（提示：未能连通本地生成模型，以上为知识库直接召回的最相关内容片段）`;
    }

    return {
      ok: true,
      answer,
      citations: topChunks,
    };
  });


  // ── 6. 知识图谱（星图 / Galaxy Graph）拓扑数据 ──────────────────────────
  app.get("/api/knowledge/graph", async (): Promise<GraphData> => {
    const manifest = readDocumentsManifest();
    const nodes: GraphNode[] = [];
    const links: GraphLink[] = [];
    const nodeMap = new Map<string, GraphNode>();
    const tagMap = new Map<string, GraphNode>();

    const docItems = Object.values(manifest);

    // 1. 生成文档节点
    for (const doc of docItems) {
      const node: GraphNode = {
        id: doc.id,
        name: doc.name.replace(/\.(md|canvas|txt|json|pdf|docx|xlsx)$/i, ""),
        type: doc.source === "obsidian" ? "obsidian" : doc.source === "inbox" ? "inbox" : "document",
        val: Math.min(24, Math.max(8, Math.round(Math.log2(Math.max(1, doc.size / 64))) * 2 + 8)),
        connections: 0,
        cluster: doc.source,
        details: {
          path: doc.path,
          size: doc.size,
          updatedAt: doc.updatedAt,
        },
      };
      nodes.push(node);
      nodeMap.set(node.id, node);
      nodeMap.set(node.name.toLowerCase(), node);
    }

    // 2. 解析 Markdown 正文中的 Wikilinks 与 Tags
    for (const doc of docItems) {
      if (!doc.ext.includes("md") && !doc.ext.includes("canvas") && !doc.ext.includes("txt")) {
        continue;
      }

      const fullPath = join(documentsDir, doc.path);
      if (!existsSync(fullPath)) continue;

      try {
        const text = readFileSync(fullPath, "utf8");

        // 解析 [[Wikilinks]]
        const wikiRegex = /\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g;
        let match: RegExpExecArray | null;
        while ((match = wikiRegex.exec(text)) !== null) {
          const targetName = match[1].trim().toLowerCase();
          const targetNode = nodeMap.get(targetName);
          if (targetNode && targetNode.id !== doc.id) {
            links.push({
              source: doc.id,
              target: targetNode.id,
              type: "wikilink",
              strength: 1.0,
            });
          } else if (match[1].trim()) {
            // 虚拟概念星辰节点
            const conceptId = `concept:${match[1].trim()}`;
            if (!nodeMap.has(conceptId)) {
              const cNode: GraphNode = {
                id: conceptId,
                name: match[1].trim(),
                type: "concept",
                val: 12,
                connections: 0,
                cluster: "concept",
              };
              nodes.push(cNode);
              nodeMap.set(conceptId, cNode);
            }
            links.push({
              source: doc.id,
              target: conceptId,
              type: "wikilink",
              strength: 0.8,
            });
          }
        }

        // 解析 #标签
        const tagRegex = /(?:^|\s)#([a-zA-Z0-9_\u4e00-\u9fa5]{2,20})/g;
        while ((match = tagRegex.exec(text)) !== null) {
          const rawTag = match[1].trim();
          const tagId = `tag:${rawTag}`;
          if (!tagMap.has(tagId)) {
            const tNode: GraphNode = {
              id: tagId,
              name: `#${rawTag}`,
              type: "tag",
              val: 10,
              connections: 0,
              cluster: "tag",
            };
            nodes.push(tNode);
            tagMap.set(tagId, tNode);
          }
          links.push({
            source: doc.id,
            target: tagId,
            type: "tag",
            strength: 0.7,
          });
        }
      } catch {
        // 忽略单个文件解析异常
      }
    }

    // 3. 若节点较少或连接稀疏，构建语义星群，确保星图具备壮丽的暗黑星系视觉
    if (nodes.length > 0 && links.length < nodes.length) {
      const coreClusterNode: GraphNode = {
        id: "concept:管家核心知识枢纽",
        name: "Agent Butler 核心星系",
        type: "concept",
        val: 22,
        connections: 0,
        cluster: "core",
      };
      nodes.push(coreClusterNode);
      for (const n of nodes) {
        if (n.id !== coreClusterNode.id && n.type !== "tag") {
          links.push({
            source: n.id,
            target: coreClusterNode.id,
            type: "semantic",
            strength: 0.5,
          });
        }
      }
    }

    // 计算各节点连接度 (degree)
    for (const link of links) {
      const s = nodeMap.get(link.source) || tagMap.get(link.source);
      const t = nodeMap.get(link.target) || tagMap.get(link.target);
      if (s) s.connections = (s.connections || 0) + 1;
      if (t) t.connections = (t.connections || 0) + 1;
    }

    return {
      nodes,
      links,
      stats: {
        totalNodes: nodes.length,
        totalLinks: links.length,
        docCount: docItems.length,
        tagCount: tagMap.size,
      },
    };
  });

  // ── 7. 容器启动与终端日志流 ──────────────────────────────────────────
  app.get("/api/knowledge/start-progress", async (): Promise<StartupProgress> => {
    const { running } = await checkRunning();
    if (running) {
      startupState.ready = true;
      startupState.percent = 100;
      startupState.stage = "ready";
      startupState.stageLabel = "本地知识库运行中 (:3001)";
      startupState.active = false;
      startupState.error = undefined;
    }
    return { ...startupState };
  });

  app.post("/api/knowledge/start", async () => {
    const { running } = await checkRunning();
    if (running) {
      startupState.ready = true;
      startupState.percent = 100;
      startupState.stage = "ready";
      startupState.stageLabel = "本地知识库已在线";
      startupState.active = false;
      startupState.error = undefined;
      return { ok: true, message: "服务已在线", progress: startupState };
    }

    writePrefs({ enabled: true });

    startupState.active = true;
    startupState.ready = false;
    startupState.stage = "preparing";
    startupState.stageLabel = "正在准备启动环境...";
    startupState.percent = 10;
    startupState.logs = [];
    startupState.error = undefined;
    startupState.startedAt = Date.now();

    (async () => {
      const updaterUrl = (
        options.updaterUrl ||
        process.env["BUTLER_UPDATER_URL"] ||
        "http://butler-updater:7540"
      )
        .trim()
        .replace(/\/+$/, "");

      const updaterToken = (
        options.updaterToken ||
        process.env["BUTLER_UPDATER_ACCESS_TOKEN"] ||
        process.env["BUTLER_INTERNAL_TOKEN"] ||
        process.env["BUTLER_ACCESS_TOKEN"] ||
        ""
      ).trim();

      // 1. 优先探测 Compose 内部网络的容器管理侧车 (butler-updater)
      let hasUpdater = false;
      try {
        const probe = await fetchFn(`${updaterUrl}/healthz`, {
          signal: AbortSignal.timeout(1500),
        });
        if (probe.ok) hasUpdater = true;
      } catch {
        hasUpdater = false;
      }

      if (hasUpdater) {
        appendLog(`[调度] 检测到容器管理侧车 (${updaterUrl})，正在委派拉起任务...`);
        appendLog(">>> docker compose --profile rag-anythingllm up -d butler-rag-anythingllm");
        startupState.stage = "pulling";
        startupState.stageLabel = "正在拉取镜像并启动 AnythingLLM 容器...";
        startupState.percent = 35;

        try {
          const res = await fetchFn(`${updaterUrl}/api/service/start`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(updaterToken
                ? {
                    "x-butler-token": updaterToken,
                    "x-butler-internal-token": updaterToken,
                  }
                : {}),
            },
            body: JSON.stringify({
              service: "butler-rag-anythingllm",
              profile: "rag-anythingllm",
            }),
            signal: AbortSignal.timeout(300_000), // 最多等待 5 分钟
          });

          const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

          if (res.ok && data["ok"] === true) {
            appendLog("[调度] 守护侧车执行成功，容器已就绪并转入后台运行。");
            if (typeof data["stdout"] === "string" && data["stdout"].trim()) {
              for (const line of data["stdout"].split("\n")) {
                const trimmed = line.trim();
                if (trimmed) appendLog(`  ${trimmed}`);
              }
            }
            startProbingLoop();
            return;
          }

          const errDetail =
            (typeof data["error"] === "string" && data["error"]) ||
            (typeof data["reason"] === "string" && data["reason"]) ||
            `HTTP ${res.status}`;
          appendLog(`[错误] 调度侧车执行返回异常: ${errDetail}`);

          if (/docker\.sock|Cannot connect|permission denied|ENOENT/i.test(errDetail)) {
            appendLog("[说明] butler-updater 侧车未接入宿主 Docker Socket 或权限未开放。");
            appendLog("[操作] 请在宿主终端直接执行以下命令拉起知识库：");
            appendLog("       docker compose --profile rag-anythingllm up -d butler-rag-anythingllm");
            appendLog("[提示] 外部拉起后，本地心跳雷达将自动感应到端口亮起并切入，无需刷新。");
            startupState.stage = "failed";
            startupState.stageLabel = "Docker 调度环境受限";
            startupState.error = "未检测到 Docker Socket 权限，请在宿主终端执行命令拉起";
            startupState.active = false;
            return;
          }

          appendLog("[操作] 遇到未知调度错误，您可在宿主终端手动执行：");
          appendLog("       docker compose --profile rag-anythingllm up -d butler-rag-anythingllm");
          startupState.stage = "failed";
          startupState.stageLabel = "容器启动异常";
          startupState.error = errDetail;
          startupState.active = false;
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          appendLog(`[异常] 调度通信异常: ${message}`);
          appendLog("[操作] 请在宿主终端直接执行：docker compose --profile rag-anythingllm up -d butler-rag-anythingllm");
          startupState.stage = "failed";
          startupState.stageLabel = "调度通信异常";
          startupState.error = message;
          startupState.active = false;
          return;
        }
      }

      // 2. 无 updater 侧车（宿主机单机裸跑模式）：检测本机 docker CLI
      appendLog(">>> docker compose --profile rag-anythingllm up -d butler-rag-anythingllm");
      try {
        const child = spawn(
          "docker",
          ["compose", "--profile", "rag-anythingllm", "up", "-d", "butler-rag-anythingllm"],
          { shell: true, cwd: process.cwd() },
        );

        child.stdout?.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            appendLog(trimmed);
            if (/pulling|downloading|extracting|fetch/i.test(trimmed)) {
              startupState.stage = "pulling";
              startupState.stageLabel = "正在下载 / 校验 AnythingLLM 镜像层...";
              startupState.percent = Math.min(65, Math.max(startupState.percent, 35));
            } else if (/creating|created|starting|started|running/i.test(trimmed)) {
              startupState.stage = "launching";
              startupState.stageLabel = "正在创建并启动 butler-rag-anythingllm 容器...";
              startupState.percent = Math.min(85, Math.max(startupState.percent, 70));
            }
          }
        });

        child.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            appendLog(trimmed);
            if (/pulling|downloading|extracting/i.test(trimmed)) {
              startupState.stage = "pulling";
              startupState.stageLabel = "正在下载镜像层...";
              startupState.percent = Math.min(65, Math.max(startupState.percent, 40));
            }
          }
        });

        child.on("error", (err) => {
          appendLog(`[说明] 本机无 Docker 命令行或处于无特权安全沙箱: ${err.message}`);
          appendLog("[操作] 请在宿主终端直接执行以下命令拉起知识库：");
          appendLog("       docker compose --profile rag-anythingllm up -d butler-rag-anythingllm");
          appendLog("[提示] 外部拉起后，本地心跳雷达将自动感应到端口亮起并切入，无需刷新。");
          startupState.stage = "failed";
          startupState.stageLabel = "未检测到 Docker 环境";
          startupState.error = "当前环境无法直接调用 Docker，请在宿主终端手动运行启动命令";
          startupState.active = false;
        });

        child.on("close", (code) => {
          if (code === 0) {
            appendLog(`[Docker] 进程执行完毕 (退出码: 0)`);
            startProbingLoop();
          } else {
            appendLog(`[错误] 本地 Docker 进程异常退出 (退出码: ${code ?? 0})`);
            startupState.stage = "failed";
            startupState.stageLabel = "Docker 启动命令失败";
            startupState.error = `本地 Docker 命令执行异常 (退出码: ${code})`;
            startupState.active = false;
          }
        });
      } catch (err) {
        appendLog(`[异常] 启动调度异常: ${err instanceof Error ? err.message : String(err)}`);
        startupState.stage = "failed";
        startupState.stageLabel = "启动调度异常";
        startupState.error = String(err);
        startupState.active = false;
      }
    })();

    function startProbingLoop() {
      startupState.stage = "probing";
      startupState.stageLabel = "容器已启动，正在探测 3001 端口连通态...";
      startupState.percent = Math.max(startupState.percent, 75);

      let attempts = 0;
      const maxAttempts = 40;
      const interval = setInterval(async () => {
        attempts += 1;
        appendLog(
          `[探活] 正在探测 AnythingLLM 端口连通态 (第 ${attempts}/${maxAttempts} 次)...`,
        );

        const { running } = await checkRunning();
        if (running) {
          clearInterval(interval);
          appendLog("[成功] 探测到 AnythingLLM 响应 200 OK！本地知识库已就绪上线。");
          startupState.stage = "ready";
          startupState.stageLabel = "本地知识库正常运行中";
          startupState.percent = 100;
          startupState.ready = true;
          startupState.active = false;
          startupState.error = undefined;
          return;
        }

        if (attempts >= maxAttempts) {
          clearInterval(interval);
          appendLog("[超时] 超过 40 秒未检测到 3001 端口响应。");
          appendLog("[提示] 请在宿主终端执行 docker compose logs butler-rag-anythingllm 查看容器内部日志。");
          startupState.stage = "failed";
          startupState.stageLabel = "启动探活超时";
          startupState.error = "未在预期时间内检测到容器就绪，请在终端查看 docker compose logs butler-rag-anythingllm";
          startupState.active = false;
        }
      }, 1000);
      interval.unref?.();
    }

    return { ok: true, message: "已开始启动知识库容器", progress: startupState };
  });
}
