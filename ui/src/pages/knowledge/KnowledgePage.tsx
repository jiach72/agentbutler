/**
 * 本地知识库一级主页面（AnythingLLM RAG + 原生收集箱 + 知识星图 + 聊天归档 + Obsidian同步）：
 * 1. 顶部状态结论条 + 实时探活感知；
 * 2. 智能 Embedding 向量模型检测与黄色警告引导（页内一键下载 nomic-embed-text）；
 * 3. 原生资料收集箱闭环（免跳转，管家内直接拖拽上传、查看、管理文档）；
 * 4. Obsidian 笔记库增量自动同步；
 * 5. 聊天工具（微信/钉钉/Telegram）传输文件有序归纳箱与一键入库；
 * 6. 知识图谱（暗黑星图 / Galaxy Graph）；
 * 7. 全功能内嵌视图 (AnythingLLM Iframe 混合模式)；
 * 8. 启动中真实步骤条、动态百分比与终端日志流。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Empty,
  Flex,
  Input,
  List,
  Modal,
  Popconfirm,
  Progress,
  Row,
  Space,
  Steps,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  Upload,
  Drawer,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  AimOutlined,
  BookOutlined,
  CheckCircleFilled,
  ClearOutlined,
  CloudDownloadOutlined,
  CloudUploadOutlined,
  CommentOutlined,
  CompassOutlined,
  DeleteOutlined,
  ExclamationCircleOutlined,
  EyeOutlined,
  FileDoneOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  InboxOutlined,
  LoadingOutlined,
  MessageOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SyncOutlined,
  WarningFilled,
} from "@ant-design/icons";
import { PageHeader } from "../../components/PageHeader.js";
import { ConclusionBar } from "../../components/ConclusionBar.js";
import { ConnectionChip } from "../../components/ConnectionChip.js";
import { CopySnippetButton } from "../../components/CopySnippetButton.js";
import { DangerConfirmModal } from "../../components/DangerConfirmModal.js";
import { deleteJson, loadJson, postJson } from "../../lib/api.js";
import type { KnowledgeStatus } from "../settings/KnowledgeConfigCard.js";
import {
  KnowledgeStarChart,
  type GraphData,
} from "./KnowledgeStarChart.js";

const { Paragraph, Text, Title } = Typography;

const START_COMMAND = "docker compose up -d butler-rag-anythingllm";

export interface StartupProgress {
  active: boolean;
  stage: "idle" | "preparing" | "pulling" | "launching" | "probing" | "ready" | "failed";
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

export interface EmbeddingStatus {
  ready: boolean;
  activeModel?: string;
  installedModels: string[];
  recommended: string;
  message?: string;
  pulling?: boolean;
  pullProgress?: EmbeddingPullProgress;
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

export interface VaultSyncProgress {
  active: boolean;
  phase: "reading" | "indexing" | "done" | "error";
  phaseLabel: string;
  total: number;
  current: number;
  percent: number;
  vaultName?: string;
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

export function KnowledgePage() {
  const { message, modal } = App.useApp();
  const [status, setStatus] = useState<KnowledgeStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [toggling, setToggling] = useState(false);

  // 容器启动进度状态
  const [startupProgress, setStartupProgress] = useState<StartupProgress | null>(null);
  const [launchingInWeb, setLaunchingInWeb] = useState(false);
  const terminalBottomRef = useRef<HTMLDivElement>(null);

  // 主导航 Tab
  const [activeTab, setActiveTab] = useState<string>("vault");

  // 1. Embedding 模型检测状态
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus | null>(null);
  const [pullingEmbedding, setPullingEmbedding] = useState(false);

  // 2. 原生资料收集箱状态
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);

  // 3. Obsidian 笔记库状态
  const [obsidianConfig, setObsidianConfig] = useState<ObsidianConfig | null>(null);
  const [obsidianModalOpen, setObsidianModalOpen] = useState(false);
  const [obsidianPathInput, setObsidianPathInput] = useState("");
  const [syncingObsidian, setSyncingObsidian] = useState(false);

  // 4. 聊天文件收件箱状态
  const [inboxFiles, setInboxFiles] = useState<InboxFile[]>([]);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [ingestingInbox, setIngestingInbox] = useState(false);

  // 5. 知识星图数据
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);

  // 6. 原生文档预览抽屉状态
  const [previewDrawerOpen, setPreviewDrawerOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState<{
    name: string;
    ext: string;
    size: number;
    updatedAt: string;
    content: string;
    truncated: boolean;
  } | null>(null);

  // 7. 原生知识问答与语义检索状态
  const [queryInput, setQueryInput] = useState("");
  const [querying, setQuerying] = useState(false);
  const [queryResult, setQueryResult] = useState<{
    query: string;
    answer: string;
    citations: Array<{ docName: string; path: string; snippet: string; score: number }>;
  } | null>(null);

  // 8. Obsidian 本地笔记库文件夹选择器与实时同步进度
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [vaultSync, setVaultSync] = useState<VaultSyncProgress | null>(null);

  // 9. Obsidian 路径测试状态
  const [testingPath, setTestingPath] = useState(false);
  const [testPathResult, setTestPathResult] = useState<{
    exists: boolean;
    noteCount: number;
    resolvedPath: string;
    message: string;
  } | null>(null);

  // 10. 笔记智能去重与冗余副本清理状态
  const [dedupModalOpen, setDedupModalOpen] = useState(false);
  const [dedupScanning, setDedupScanning] = useState(false);
  const [dedupCleaning, setDedupCleaning] = useState(false);
  const [dedupResult, setDedupResult] = useState<DedupScanResult | null>(null);
  const [selectedRemoveIds, setSelectedRemoveIds] = useState<string[]>([]);
  const [dedupConfirmOpen, setDedupConfirmOpen] = useState(false);
  const [dedupConfirmIds, setDedupConfirmIds] = useState<string[]>([]);

  // 打开去重弹窗并执行扫描
  const handleOpenDedupModal = async () => {
    setDedupModalOpen(true);
    setDedupResult(null);
    setSelectedRemoveIds([]);
    setDedupScanning(true);
    const res = await loadJson<DedupScanResult>("/api/knowledge/dedup/scan", 15_000);
    setDedupScanning(false);
    if (res.ok && res.data) {
      setDedupResult(res.data);
      setSelectedRemoveIds([]);
    } else {
      message.error("扫描重复笔记失败，请检查网络或后端状态");
    }
  };

  const handleRequestDedupClean = () => {
    const ids = selectedRemoveIds.filter((id) =>
      dedupResult?.groups.some(
        (group) =>
          group.reason === "exact_content" &&
          group.items.some((item) => item.id === id && !item.isPrimary),
      ),
    );
    if (!dedupResult?.scanId || ids.length === 0) {
      message.warning("请至少勾选一项需要清理的重复副本");
      return;
    }
    setDedupConfirmIds(ids);
    setDedupConfirmOpen(true);
  };

  const handleExecuteClean = async () => {
    if (!dedupResult?.scanId || dedupConfirmIds.length === 0) return;
    setDedupCleaning(true);
    message.loading({ content: "正在清理已确认的重复副本...", key: "dedup-clean" });
    const res = await postJson(
      "/api/knowledge/dedup/clean",
      { scanId: dedupResult.scanId, confirmed: true, removeIds: dedupConfirmIds },
      20_000,
    );
    setDedupCleaning(false);

    const data = res.data as { ok?: boolean; removedCount?: number; reclaimedBytes?: number } | null;
    if (res.ok && data?.ok) {
      const { removedCount, reclaimedBytes } = data;
      message.success({
        content: `成功清理 ${removedCount || 0} 篇冗余副本，释放 ${Math.max(1, Math.round((reclaimedBytes || 0) / 1024))} KB 磁盘空间！`,
        key: "dedup-clean",
        duration: 4,
      });
      setDedupModalOpen(false);
      setDedupConfirmOpen(false);
      void fetchDocuments();
      void fetchGraph();
      void fetchObsidianConfig();
    } else {
      message.error({
        content:
          res.status === 409
            ? "扫描结果已变化，请重新扫描后再清理"
            : "清理失败，请重试",
        key: "dedup-clean",
      });
      if (res.status === 409) {
        setDedupConfirmOpen(false);
        void handleOpenDedupModal();
      }
    }
  };

  // 加载本地知识库主状态
  const fetchStatus = useCallback(async () => {
    setLoading(true);
    const res = await loadJson<KnowledgeStatus>("/api/knowledge/status", 5_000);
    if (res.ok && res.data) {
      setStatus(res.data);
    }
    setLoading(false);
  }, []);

  // 加载启动进度
  const fetchProgress = useCallback(async () => {
    const res = await loadJson<StartupProgress>("/api/knowledge/start-progress", 4_000);
    if (res.ok && res.data) {
      setStartupProgress(res.data);
      if (res.data.ready) {
        setStatus((prev) => (prev ? { ...prev, running: true } : prev));
      }
    }
  }, []);

  // 加载 Embedding 模型状态
  const fetchEmbeddingStatus = useCallback(async () => {
    const res = await loadJson<EmbeddingStatus>("/api/knowledge/embedding-status", 4_000);
    if (res.ok && res.data) {
      setEmbeddingStatus(res.data);
    }
  }, []);

  // 加载收集箱文档列表
  const fetchDocuments = useCallback(async () => {
    setDocsLoading(true);
    const res = await loadJson<{ ok: boolean; documents: KnowledgeDocument[] }>(
      "/api/knowledge/documents",
      6_000,
    );
    if (res.ok && Array.isArray(res.data?.documents)) {
      setDocuments(res.data.documents);
    }
    setDocsLoading(false);
  }, []);

  // 加载 Obsidian 配置
  const fetchObsidianConfig = useCallback(async () => {
    const res = await loadJson<ObsidianConfig>("/api/knowledge/obsidian/config", 4_000);
    if (res.ok && res.data) {
      setObsidianConfig(res.data);
      setObsidianPathInput(res.data.vaultPath || "");
    }
  }, []);

  // 加载聊天收件箱
  const fetchInbox = useCallback(async () => {
    setInboxLoading(true);
    const res = await loadJson<{ ok: boolean; files: InboxFile[] }>("/api/knowledge/inbox", 5_000);
    if (res.ok && Array.isArray(res.data?.files)) {
      setInboxFiles(res.data.files);
    }
    setInboxLoading(false);
  }, []);

  // 加载星图拓扑数据
  const fetchGraph = useCallback(async () => {
    setGraphLoading(true);
    const res = await loadJson<GraphData>("/api/knowledge/graph", 8_000);
    if (res.ok && res.data) {
      setGraphData(res.data);
    }
    setGraphLoading(false);
  }, []);

  useEffect(() => {
    void fetchStatus();
    void fetchProgress();
    void fetchEmbeddingStatus();
    void fetchDocuments();
    void fetchObsidianConfig();
    void fetchInbox();
    void fetchGraph();
  }, [
    fetchStatus,
    fetchProgress,
    fetchEmbeddingStatus,
    fetchDocuments,
    fetchObsidianConfig,
    fetchInbox,
    fetchGraph,
  ]);

  // 当处于「已启用但未就绪」状态时，开启高频雷达轮询
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    const isEnabled = status?.enabled ?? false;
    const isRunning = status?.running ?? false;

    if (isEnabled && !isRunning) {
      interval = setInterval(() => {
        void fetchProgress();
        void fetchStatus();
      }, 1200);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [status?.enabled, status?.running, fetchProgress, fetchStatus]);

  // 控制台日志滚动到底部
  useEffect(() => {
    if (terminalBottomRef.current) {
      terminalBottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [startupProgress?.logs.length]);

  // 轮询 Embedding 下载进度
  useEffect(() => {
    if (!embeddingStatus?.pulling && !pullingEmbedding) return;
    const timer = setInterval(() => {
      void fetchEmbeddingStatus();
    }, 2000);
    return () => clearInterval(timer);
  }, [embeddingStatus?.pulling, pullingEmbedding, fetchEmbeddingStatus]);

  // 一键拉取/下载 Embedding 模型
  const handlePullEmbedding = async () => {
    setPullingEmbedding(true);
    message.loading({ content: "正在向本地 Ollama 派发 nomic-embed-text 下载指令...", key: "pull-embed" });
    const res = await postJson("/api/knowledge/embedding/pull", { model: "nomic-embed-text" }, 15_000);
    if (res.ok) {
      message.success({ content: "已成功启动 Embedding 模型后台高速拉取！", key: "pull-embed" });
      void fetchEmbeddingStatus();
    } else {
      setPullingEmbedding(false);
      message.error({
        content: "无法连通 Ollama，请确保 Ollama 服务已启动，或手动运行 ollama pull nomic-embed-text",
        key: "pull-embed",
        duration: 6,
      });
    }
  };

  // 网页直接点击一键拉起容器
  const handleLaunchInWeb = useCallback(async () => {
    setLaunchingInWeb(true);
    message.loading({ content: "正在向后台下发 Docker 拉取与启动指令...", key: "launch-msg" });
    const res = await postJson("/api/knowledge/start", {}, 20_000);
    setLaunchingInWeb(false);
    if (res.ok) {
      message.success({ content: "已启动容器构建流程，正在输出实时终端日志！", key: "launch-msg" });
      void fetchProgress();
    } else {
      message.error({ content: "启动指令派发失败，请在宿主终端手动执行", key: "launch-msg" });
    }
  }, [message, fetchProgress]);

  // 开启知识库二次确认
  const handleEnable = useCallback(() => {
    modal.confirm({
      title: "确认开启本地知识库？",
      icon: <ExclamationCircleOutlined style={{ color: "var(--ant-color-primary)" }} />,
      content: (
        <Flex vertical gap={8} style={{ marginTop: 8 }}>
          <Paragraph style={{ margin: 0 }}>
            开启后，将启用 <strong>AnythingLLM</strong> 单容器轻量服务并监听{" "}
            <Text code>127.0.0.1:3001</Text>。
          </Paragraph>
          <Paragraph style={{ margin: 0 }}>
            • <strong>本地模型联动</strong>：自动直连本地 Ollama 共享 Embedding 与模型，100% 离线私有；
            <br />
            • <strong>管家内原生闭环</strong>：支持直接拖拽上传、Obsidian 同步与微信文件归纳，无需跳转外部；
            <br />
            • <strong>持久化存储</strong>：资料文件与向量索引安全写入 <Text code>anythingllm-data</Text> 命名卷。
          </Paragraph>
        </Flex>
      ),
      okText: "确认开启",
      cancelText: "取消",
      onOk: async () => {
        setToggling(true);
        const res = await postJson("/api/knowledge/toggle", { enabled: true }, 10_000);
        setToggling(false);
        if (res.ok) {
          message.success("已开启本地知识库选项！正在初始化启动流程...");
          void fetchStatus();
          void handleLaunchInWeb();
        } else {
          message.error("开启失败，请重试");
        }
      },
    });
  }, [modal, message, fetchStatus, handleLaunchInWeb]);

  // 文档删除处理
  const handleDeleteDocument = async (id: string) => {
    const res = await deleteJson(`/api/knowledge/documents/${encodeURIComponent(id)}`);
    if (res.ok) {
      message.success("已从收集箱移除该文档");
      void fetchDocuments();
      void fetchGraph();
    } else {
      message.error("删除失败");
    }
  };

  // 保存 Obsidian 路径配置
  const handleSaveObsidianConfig = async () => {
    const res = await postJson("/api/knowledge/obsidian/config", {
      vaultPath: obsidianPathInput.trim(),
      autoSync: true,
    });
    if (res.ok) {
      message.success("Obsidian 笔记库路径已保存！");
      setObsidianModalOpen(false);
      void fetchObsidianConfig();
    } else {
      message.error("保存配置失败");
    }
  };

  // 触发 Obsidian 增量同步
  const handleSyncObsidian = async () => {
    setSyncingObsidian(true);
    message.loading({ content: "正在扫描并同步 Obsidian 笔记库...", key: "obsidian-sync" });
    const res = await postJson("/api/knowledge/obsidian/sync", {}, 30_000);
    setSyncingObsidian(false);
    const data = res.data as { ok?: boolean; syncedCount?: number; message?: string; error?: string } | null;
    if (res.ok && data?.ok) {
      message.success({ content: data.message || `同步完成！`, key: "obsidian-sync" });
      void fetchObsidianConfig();
      void fetchDocuments();
      void fetchGraph();
    } else {
      message.error({ content: data?.error || "同步失败，请检查笔记库路径有效性", key: "obsidian-sync" });
    }
  };

  // 一键将聊天归档文件入库
  const handleIngestInbox = async (fileIds?: string[]) => {
    setIngestingInbox(true);
    message.loading({ content: "正在将聊天文件导入本地知识库...", key: "ingest-inbox" });
    const res = await postJson("/api/knowledge/inbox/ingest", { fileIds });
    setIngestingInbox(false);
    const data = res.data as { ok?: boolean; message?: string } | null;
    if (res.ok && data?.ok) {
      message.success({ content: data.message || "已成功入库！", key: "ingest-inbox" });
      void fetchInbox();
      void fetchDocuments();
      void fetchGraph();
    } else {
      message.error({ content: "入库失败", key: "ingest-inbox" });
    }
  };

  // 打开文档原文预览抽屉
  const handleOpenPreview = async (doc: KnowledgeDocument) => {
    setPreviewDrawerOpen(true);
    setPreviewLoading(true);
    setPreviewData({
      name: doc.name,
      ext: doc.ext,
      size: doc.size,
      updatedAt: doc.updatedAt,
      content: "",
      truncated: false,
    });
    const res = await loadJson<{
      ok: boolean;
      name: string;
      ext: string;
      size: number;
      updatedAt: string;
      content: string;
      truncated: boolean;
    }>(`/api/knowledge/documents/${encodeURIComponent(doc.id)}/preview`, 10_000);
    setPreviewLoading(false);
    if (res.ok && res.data) {
      setPreviewData(res.data);
    } else {
      message.error("加载文档预览失败");
    }
  };

  // 触发原生知识问答检索
  const handleRunQuery = async (overrideQuery?: string) => {
    const q = (overrideQuery ?? queryInput).trim();
    if (!q) {
      message.warning("请输入您想向知识库提问的问题");
      return;
    }
    setQuerying(true);
    const res = await postJson("/api/knowledge/query", { query: q }, 40_000);
    setQuerying(false);
    const data = res.data as {
      ok?: boolean;
      answer?: string;
      citations?: Array<{ docName: string; path: string; snippet: string; score: number }>;
    } | null;
    if (res.ok && data) {
      setQueryResult({
        query: q,
        answer: data.answer || "",
        citations: data.citations || [],
      });
    } else {
      message.error("知识库问答检索失败，请检查模型服务状态");
    }
  };

  // 浏览器原生选择本地 Obsidian 文件夹批量读取与直接同步
  const handleFolderPicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const validFiles: File[] = [];
    let detectedVaultName = "";
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const relPath = file.webkitRelativePath || file.name;
      if (
        relPath.includes(".obsidian/") ||
        relPath.includes(".git/") ||
        relPath.includes(".trash/")
      ) {
        continue;
      }
      if (!detectedVaultName && file.webkitRelativePath) {
        detectedVaultName = file.webkitRelativePath.split("/")[0] || "";
      }
      if (file.name.endsWith(".md") || file.name.endsWith(".canvas")) {
        validFiles.push(file);
      }
    }

    if (validFiles.length === 0) {
      message.warning("所选文件夹中未找到 Markdown (.md) 或 Canvas 笔记");
      return;
    }

    // 1. 初始化同步进度条状态
    setVaultSync({
      active: true,
      phase: "reading",
      phaseLabel: `正在读取本地笔记库 ${detectedVaultName ? `「${detectedVaultName}」` : ""} (0 / ${validFiles.length} 篇)...`,
      total: validFiles.length,
      current: 0,
      percent: 5,
      vaultName: detectedVaultName,
    });

    try {
      const payloadFiles: Array<{ path: string; content: string }> = [];
      const batchUpdateInterval = Math.max(1, Math.floor(validFiles.length / 25));

      for (let i = 0; i < validFiles.length; i++) {
        const file = validFiles[i];
        const text = await file.text();
        const relPath = file.webkitRelativePath || file.name;
        const parts = relPath.replace(/\\/g, "/").split("/");
        const trimmedPath = parts.length > 1 ? parts.slice(1).join("/") : relPath;
        payloadFiles.push({ path: trimmedPath, content: text });

        // 动态提升读取进度条 (5% ~ 50%)
        if (i % batchUpdateInterval === 0 || i === validFiles.length - 1) {
          const currentCount = i + 1;
          const readPercent = Math.min(50, Math.round(5 + (currentCount / validFiles.length) * 45));
          setVaultSync({
            active: true,
            phase: "reading",
            phaseLabel: `正在读取本地笔记并解析结构 (${currentCount} / ${validFiles.length} 篇)...`,
            total: validFiles.length,
            current: currentCount,
            percent: readPercent,
            vaultName: detectedVaultName,
          });
        }
      }

      // 2. 建立双向链与切片索引入库 (50% ~ 95% 平滑分批同步，彻底杜绝超大 Payload 与 Connection Reset)
      const BATCH_SIZE = 40;
      const totalBatches = Math.ceil(payloadFiles.length / BATCH_SIZE);
      let totalUploaded = 0;

      for (let b = 0; b < totalBatches; b++) {
        const batchFiles = payloadFiles.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
        const isLastBatch = b === totalBatches - 1;
        const currentUploadedCount = Math.min(validFiles.length, (b + 1) * BATCH_SIZE);
        const batchPercent = Math.min(95, Math.round(50 + ((b + 1) / totalBatches) * 45));

        setVaultSync({
          active: true,
          phase: "indexing",
          phaseLabel: `正在建立切片索引与双向链 (第 ${b + 1}/${totalBatches} 批，共 ${validFiles.length} 篇)...`,
          total: validFiles.length,
          current: currentUploadedCount,
          percent: batchPercent,
          vaultName: detectedVaultName,
        });

        const res = await postJson(
          "/api/knowledge/obsidian/upload-vault",
          {
            files: batchFiles,
            vaultName: detectedVaultName,
            isLastBatch,
            totalCount: validFiles.length,
          },
          60_000,
        );
        const data = res.data as { ok?: boolean; uploadedCount?: number; totalCount?: number; message?: string } | null;

        if (!res.ok || !data?.ok) {
          throw new Error(data?.message || "批次同步上传失败");
        }
        totalUploaded = data.totalCount ?? currentUploadedCount;
      }

      // 3. 同步完成 (100%)
      setVaultSync({
        active: false,
        phase: "done",
        phaseLabel: `已成功同步 ${totalUploaded || validFiles.length} 篇 Obsidian 笔记！`,
        total: validFiles.length,
        current: validFiles.length,
        percent: 100,
        vaultName: detectedVaultName,
      });
      message.success(`成功同步 ${validFiles.length} 篇 Obsidian 笔记至本地知识库！`);
      void fetchObsidianConfig();
      void fetchDocuments();
      void fetchGraph();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "读取或同步本地笔记文件出错";
      setVaultSync({
        active: false,
        phase: "error",
        phaseLabel: errMsg,
        total: validFiles.length,
        current: 0,
        percent: 0,
        vaultName: detectedVaultName,
      });
      message.error(errMsg);
    } finally {
      if (folderInputRef.current) {
        folderInputRef.current.value = "";
      }
    }
  };

  // 测试手动输入的 Obsidian 路径
  const handleTestPath = async () => {
    if (!obsidianPathInput.trim()) {
      message.warning("请先输入路径");
      return;
    }
    setTestingPath(true);
    setTestPathResult(null);
    const res = await postJson(
      "/api/knowledge/obsidian/test-path",
      { path: obsidianPathInput.trim() },
      8_000,
    );
    setTestingPath(false);
    const data = res.data as {
      ok: boolean;
      exists: boolean;
      noteCount: number;
      resolvedPath: string;
      message: string;
    } | null;
    if (res.ok && data) {
      setTestPathResult(data);
    }
  };

  // 收集箱文档列表表头
  const documentColumns: ColumnsType<KnowledgeDocument> = [
    {
      title: "资料名称",
      dataIndex: "name",
      key: "name",
      render: (name: string, record) => (
        <Flex align="center" gap={8}>
          {record.ext === ".pdf" ? (
            <FilePdfOutlined style={{ color: "#e65100", fontSize: 16 }} />
          ) : record.source === "obsidian" ? (
            <BookOutlined style={{ color: "#00e5ff", fontSize: 16 }} />
          ) : record.source === "inbox" ? (
            <MessageOutlined style={{ color: "#00e676", fontSize: 16 }} />
          ) : (
            <FileTextOutlined style={{ color: "#1890ff", fontSize: 16 }} />
          )}
          <Text strong>{name}</Text>
        </Flex>
      ),
    },
    {
      title: "来源通道",
      dataIndex: "source",
      key: "source",
      width: 130,
      render: (src: string) => {
        if (src === "obsidian") return <Tag color="cyan">Obsidian 笔记</Tag>;
        if (src === "inbox") return <Tag color="green">微信/聊天归档</Tag>;
        return <Tag color="purple">本地直接上传</Tag>;
      },
    },
    {
      title: "文件大小",
      dataIndex: "size",
      key: "size",
      width: 100,
      render: (bytes: number) => (
        <Text type="secondary">{Math.max(1, Math.round(bytes / 1024))} KB</Text>
      ),
    },
    {
      title: "入库时间",
      dataIndex: "updatedAt",
      key: "updatedAt",
      width: 160,
      render: (iso: string) => (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {new Date(iso).toLocaleString("zh-CN", { hour12: false })}
        </Text>
      ),
    },
    {
      title: "向量化状态",
      dataIndex: "ingested",
      key: "ingested",
      width: 120,
      render: (ingested: boolean) =>
        ingested ? (
          <Tag icon={<CheckCircleFilled />} color="success">
            已向量化
          </Tag>
        ) : (
          <Tag color="default">就绪待分段</Tag>
        ),
    },
    {
      title: "操作",
      key: "actions",
      width: 100,
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="在线预览文档内容">
            <Button
              size="small"
              type="text"
              icon={<EyeOutlined style={{ color: "var(--ant-color-primary)" }} />}
              onClick={() => handleOpenPreview(record)}
            />
          </Tooltip>
          <Popconfirm
            title="确认从知识库中移除该文档？"
            okText="移除"
            cancelText="取消"
            onConfirm={() => handleDeleteDocument(record.id)}
          >
            <Button size="small" type="text" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const isRunning = status?.running ?? false;
  const isEnabled = status?.enabled ?? false;

  // 步骤条进度映射
  const isProbingFailure =
    startupProgress?.stage === "failed" &&
    (startupProgress.error?.includes("3001") ||
      startupProgress.error?.includes("探活") ||
      startupProgress.stageLabel?.includes("探活") ||
      startupProgress.logs?.some((l) => l.includes("探测") || l.includes("探活") || l.includes("Healthcheck")));

  const isPullingOrLaunchingFailure =
    startupProgress?.stage === "failed" &&
    !isProbingFailure &&
    startupProgress.logs?.some((l) =>
      l.includes("拉取") || l.includes("pull") || l.includes("创建") || l.includes("creating"),
    );

  const currentStep =
    startupProgress?.ready || isRunning
      ? 3
      : startupProgress?.stage === "probing" || isProbingFailure
        ? 2
        : startupProgress?.stage === "pulling" || startupProgress?.stage === "launching" || isPullingOrLaunchingFailure
          ? 1
          : 0;

  return (
    <div className="knowledge-page">
      <Flex vertical gap={20}>
        <PageHeader
          title="本地知识库"
          extra={
            <Flex align="center" gap={12}>
              <ConnectionChip
                reachable={isRunning}
                onlineText="知识库服务在线 (:3001)"
                offlineText={isEnabled ? "等待知识库容器响应" : "本地知识库未开启"}
              />
              <Button
                size="small"
                icon={<ReloadOutlined spin={loading} />}
                onClick={() => {
                  void fetchStatus();
                  void fetchProgress();
                  void fetchEmbeddingStatus();
                  void fetchDocuments();
                  void fetchInbox();
                  void fetchGraph();
                }}
                disabled={loading}
              >
                刷新
              </Button>
            </Flex>
          }
        />

        {/* 1. Embedding 模型缺失智能检测、拉取进度与就绪提示栏 */}
        {embeddingStatus && embeddingStatus.ready ? (
          <Alert
            type="success"
            showIcon
            message={
              <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
                <Text strong style={{ fontSize: 13, color: "var(--ant-color-success)" }}>
                  本地 Embedding 向量模型已就绪：{embeddingStatus.activeModel || "nomic-embed-text:latest"}
                </Text>
                <Tag color="success">已挂载生效</Tag>
              </Flex>
            }
            description={
              <Text type="secondary" style={{ fontSize: 12 }}>
                本地向量嵌入模型运行良好，支持知识库切片、高维语义检索与问答精准命中。
              </Text>
            }
            style={{ borderRadius: 8 }}
          />
        ) : embeddingStatus && !embeddingStatus.ready ? (
          embeddingStatus.pulling || pullingEmbedding ? (
            <Alert
              type="info"
              showIcon
              message={
                <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
                  <Text strong style={{ fontSize: 14 }}>
                    正在后台高速下载向量模型：{embeddingStatus.pullProgress?.model || "nomic-embed-text"}
                  </Text>
                  <Text strong style={{ color: "var(--ant-color-primary)" }}>
                    {embeddingStatus.pullProgress?.percent ?? 0}%
                  </Text>
                </Flex>
              }
              description={
                <Space direction="vertical" style={{ width: "100%", marginTop: 8 }}>
                  <Progress
                    percent={embeddingStatus.pullProgress?.percent ?? 0}
                    status="active"
                    strokeColor={{ from: "#108ee9", to: "#52c41a" }}
                  />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    当前阶段：{embeddingStatus.pullProgress?.status || "正在建立流式数据连接..."}
                  </Text>
                </Space>
              }
              style={{ borderRadius: 8 }}
            />
          ) : (
            <Alert
              type="warning"
              showIcon
              icon={<WarningFilled style={{ color: "#faad14", fontSize: 18 }} />}
              message={
                <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
                  <Text strong style={{ fontSize: 14 }}>
                    未检测到本地 Embedding 向量模型
                  </Text>
                  <Space wrap>
                    <Button
                      type="primary"
                      size="small"
                      icon={<CloudDownloadOutlined />}
                      onClick={handlePullEmbedding}
                      loading={pullingEmbedding}
                      style={{ background: "#faad14", borderColor: "#faad14", color: "#000" }}
                    >
                      一键下载 nomic-embed-text
                    </Button>
                    <CopySnippetButton
                      text="ollama pull nomic-embed-text"
                      label="复制命令"
                    />
                  </Space>
                </Flex>
              }
              description={
                <Text type="secondary" style={{ fontSize: 13 }}>
                  知识库文档切片、语义相似度计算与混合检索需要向量嵌入模型支持。推荐使用轻量高速高精度的{" "}
                  <Text code>nomic-embed-text</Text>（约 274MB），点击右侧按钮即可由管家自动触发下载并挂载生效。
                </Text>
              }
              style={{ borderRadius: 8, border: "1px solid #ffe58f" }}
            />
          )
        ) : null}

        {/* 2. 顶部状态结论条 */}
        {isRunning ? (
          <ConclusionBar
            tone="ok"
            title="本地知识库正常运行中"
            copy="原生资料收集箱已就绪，文档将自动切片并向量化，供智能体随时检索与推理。"
          />
        ) : isEnabled ? (
          <ConclusionBar
            tone="warn"
            title={startupProgress?.active ? "本地知识库容器正在启动中..." : "知识库功能已启用，等待 Docker 容器响应"}
            copy={
              startupProgress?.active
                ? startupProgress.stageLabel
                : "您可以点击下方「立即在网页中拉起容器」，或在外部终端运行启动命令。"
            }
          />
        ) : (
          <ConclusionBar
            tone="info"
            title="本地知识库尚未开启"
            copy="开启后，您可以把日常资料（PDF、Word、Markdown、Obsidian 笔记）收集起来，智能体能随时查找并解答相关问题。"
          />
        )}

        {/* 3. 运行中核心操作区：提供三大 Tab 视图（原生收集箱 / 知识星图 / 全功能内嵌视图） */}
        {isRunning && (
          <Tabs
            activeKey={activeTab}
            onChange={setActiveTab}
            type="card"
            items={[
              {
                key: "vault",
                label: (
                  <Space>
                    <FolderOpenOutlined />
                    <span>原生资料收集箱</span>
                    <Tag color="blue">{documents.length}</Tag>
                  </Space>
                ),
                children: (
                  <Flex vertical gap={20}>
                    {/* A. 直接拖拽上传区 (免跳转闭环) */}
                    <Card
                      title={
                        <Flex align="center" gap={8}>
                          <CloudUploadOutlined style={{ color: "var(--ant-color-primary)" }} />
                          <span>极简资料投递与收集（支持 PDF / Word / TXT / Markdown / 表格）</span>
                        </Flex>
                      }
                      size="small"
                      style={{ borderRadius: 10 }}
                    >
                      <Upload.Dragger
                        name="file"
                        multiple
                        showUploadList={false}
                        customRequest={async (options) => {
                          const { file, onSuccess, onError } = options;
                          const rawFile = file as File;
                          const reader = new FileReader();
                          reader.onload = async () => {
                            try {
                              const content = reader.result as string;
                              const isBase64 = content.startsWith("data:");
                              const base64Data = isBase64 ? content.split(",")[1] : content;
                              const res = await postJson("/api/knowledge/upload", {
                                filename: rawFile.name,
                                content: base64Data,
                                encoding: isBase64 ? "base64" : "utf8",
                                source: "upload",
                              });
                              if (res.ok) {
                                message.success(`「${rawFile.name}」已成功投递入库并切片！`);
                                onSuccess?.(res.data, rawFile);
                                void fetchDocuments();
                                void fetchGraph();
                              } else {
                                message.error(`「${rawFile.name}」上传失败`);
                                onError?.(new Error("upload failed"));
                              }
                            } catch {
                              onError?.(new Error("read failed"));
                            }
                          };
                          // 若为二进制文件读 DataURL，纯文本读 Text
                          if (rawFile.name.endsWith(".md") || rawFile.name.endsWith(".txt") || rawFile.name.endsWith(".json")) {
                            reader.readAsText(rawFile);
                          } else {
                            reader.readAsDataURL(rawFile);
                          }
                        }}
                      >
                        <p className="ant-upload-drag-icon">
                          <InboxOutlined style={{ color: "var(--ant-color-primary)", fontSize: 40 }} />
                        </p>
                        <p className="ant-upload-text" style={{ fontSize: 15, fontWeight: 500 }}>
                          点击或将本地文件拖拽至此处，管家将直接切片并归入知识库
                        </p>
                        <p className="ant-upload-hint" style={{ fontSize: 13, color: "var(--ant-color-text-secondary)" }}>
                          支持 PDF、Word (.docx)、TXT、Markdown (.md)、Canvas、JSON 与各类表格资料。
                        </p>
                      </Upload.Dragger>
                    </Card>

                    {/* B. 专属数据源扩展卡片：Obsidian 笔记库 + 微信聊天归档文件 */}
                    <Row gutter={[16, 16]}>
                      {/* Obsidian 笔记库同步卡片 */}
                      <Col xs={24} md={12}>
                        <Card
                          size="small"
                          title={
                            <Flex justify="space-between" align="center">
                              <Flex align="center" gap={8}>
                                <BookOutlined style={{ color: "#00e5ff" }} />
                                <span>Obsidian 笔记库同步 (跨平台本地 Vault)</span>
                              </Flex>
                              <Button
                                size="small"
                                type="link"
                                onClick={() => setObsidianModalOpen(true)}
                              >
                                {obsidianConfig?.vaultPath ? "手动路径设置" : "手动输入路径"}
                              </Button>
                            </Flex>
                          }
                          style={{ height: "100%", borderRadius: 10 }}
                        >
                          <Flex vertical gap={10}>
                            <div>
                              <Text type="secondary" style={{ fontSize: 12 }}>
                                当前绑定的本地 Vault：
                              </Text>
                              <div style={{ marginTop: 2 }}>
                                <Text code style={{ fontSize: 12 }}>
                                  {obsidianConfig?.vaultPath
                                    ? obsidianConfig.vaultPath
                                    : obsidianConfig?.vaultName
                                    ? `本地笔记库「${obsidianConfig.vaultName}」`
                                    : "（点击下方「选择文件夹」直接同步，无需手动配路径）"}
                                </Text>
                              </div>
                            </div>

                            <Flex justify="space-between" align="center">
                              <div>
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  已同步笔记篇数：
                                </Text>
                                <Text strong style={{ marginLeft: 6 }}>
                                  {obsidianConfig?.noteCount || 0} 篇
                                </Text>
                              </div>
                              <div>
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  上次同步：
                                </Text>
                                <Text style={{ marginLeft: 6, fontSize: 12 }}>
                                  {obsidianConfig?.lastSyncAt
                                    ? new Date(obsidianConfig.lastSyncAt).toLocaleTimeString()
                                    : "从未"}
                                </Text>
                              </div>
                            </Flex>

                            {/* 实时同步进度条 */}
                            {vaultSync?.active && (
                              <div
                                style={{
                                  padding: "10px 12px",
                                  borderRadius: 8,
                                  background: "rgba(0, 229, 255, 0.05)",
                                  border: "1px solid rgba(0, 229, 255, 0.25)",
                                }}
                              >
                                <Flex justify="space-between" align="center" style={{ marginBottom: 6 }}>
                                  <Flex align="center" gap={6}>
                                    <SyncOutlined spin style={{ color: "#00e5ff" }} />
                                    <Text strong style={{ fontSize: 13 }}>
                                      {vaultSync.phase === "reading"
                                        ? "正在读取本地笔记并解析"
                                        : "正在构建索引与入库"}
                                    </Text>
                                  </Flex>
                                  <Text style={{ fontSize: 12, color: "var(--ant-color-text-secondary)" }}>
                                    {vaultSync.current} / {vaultSync.total} 篇 ({vaultSync.percent}%)
                                  </Text>
                                </Flex>
                                <Progress
                                  percent={vaultSync.percent}
                                  status="active"
                                  strokeColor={{
                                    "0%": "#1677ff",
                                    "100%": "#00e5ff",
                                  }}
                                  showInfo={false}
                                  size="small"
                                />
                                <div style={{ marginTop: 4 }}>
                                  <Text type="secondary" style={{ fontSize: 12 }}>
                                    {vaultSync.phaseLabel}
                                  </Text>
                                </div>
                              </div>
                            )}

                            {vaultSync && !vaultSync.active && vaultSync.phase === "done" && (
                              <Alert
                                type="success"
                                showIcon
                                message={vaultSync.phaseLabel}
                                closable
                                onClose={() => setVaultSync(null)}
                                style={{ padding: "6px 10px", fontSize: 12 }}
                              />
                            )}

                            {/* 隐藏的文件夹选择 input，全平台原生浏览器支持（macOS / Linux / Windows） */}
                            <input
                              type="file"
                              ref={folderInputRef}
                              // @ts-expect-error webkitdirectory is standard in HTML5 browsers
                              webkitdirectory=""
                              directory=""
                              multiple
                              style={{ display: "none" }}
                              onChange={handleFolderPicked}
                            />

                            <Flex gap={8}>
                              <Button
                                type="primary"
                                icon={<FolderOpenOutlined />}
                                onClick={() => folderInputRef.current?.click()}
                                disabled={vaultSync?.active}
                                loading={vaultSync?.active}
                                style={{ flex: 1, maxWidth: 360 }}
                              >
                                {vaultSync?.active ? "正在同步笔记库..." : "选择本地 Obsidian 笔记库文件夹 (Vault)"}
                              </Button>
                              <Button
                                type="default"
                                icon={<SyncOutlined spin={syncingObsidian} />}
                                onClick={handleSyncObsidian}
                                disabled={!obsidianConfig?.vaultPath || vaultSync?.active}
                                loading={syncingObsidian}
                              >
                                增量同步
                              </Button>
                            </Flex>
                          </Flex>
                        </Card>
                      </Col>

                      {/* 微信 / 聊天文件有序归纳箱卡片 */}
                      <Col xs={24} md={12}>
                        <Card
                          size="small"
                          title={
                            <Flex justify="space-between" align="center">
                              <Flex align="center" gap={8}>
                                <MessageOutlined style={{ color: "#00e676" }} />
                                <span>微信传输与聊天附件归纳箱 (WeChat / IM)</span>
                              </Flex>
                              <Tag color={inboxFiles.filter(f => !f.ingested).length > 0 ? "warning" : "green"}>
                                {inboxFiles.filter(f => !f.ingested).length} 个待入库
                              </Tag>
                            </Flex>
                          }
                          style={{ height: "100%", borderRadius: 10 }}
                        >
                          <Flex vertical gap={10}>
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              自动扫描微信等通道接收到的真实附件与文档，一键收录至本地知识库进行向量化。
                            </Text>

                            <Flex gap={8}>
                              <Button
                                size="small"
                                type="primary"
                                onClick={() => handleIngestInbox()}
                                disabled={
                                  inboxLoading ||
                                  inboxFiles.length === 0 ||
                                  inboxFiles.every((file) => file.ingested)
                                }
                                loading={inboxLoading || ingestingInbox}
                                style={{ maxWidth: 280 }}
                              >
                                一键全部纳入本地知识库
                              </Button>
                            </Flex>

                            <div
                              style={{
                                maxHeight: 115,
                                overflowY: "auto",
                                background: "var(--ant-color-fill-quaternary)",
                                padding: "6px 8px",
                                borderRadius: 6,
                                fontSize: 12,
                              }}
                            >
                              {inboxFiles.length === 0 ? (
                                <Text type="secondary">收件箱暂无新传输文件</Text>
                              ) : (
                                inboxFiles.map((f) => (
                                  <Flex key={f.id} justify="space-between" align="center" style={{ marginBottom: 4 }}>
                                    <Flex align="center" gap={6} style={{ maxWidth: 260 }}>
                                      {f.filename.endsWith(".pdf") ? (
                                        <FilePdfOutlined style={{ color: "#e65100" }} />
                                      ) : (
                                        <FileTextOutlined style={{ color: "#00e676" }} />
                                      )}
                                      <Text ellipsis style={{ maxWidth: 220 }} title={f.filename}>
                                        {f.filename}
                                      </Text>
                                    </Flex>
                                    <Space size="small">
                                      <Text type="secondary" style={{ fontSize: 11 }}>
                                        {Math.max(1, Math.round(f.size / 1024))} KB
                                      </Text>
                                      {f.ingested ? (
                                        <Tag color="blue" style={{ margin: 0, fontSize: 11 }}>已入库</Tag>
                                      ) : (
                                        <Button
                                          size="small"
                                          type="link"
                                          style={{ padding: "0 4px", fontSize: 11 }}
                                          onClick={() => handleIngestInbox([f.id])}
                                        >
                                          入库
                                        </Button>
                                      )}
                                    </Space>
                                  </Flex>
                                ))
                              )}
                            </div>
                          </Flex>
                        </Card>
                      </Col>
                    </Row>

                    {/* C. 已入库文档管理表格 */}
                    <Card
                      title={
                        <Flex justify="space-between" align="center">
                          <Flex align="center" gap={8}>
                            <FileDoneOutlined style={{ color: "var(--ant-color-primary)" }} />
                            <span>已收集资料清单与索引状态</span>
                          </Flex>
                          <Space>
                            <Button
                              size="small"
                              icon={<ClearOutlined />}
                              onClick={handleOpenDedupModal}
                              style={{
                                background: "rgba(250, 140, 22, 0.1)",
                                borderColor: "rgba(250, 140, 22, 0.4)",
                                color: "#fa8c16",
                              }}
                            >
                              智能去重
                            </Button>
                            <Button size="small" icon={<ReloadOutlined />} onClick={fetchDocuments} />
                          </Space>
                        </Flex>
                      }
                      size="small"
                      style={{ borderRadius: 10 }}
                    >
                      <Table<KnowledgeDocument>
                        rowKey="id"
                        columns={documentColumns}
                        dataSource={documents}
                        loading={docsLoading}
                        pagination={{ pageSize: 8, showSizeChanger: false }}
                        size="small"
                      />
                    </Card>
                  </Flex>
                ),
              },
              {
                key: "query",
                label: (
                  <Space>
                    <CommentOutlined />
                    <span>知识问答检索</span>
                  </Space>
                ),
                children: (
                  <Card
                    title={
                      <Flex justify="space-between" align="center">
                        <Flex align="center" gap={8}>
                          <CompassOutlined style={{ color: "var(--ant-color-primary)" }} />
                          <span>基于已收集资料的私有问答与语义检索 (Local RAG)</span>
                        </Flex>
                        <Tag color="cyan">本地 Ollama 驱动</Tag>
                      </Flex>
                    }
                    style={{ borderRadius: 12 }}
                  >
                    <Flex vertical gap={16}>
                      <Text type="secondary">
                        向 Agent Butler 的本地私有知识库提问，智能体将实时在收集箱、Obsidian 笔记及微信归纳文件中检索相关切片，并结合本地模型回答。
                      </Text>

                      {/* 提问搜索框 */}
                      <Flex gap={8}>
                        <Input.Search
                          size="large"
                          placeholder="例如：大湾区低空多维智算中心的核心建设内容和投产时间是什么？"
                          enterButton="检索问答"
                          value={queryInput}
                          onChange={(e) => setQueryInput(e.target.value)}
                          onSearch={() => handleRunQuery()}
                          loading={querying}
                        />
                      </Flex>

                      {/* 快捷提问推荐气泡 */}
                      <Flex align="center" gap={8} wrap="wrap">
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          快捷检索：
                        </Text>
                        <Button
                          size="small"
                          type="dashed"
                          onClick={() => {
                            setQueryInput("大湾区低空多维智算中心的建设单位与编制单位分别是谁？");
                            void handleRunQuery("大湾区低空多维智算中心的建设单位与编制单位分别是谁？");
                          }}
                        >
                          建设单位与编制单位？
                        </Button>
                        <Button
                          size="small"
                          type="dashed"
                          onClick={() => {
                            setQueryInput("低空多维智算中心的可行性研究主要建设内容是什么？");
                            void handleRunQuery("低空多维智算中心的可行性研究主要建设内容是什么？");
                          }}
                        >
                          主要建设内容？
                        </Button>
                        <Button
                          size="small"
                          type="dashed"
                          onClick={() => {
                            setQueryInput("本项目计划何时投产？建设地点在什么位置？");
                            void handleRunQuery("本项目计划何时投产？建设地点在什么位置？");
                          }}
                        >
                          计划投产时间与建设地点？
                        </Button>
                      </Flex>

                      {/* 问答检索结果 */}
                      {queryResult && (
                        <Card
                          size="small"
                          style={{
                            background: "var(--ant-color-fill-quaternary)",
                            borderRadius: 10,
                            border: "1px solid var(--ant-color-border-secondary)",
                          }}
                        >
                          <Flex vertical gap={12}>
                            <Flex align="center" gap={8}>
                              <MessageOutlined style={{ color: "var(--ant-color-primary)" }} />
                              <Text strong style={{ fontSize: 14 }}>
                                问答回复：
                              </Text>
                            </Flex>

                            <div
                              style={{
                                whiteSpace: "pre-wrap",
                                lineHeight: "1.7",
                                fontSize: 14,
                                padding: "10px 14px",
                                background: "rgba(0,0,0,0.15)",
                                borderRadius: 8,
                              }}
                            >
                              {queryResult.answer}
                            </div>

                            {queryResult.citations && queryResult.citations.length > 0 && (
                              <Flex vertical gap={8} style={{ marginTop: 8 }}>
                                <Text strong style={{ fontSize: 13, color: "var(--ant-color-text-secondary)" }}>
                                  参考来源与出处片段（Citations）：
                                </Text>
                                <Row gutter={[12, 12]}>
                                  {queryResult.citations.map((c, i) => (
                                    <Col xs={24} md={12} key={i}>
                                      <Card
                                        size="small"
                                        style={{
                                          borderRadius: 8,
                                          background: "var(--ant-color-bg-container)",
                                          border: "1px solid var(--ant-color-border)",
                                        }}
                                      >
                                        <Flex vertical gap={4}>
                                          <Flex justify="space-between" align="center">
                                            <Text strong ellipsis style={{ maxWidth: 220 }}>
                                              {c.docName}
                                            </Text>
                                            <Tag color="blue">匹配度 {c.score}</Tag>
                                          </Flex>
                                          <Text
                                            type="secondary"
                                            style={{
                                              fontSize: 12,
                                              maxHeight: 70,
                                              overflow: "hidden",
                                              textOverflow: "ellipsis",
                                              display: "-webkit-box",
                                              WebkitLineClamp: 3,
                                              WebkitBoxOrient: "vertical",
                                            }}
                                          >
                                            {c.snippet}
                                          </Text>
                                        </Flex>
                                      </Card>
                                    </Col>
                                  ))}
                                </Row>
                              </Flex>
                            )}
                          </Flex>
                        </Card>
                      )}
                    </Flex>
                  </Card>
                ),
              },
              {
                key: "graph",
                label: (
                  <Space>
                    <AimOutlined />
                    <span>知识图谱 (星图)</span>
                  </Space>
                ),
                children: (
                  <KnowledgeStarChart
                    data={graphData}
                    loading={graphLoading}
                    onRefresh={fetchGraph}
                    onOpenDedup={handleOpenDedupModal}
                  />
                ),
              },
            ]}
          />
        )}

        {/* 4. 已开启但尚未运行：展示四步流水线、动态百分比真实进度条与实时终端控制台 */}
        {isEnabled && !isRunning && (
          <Card
            style={{
              borderRadius: 12,
              border: "1px solid var(--ant-color-border-secondary)",
              boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
            }}
          >
            <Flex vertical gap={20}>
              {/* 顶部标题与一键拉起按钮 */}
              <Flex justify="space-between" align="center" wrap="wrap" gap={12}>
                <div>
                  <Flex align="center" gap={8}>
                    <Title level={4} style={{ margin: 0 }}>
                      本地知识库容器启动与进度
                    </Title>
                    {startupProgress?.active ? (
                      <Tag icon={<LoadingOutlined />} color="processing">
                        启动流式输出中
                      </Tag>
                    ) : (
                      <Tag color="warning">待启动</Tag>
                    )}
                  </Flex>
                  <Text type="secondary" style={{ fontSize: 13 }}>
                    后台雷达正在自动侦听回环端口 127.0.0.1:3001；服务就绪后界面将自动切入工作台，无需手动刷新。
                  </Text>
                </div>

                <Space wrap>
                  <Button
                    type="primary"
                    icon={<PlayCircleOutlined />}
                    onClick={handleLaunchInWeb}
                    loading={launchingInWeb || startupProgress?.active}
                  >
                    立即在网页中拉起容器
                  </Button>
                </Space>
              </Flex>

              {/* 异常状态智能诊断提示条 */}
              {startupProgress?.stage === "failed" && (
                <Alert
                  type="error"
                  showIcon
                  message={startupProgress.stageLabel || "容器启动未就绪"}
                  description={
                    <Flex vertical gap={6}>
                      <Text style={{ fontSize: 13 }}>
                        {startupProgress.error || "未在预期时间内检测到容器就绪，请根据下方日志排查或在宿主终端手动启动。"}
                      </Text>
                      <Flex align="center" gap={8} wrap="wrap" style={{ marginTop: 2 }}>
                        <Text strong style={{ fontSize: 12 }}>宿主终端拉起命令：</Text>
                        <Text code style={{ fontSize: 12 }}>{START_COMMAND}</Text>
                        <CopySnippetButton text={START_COMMAND} label="一键复制" />
                      </Flex>
                    </Flex>
                  }
                  action={
                    <Button
                      size="small"
                      danger
                      onClick={handleLaunchInWeb}
                      loading={launchingInWeb}
                    >
                      重新尝试
                    </Button>
                  }
                  style={{ borderRadius: 8 }}
                />
              )}

              {/* 四步流水线步骤条 */}
              <Card size="small" style={{ background: "var(--ant-color-fill-quaternary)" }}>
                <Steps
                  current={currentStep}
                  status={startupProgress?.stage === "failed" ? "error" : undefined}
                  size="small"
                  items={[
                    {
                      title: "环境预检",
                      description:
                        startupProgress?.stage === "failed" && currentStep === 0
                          ? (startupProgress.stageLabel || "环境受限")
                          : "校验调度环境与权限",
                    },
                    {
                      title: "拉取镜像",
                      description:
                        startupProgress?.stage === "failed" && currentStep === 1
                          ? (startupProgress.stageLabel || "拉取失败")
                          : "mintplexlabs/anythingllm",
                    },
                    {
                      title: "端口探活",
                      description:
                        startupProgress?.stage === "failed" && currentStep === 2
                          ? "探活响应超时"
                          : "127.0.0.1:3001",
                    },
                    { title: "就绪上线", description: "接入资料收集箱" },
                  ]}
                />
              </Card>

              {/* 真实百分比动态进度条 */}
              <Flex vertical gap={6}>
                <Flex justify="space-between" align="center">
                  <Text strong style={{ fontSize: 13 }}>
                    当前阶段：{startupProgress?.stageLabel || "准备就绪"}
                  </Text>
                  <Text strong style={{ color: "var(--ant-color-primary)" }}>
                    {startupProgress?.percent ?? 0}%
                  </Text>
                </Flex>
                <Progress
                  percent={startupProgress?.percent ?? 0}
                  status={
                    startupProgress?.stage === "failed"
                      ? "exception"
                      : startupProgress?.ready
                        ? "success"
                        : "active"
                  }
                  strokeColor={{ "0%": "#1677ff", "100%": "#52c41a" }}
                  showInfo={false}
                />
              </Flex>

              {/* 实时终端控制台窗口 (Live Terminal Window) */}
              <div
                style={{
                  borderRadius: 8,
                  overflow: "hidden",
                  border: "1px solid #303030",
                  background: "#141414",
                  boxShadow: "inset 0 1px 4px rgba(0,0,0,0.5)",
                }}
              >
                {/* 仿终端顶栏 */}
                <Flex
                  justify="space-between"
                  align="center"
                  style={{
                    padding: "6px 12px",
                    background: "#202020",
                    borderBottom: "1px solid #303030",
                  }}
                >
                  <Flex align="center" gap={6}>
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: "50%",
                        background: "#ff5f56",
                        display: "inline-block",
                      }}
                    />
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: "50%",
                        background: "#ffbd2e",
                        display: "inline-block",
                      }}
                    />
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: "50%",
                        background: "#27c93f",
                        display: "inline-block",
                      }}
                    />
                    <Text
                      style={{
                        color: "#a0a0a0",
                        fontSize: 12,
                        marginLeft: 8,
                        fontFamily: "monospace",
                      }}
                    >
                      AnythingLLM 实时终端输出 (Docker Compose)
                    </Text>
                  </Flex>
                  <Space size="small">
                    <CopySnippetButton
                      text={startupProgress?.logs.join("\n") || START_COMMAND}
                      label="复制日志"
                    />
                  </Space>
                </Flex>

                {/* 滚动日志区域 */}
                <div
                  style={{
                    padding: "12px 14px",
                    minHeight: 180,
                    maxHeight: 280,
                    overflowY: "auto",
                    fontFamily: "'Fira Code', 'Consolas', monospace",
                    fontSize: 12,
                    lineHeight: "1.6",
                    color: "#4af626",
                  }}
                >
                  {startupProgress?.logs && startupProgress.logs.length > 0 ? (
                    startupProgress.logs.map((log, idx) => (
                      <div
                        key={idx}
                        style={{
                          color: log.includes("[Success]")
                            ? "#52c41a"
                            : log.includes("[Warn]") || log.includes("[Notice]")
                              ? "#faad14"
                              : log.includes("[Error]")
                                ? "#ff4d4f"
                                : log.startsWith(">>>")
                                  ? "#1890ff"
                                  : "#d4d4d4",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-all",
                        }}
                      >
                        {log}
                      </div>
                    ))
                  ) : (
                    <div style={{ color: "#777777", fontStyle: "italic" }}>
                      &gt; 等待指令。点击上方「立即在网页中拉起容器」可直接在网页中启动，或复制下方命令在外部终端运行。
                    </div>
                  )}
                  <div ref={terminalBottomRef} />
                </div>
              </div>

              {/* 外部命令行备用参考 */}
              <Card size="small" style={{ background: "var(--ant-color-fill-quaternary)" }}>
                <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
                  <Flex vertical gap={2}>
                    <Text strong style={{ fontSize: 12 }}>
                      外部宿主终端执行命令参考：
                    </Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      若容器环境权限受限，直接在宿主终端运行此命令，网页将自动感应到端口亮起并切入工作台。
                    </Text>
                  </Flex>
                  <Flex align="center" gap={8}>
                    <Text code style={{ fontSize: 12 }}>
                      {START_COMMAND}
                    </Text>
                    <CopySnippetButton text={START_COMMAND} label="复制代码" />
                  </Flex>
                </Flex>
              </Card>
            </Flex>
          </Card>
        )}

        {/* 5. 未开启引导卡片 */}
        {!isEnabled && !isRunning && (
          <Card style={{ borderRadius: 12 }}>
            <Flex vertical gap={20}>
              <Flex align="center" gap={12}>
                <div
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 10,
                    background: "rgba(22, 119, 255, 0.1)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 24,
                    color: "var(--ant-color-primary)",
                  }}
                >
                  <BookOutlined />
                </div>
                <div>
                  <Title level={4} style={{ margin: 0 }}>
                    给您的 AI 管家装上「私人知识库」
                  </Title>
                  <Text type="secondary" style={{ fontSize: 14 }}>
                    集成开源高星轻量的 AnythingLLM 系统，管家内极简收集，Obsidian 与微信传输文件自动归纳。
                  </Text>
                </div>
              </Flex>

              <Row gutter={[16, 16]}>
                <Col xs={24} md={8}>
                  <Card size="small" style={{ background: "var(--ant-color-fill-quaternary)", height: "100%" }}>
                    <Flex vertical gap={6}>
                      <Text strong>
                        <FilePdfOutlined style={{ marginRight: 6, color: "var(--ant-color-primary)" }} />
                        管家内闭环收集
                      </Text>
                      <Text type="secondary" style={{ fontSize: 13 }}>
                        支持拖拽上传 PDF、Word、TXT、Markdown 及网页，无需跳转外部窗口，在管家内直接管理。
                      </Text>
                    </Flex>
                  </Card>
                </Col>

                <Col xs={24} md={8}>
                  <Card size="small" style={{ background: "var(--ant-color-fill-quaternary)", height: "100%" }}>
                    <Flex vertical gap={6}>
                      <Text strong>
                        <BookOutlined style={{ marginRight: 6, color: "#00e5ff" }} />
                        Obsidian 与聊天归纳
                      </Text>
                      <Text type="secondary" style={{ fontSize: 13 }}>
                        一键绑定 Obsidian 笔记库增量同步；微信等渠道接收的文件有序自动归纳分类。
                      </Text>
                    </Flex>
                  </Card>
                </Col>

                <Col xs={24} md={8}>
                  <Card size="small" style={{ background: "var(--ant-color-fill-quaternary)", height: "100%" }}>
                    <Flex vertical gap={6}>
                      <Text strong>
                        <AimOutlined style={{ marginRight: 6, color: "#722ed1" }} />
                        知识星图拓扑
                      </Text>
                      <Text type="secondary" style={{ fontSize: 13 }}>
                        独家暗黑银河星图，可视化 Wikilinks 双向链与标签星尘，点击星体即可跃迁探查。
                      </Text>
                    </Flex>
                  </Card>
                </Col>
              </Row>

              <Flex align="center" gap={12}>
                <Button
                  type="primary"
                  size="large"
                  icon={<BookOutlined />}
                  onClick={handleEnable}
                  loading={toggling}
                >
                  开启本地知识库
                </Button>
                <Link to="/settings?tab=llm&section=knowledge">
                  <Button size="large">在设置中查看</Button>
                </Link>
              </Flex>
            </Flex>
          </Card>
        )}
      </Flex>

      {/* Obsidian 笔记库配置弹窗 */}
      <Modal
        title="配置 Obsidian 笔记库本地路径"
        open={obsidianModalOpen}
        onOk={handleSaveObsidianConfig}
        onCancel={() => {
          setObsidianModalOpen(false);
          setTestPathResult(null);
        }}
        okText="保存路径"
        cancelText="取消"
      >
        <Flex vertical gap={12} style={{ marginTop: 12 }}>
          <Paragraph style={{ margin: 0, fontSize: 13 }}>
            若您希望绑定固定的本地路径进行后台周期同步，支持 macOS（如 <Text code>/Users/name/Documents/Notes</Text>）、Linux（如 <Text code>/home/name/notes</Text>）以及 Windows 绝对路径（如 <Text code>C:\Users\name\Documents\Notes</Text>）：
          </Paragraph>
          <Flex gap={8}>
            <Input
              placeholder="例如：/Users/name/Notes 或 C:\Users\name\Documents\MyVault"
              value={obsidianPathInput}
              onChange={(e) => {
                setObsidianPathInput(e.target.value);
                setTestPathResult(null);
              }}
            />
            <Button onClick={handleTestPath} loading={testingPath}>
              测试路径
            </Button>
          </Flex>

          {testPathResult && (
            <Alert
              type={testPathResult.exists ? "success" : "warning"}
              showIcon
              message={testPathResult.message}
              description={
                testPathResult.exists ? (
                  <Text style={{ fontSize: 12 }}>
                    有效路径：<Text code>{testPathResult.resolvedPath}</Text>，可直接同步！
                  </Text>
                ) : (
                  <Text style={{ fontSize: 12 }}>
                    提示：全平台用户（macOS / Linux / Windows）均可直接在主界面点击「选择本地 Obsidian 笔记库文件夹」按钮，由浏览器原生拾取并建立索引同步，无需手动配置容器路径映射。
                  </Text>
                )
              }
            />
          )}
        </Flex>
      </Modal>

      {/* 文档内容在线预览抽屉 */}
      <Drawer
        title={
          <Flex align="center" gap={8}>
            <FileTextOutlined style={{ color: "var(--ant-color-primary)" }} />
            <span>文档原文预览：{previewData?.name}</span>
          </Flex>
        }
        placement="right"
        width={680}
        open={previewDrawerOpen}
        onClose={() => setPreviewDrawerOpen(false)}
      >
        {previewLoading ? (
          <Flex justify="center" align="center" style={{ height: 200 }}>
            <LoadingOutlined style={{ fontSize: 32 }} spin />
          </Flex>
        ) : previewData ? (
          <Flex vertical gap={12}>
            <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
              <Space>
                <Tag color="blue">{previewData.ext.toUpperCase() || "DOC"}</Tag>
                <Text type="secondary">{Math.max(1, Math.round(previewData.size / 1024))} KB</Text>
                <Text type="secondary">更新时间：{new Date(previewData.updatedAt).toLocaleString()}</Text>
              </Space>
              <CopySnippetButton text={previewData.content} label="复制全文" />
            </Flex>

            {previewData.truncated && (
              <Alert
                type="info"
                showIcon
                message="文档内容较长，已展示前 16,000 字符预览，全部内容已建立切片索引。"
              />
            )}

            <div
              style={{
                fontFamily: "monospace",
                fontSize: 13,
                lineHeight: "1.6",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                background: "var(--ant-color-fill-quaternary)",
                padding: "12px 16px",
                borderRadius: 8,
                maxHeight: "75vh",
                overflowY: "auto",
                border: "1px solid var(--ant-color-border-secondary)",
              }}
            >
              {previewData.content || "（暂无文本内容）"}
            </div>
          </Flex>
        ) : (
          <Empty description="暂无预览数据" />
        )}
      </Drawer>

      {/* 11. 笔记查重与智能清理 Modal */}
      <Modal
        title={
          <Flex align="center" gap={8}>
            <ClearOutlined style={{ color: "#fa8c16" }} />
            <span>笔记与文档智能查重与清理</span>
          </Flex>
        }
        open={dedupModalOpen}
        onCancel={() => setDedupModalOpen(false)}
        width={760}
        footer={[
          <Button key="close" onClick={() => setDedupModalOpen(false)} disabled={dedupCleaning}>
            取消
          </Button>,
          <Button
            key="clean-selected"
            danger
            disabled={
              dedupScanning ||
              dedupCleaning ||
              !dedupResult ||
              selectedRemoveIds.length === 0
            }
            onClick={handleRequestDedupClean}
          >
            清理所选副本 ({selectedRemoveIds.length})
          </Button>,
        ]}
      >
        {dedupScanning ? (
          <Flex justify="center" align="center" style={{ padding: "40px 0" }} vertical gap={12}>
            <LoadingOutlined style={{ fontSize: 36, color: "#fa8c16" }} spin />
            <Text type="secondary">正在全面比对文档 SHA-256 哈希与同名异径副本...</Text>
          </Flex>
        ) : dedupResult ? (
          <Flex vertical gap={16} style={{ marginTop: 8 }}>
            {/* 统计横幅 */}
            <Card
              size="small"
              style={{
                background: "var(--ant-color-fill-quaternary)",
                borderRadius: 8,
                border: "1px solid var(--ant-color-border-secondary)",
              }}
            >
              <Row gutter={16}>
                <Col span={8}>
                  <Text type="secondary" style={{ fontSize: 12 }}>总扫描文档</Text>
                  <div><Text strong style={{ fontSize: 18 }}>{dedupResult.totalDocs} 篇</Text></div>
                </Col>
                <Col span={8}>
                  <Text type="secondary" style={{ fontSize: 12 }}>发现冗余副本</Text>
                  <div>
                    <Text
                      strong
                      style={{
                        fontSize: 18,
                        color: dedupResult.duplicateCount > 0 ? "#fa8c16" : "var(--ant-color-success)",
                      }}
                    >
                      {dedupResult.duplicateCount} 篇
                    </Text>
                  </div>
                </Col>
                <Col span={8}>
                  <Text type="secondary" style={{ fontSize: 12 }}>预计释放空间</Text>
                  <div>
                    <Text strong style={{ fontSize: 18, color: "var(--ant-color-primary)" }}>
                      {Math.max(0, Math.round(dedupResult.reclaimableBytes / 1024))} KB
                    </Text>
                  </div>
                </Col>
              </Row>
            </Card>

            {dedupResult.groups.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="太棒了！知识库与笔记库非常整洁，未发现任何重复文档。"
              />
            ) : (
              <>
                <Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
                  只有内容完全一致的副本可清理。文件名相同但内容不同的资料仅供核对，不会自动列入清理。
                </Paragraph>

                <div style={{ maxHeight: 380, overflowY: "auto", paddingRight: 4 }}>
                  <Flex vertical gap={12}>
                    {dedupResult.groups.map((group) => (
                      <Card
                        key={group.key}
                        size="small"
                        title={
                          <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
                            <Flex align="center" gap={8}>
                              <Text strong>{group.name}</Text>
                              <Tag color={group.reason === "exact_content" ? "orange" : "blue"}>
                                {group.reasonLabel}
                              </Tag>
                            </Flex>
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              共 {group.items.length} 份副本
                            </Text>
                          </Flex>
                        }
                        style={{ borderRadius: 8 }}
                      >
                        <List
                          size="small"
                          dataSource={group.items}
                          renderItem={(item) => {
                            const isSelected = selectedRemoveIds.includes(item.id);
                            return (
                              <List.Item
                                style={{
                                  padding: "8px 12px",
                                  background: item.isPrimary
                                    ? "rgba(82, 196, 26, 0.06)"
                                    : isSelected
                                      ? "rgba(250, 140, 22, 0.05)"
                                      : "transparent",
                                  borderRadius: 6,
                                  marginBottom: 4,
                                }}
                              >
                                <Flex justify="space-between" align="center" style={{ width: "100%" }}>
                                  <Flex align="center" gap={10} style={{ overflow: "hidden" }}>
                                    {group.reason === "exact_content" && !item.isPrimary ? (
                                      <Checkbox
                                        aria-label={`选择清理副本 ${item.path}`}
                                        checked={isSelected}
                                        onChange={(e) => {
                                          if (e.target.checked) {
                                            setSelectedRemoveIds((prev) =>
                                              prev.includes(item.id) ? prev : [...prev, item.id],
                                            );
                                          } else {
                                            setSelectedRemoveIds((prev) =>
                                              prev.filter((id) => id !== item.id),
                                            );
                                          }
                                        }}
                                      />
                                    ) : item.isPrimary ? (
                                      <Tag color="success" style={{ margin: 0 }}>
                                        推荐保留
                                      </Tag>
                                    ) : (
                                      <Tag color="default" style={{ margin: 0 }}>
                                        同名待核对
                                      </Tag>
                                    )}
                                    <Flex vertical style={{ minWidth: 0 }}>
                                      <Text ellipsis style={{ maxWidth: 360, fontSize: 13 }} code>
                                        {item.path}
                                      </Text>
                                      <Text type="secondary" style={{ fontSize: 11 }}>
                                        {item.source === "obsidian"
                                          ? "Obsidian 笔记库"
                                          : item.source === "inbox"
                                            ? "微信归纳"
                                            : "收集箱直传"}{" "}
                                        · {Math.max(1, Math.round(item.size / 1024))} KB · 更新于{" "}
                                        {new Date(item.updatedAt).toLocaleString("zh-CN", {
                                          hour12: false,
                                        })}
                                      </Text>
                                    </Flex>
                                  </Flex>

                                  {group.reason === "exact_content" && !item.isPrimary && (
                                    <Tag color="volcano" style={{ margin: 0 }}>
                                      待清理副本
                                    </Tag>
                                  )}
                                </Flex>
                              </List.Item>
                            );
                          }}
                        />
                      </Card>
                    ))}
                  </Flex>
                </div>
              </>
            )}
          </Flex>
        ) : null}
      </Modal>
      <DangerConfirmModal
        open={dedupConfirmOpen}
        title={`确认清理 ${dedupConfirmIds.length} 个重复副本？`}
        impact={`将从本地磁盘与知识库文档清单中移除 ${dedupConfirmIds.length} 个本次扫描确认的相同内容副本。`}
        reversible="不能通过本页面撤回；请确认已选副本不是唯一资料。推荐保留版本不会被清理。"
        duration="通常数秒，期间知识库服务保持运行。"
        acknowledge="我已核对清理数量与保留版本，并确认删除所选副本"
        confirmLabel="清理所选副本"
        busy={dedupCleaning}
        onCancel={() => setDedupConfirmOpen(false)}
        onConfirm={handleExecuteClean}
      />
    </div>
  );
}
