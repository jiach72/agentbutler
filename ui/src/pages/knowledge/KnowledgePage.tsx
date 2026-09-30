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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Flex,
  Popconfirm,
  Progress,
  Row,
  Space,
  Tabs,
  Tag,
  Tooltip,
  Typography
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  AimOutlined,
  BookOutlined,
  CheckCircleFilled,
  CloudDownloadOutlined,
  CommentOutlined,
  CopyOutlined,
  DeleteOutlined,
  ExclamationCircleOutlined,
  EyeOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  MessageOutlined,
  ReloadOutlined,
  WarningFilled
} from "@ant-design/icons";
import { PageHeader } from "../../components/PageHeader.js";
import { ConclusionBar } from "../../components/ConclusionBar.js";
import { ConnectionChip } from "../../components/ConnectionChip.js";
import { CopySnippetButton } from "../../components/CopySnippetButton.js";
import { deleteJson, loadJson, postJson } from "../../lib/api.js";
import type { KnowledgeStatus } from "../settings/KnowledgeConfigCard.js";
import {
  KnowledgeStarChart,
  type GraphData
} from "./KnowledgeStarChart.js";
import { StartupPanel } from "./StartupPanel.js";
import { VaultTab } from "./tabs/VaultTab.js";
import { QueryTab } from "./tabs/QueryTab.js";
import { ObsidianConfigModal } from "./modals/ObsidianConfigModal.js";
import { DocPreviewDrawer } from "./modals/DocPreviewDrawer.js";
import { DedupModals } from "./modals/DedupModals.js";
import { CreateNoteModal } from "./modals/CreateNoteModal.js";

const { Paragraph, Text, Title } = Typography;


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
  const navigate = useNavigate();
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
  const [docFilter, setDocFilter] = useState("");
  const [docSourceFilter, setDocSourceFilter] = useState<string>("all");
  const [docIngestedFilter, setDocIngestedFilter] = useState<string>("all");
  const [selectedDocIds, setSelectedDocIds] = useState<React.Key[]>([]);
  const [batchDeleting, setBatchDeleting] = useState(false);

  const filteredDocuments = useMemo(() => {
    let list = documents;
    if (docSourceFilter !== "all") {
      list = list.filter((doc) => doc.source === docSourceFilter);
    }
    if (docIngestedFilter === "ingested") {
      list = list.filter((doc) => doc.ingested);
    } else if (docIngestedFilter === "pending") {
      list = list.filter((doc) => !doc.ingested);
    }
    const kw = docFilter.trim().toLowerCase();
    if (kw) {
      list = list.filter((doc) => doc.name.toLowerCase().includes(kw));
    }
    return list;
  }, [docFilter, docSourceFilter, docIngestedFilter, documents]);

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

  // 文档原文预览抽屉内检索关键词与跳转追问
  const [docSearchKeyword, setDocSearchKeyword] = useState("");
  const docSearchMatchCount = useMemo(() => {
    const q = docSearchKeyword.trim();
    if (!q || !previewData?.content) return 0;
    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const matches = previewData.content.match(regex);
    return matches ? matches.length : 0;
  }, [docSearchKeyword, previewData?.content]);

  const handleAskButlerAboutDoc = (
    docName: string,
    scenario: "summary" | "todos" | "audit" | "brief" = "summary",
  ) => {
    let prompt = `请基于本地知识库文档《${docName}》的内容，帮我梳理其核心要点与操作步骤：`;
    if (scenario === "todos") {
      prompt = `请深入梳理本地知识库文档《${docName}》，提取其中列出的所有行动项、任务责任与截止时间待办清单：`;
    } else if (scenario === "audit") {
      prompt = `请作为专业审查员，核对本地知识库文档《${docName}》是否存在潜在风险、未决事项或逻辑漏洞：`;
    } else if (scenario === "brief") {
      prompt = `请将本地知识库文档《${docName}》的内容凝练为一段 200 字以内的即时通讯工作简报：`;
    }
    navigate(`/gateway?tab=im&prefill=${encodeURIComponent(prompt)}`);
  };

  // 自动从预览文档中提取 Markdown 标签（如 #IM工作台、#知识沉淀 等）
  const previewDocTags = useMemo(() => {
    if (!previewData?.content) return [];
    const matches = previewData.content.matchAll(/(?:^|\s)#([a-zA-Z0-9_\u4e00-\u9fa5]+)/g);
    const tags: string[] = [];
    for (const m of matches) {
      if (m[1]) tags.push(`#${m[1]}`);
    }
    return Array.from(new Set(tags)).slice(0, 8);
  }, [previewData?.content]);

  // 按标签快速过滤收集箱资料
  const handleFilterByTag = (tag: string) => {
    setDocFilter(tag);
    setActiveTab("vault");
    setPreviewDrawerOpen(false);
    message.info(`已按标签「${tag}」筛选资料收集箱`);
  };

  // 7. 原生知识问答与语义检索状态
  const [queryInput, setQueryInput] = useState("");
  const [querying, setQuerying] = useState(false);
  const [queryResult, setQueryResult] = useState<{
    query: string;
    answer: string;
    citations: Array<{ docName: string; path: string; snippet: string; score: number }>;
  } | null>(null);
  const [qaCopied, setQaCopied] = useState(false);
  const [copiedSnippetIdx, setCopiedSnippetIdx] = useState<number | null>(null);

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

  // 11. 在线新建私有笔记与知识卡片
  const [createNoteModalOpen, setCreateNoteModalOpen] = useState(false);
  const [newNoteTitle, setNewNoteTitle] = useState("");
  const [newNoteCategory, setNewNoteCategory] = useState("card");
  const [newNoteContent, setNewNoteContent] = useState("");
  const [creatingNote, setCreatingNote] = useState(false);

  const handleCreateNote = async () => {
    if (!newNoteTitle.trim() || !newNoteContent.trim()) {
      message.warning("笔记标题与正文内容不能为空");
      return;
    }
    setCreatingNote(true);
    let finalFilename = newNoteTitle.trim();
    if (!finalFilename.endsWith(".md") && !finalFilename.endsWith(".txt")) {
      finalFilename += ".md";
    }
    const categoryPrefix =
      newNoteCategory === "tech"
        ? "技术架构"
        : newNoteCategory === "idea"
        ? "灵感备忘"
        : newNoteCategory === "sop"
        ? "运维规程"
        : "知识卡片";
    const decoratedContent = `---
type: ${newNoteCategory}
category: ${categoryPrefix}
createdAt: ${new Date().toISOString()}
---

# ${newNoteTitle.replace(/\.(md|txt)$/i, "")}

${newNoteContent}
`;
    try {
      const res = await postJson("/api/knowledge/upload", {
        filename: finalFilename,
        content: decoratedContent,
        encoding: "utf8",
        source: "upload",
      });
      if (res.ok) {
        message.success(`「${finalFilename}」已创建并写入本地知识库！已自动切片入库。`);
        setCreateNoteModalOpen(false);
        setNewNoteTitle("");
        setNewNoteContent("");
        void fetchDocuments();
        void fetchGraph();
      } else {
        message.error("创建笔记失败，请重试");
      }
    } catch (err) {
      message.error(`创建异常: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCreatingNote(false);
    }
  };

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

  // 批量删除选中文档
  const handleBatchDelete = async () => {
    if (selectedDocIds.length === 0) return;
    setBatchDeleting(true);
    let successCount = 0;
    for (const key of selectedDocIds) {
      const id = String(key);
      const res = await deleteJson(`/api/knowledge/documents/${encodeURIComponent(id)}`);
      if (res.ok) successCount++;
    }
    setBatchDeleting(false);
    setSelectedDocIds([]);
    message.success(`已批量删除 ${successCount} 篇资料文档`);
    void fetchDocuments();
    void fetchGraph();
  };

  // 批量在即时通讯中就选中文档发起综合分析
  const handleBatchAskIM = () => {
    if (selectedDocIds.length === 0) return;
    const selectedNames = documents
      .filter((d) => selectedDocIds.includes(d.id))
      .map((d) => `《${d.name}》`)
      .slice(0, 5);
    const docListStr = selectedNames.join("、");
    const prompt = `请基于本地知识库文档 ${docListStr} 的内容，帮我进行综合归纳分析，提炼其核心共性、互补要点与操作建议：`;
    navigate(`/gateway?tab=im&prefill=${encodeURIComponent(prompt)}`);
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
            <FilePdfOutlined style={{ color: "var(--ab-error)", fontSize: 16 }} />
          ) : record.source === "obsidian" ? (
            <BookOutlined style={{ color: "var(--ab-primary)", fontSize: 16 }} />
          ) : record.source === "inbox" ? (
            <MessageOutlined style={{ color: "var(--ab-ok)", fontSize: 16 }} />
          ) : (
            <FileTextOutlined style={{ color: "var(--ab-primary)", fontSize: 16 }} />
          )}
          <Text strong copyable={{ text: name, tooltips: ["复制资料名称", "已复制"] }}>
            {name}
          </Text>
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
      width: 110,
      sorter: (a, b) => a.size - b.size,
      render: (bytes: number) => (
        <Text type="secondary">{Math.max(1, Math.round(bytes / 1024))} KB</Text>
      ),
    },
    {
      title: "入库时间",
      dataIndex: "updatedAt",
      key: "updatedAt",
      width: 170,
      sorter: (a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(),
      defaultSortOrder: "descend",
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
      width: 170,
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="在即时通讯中提问此文档">
            <Button
              size="small"
              type="text"
              icon={<CommentOutlined style={{ color: "var(--ant-color-primary)" }} />}
              onClick={() => handleAskButlerAboutDoc(record.name)}
            />
          </Tooltip>
          <Tooltip title="复制知识库引用标签 ([参考本地知识库: 《...》])">
            <Button
              size="small"
              type="text"
              icon={<BookOutlined style={{ color: "var(--ant-color-primary)" }} />}
              onClick={() => {
                const refTag = `[参考本地知识库: 《${record.name}》]`;
                void navigator.clipboard.writeText(refTag);
                message.success(`已复制引用标签: ${refTag}`);
              }}
            />
          </Tooltip>
          <Tooltip title="在线预览文档内容">
            <Button
              size="small"
              type="text"
              icon={<EyeOutlined style={{ color: "var(--ant-color-primary)" }} />}
              onClick={() => handleOpenPreview(record)}
            />
          </Tooltip>
          <Tooltip title="复制文档路径/名称">
            <Button
              size="small"
              type="text"
              icon={<CopyOutlined />}
              onClick={() => {
                void navigator.clipboard.writeText(record.path || record.name);
                message.success("已复制文档路径");
              }}
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
            <Flex align="center" gap={8} wrap="wrap">
              <ConnectionChip
                reachable={isRunning}
                onlineText="知识库服务在线 (:3001)"
                offlineText={isEnabled ? "等待知识库容器响应" : "本地知识库未开启"}
              />
              <Tooltip title="前往即时通讯工作台（向智能体下达指令、多 Bot 协同问答）">
                <Button
                  size="small"
                  icon={<MessageOutlined style={{ color: "var(--ab-primary)" }} />}
                  onClick={() => navigate("/gateway?tab=im")}
                >
                  即时通讯工作台
                </Button>
              </Tooltip>
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

        {/* 1+2. 状态结论条（设计评审 D-1）：全绿状态收敛为一条紧凑结论条，异常态各自完整展开 */}
        {embeddingStatus?.ready && isRunning ? (
          <ConclusionBar
            tone="ok"
            title="本地知识库正常运行中"
            extra={
              <span>
                Embedding 模型 {embeddingStatus.activeModel || "nomic-embed-text:latest"} 已挂载生效 ·
                文档自动切片并向量化，供智能体随时检索与推理
              </span>
            }
          />
        ) : (
          <>
            {/* 1. Embedding 模型缺失智能检测、拉取进度与就绪提示栏 */}
            {embeddingStatus && embeddingStatus.ready ? (
          <Alert
            type="success"
            showIcon
            title={
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
              title={
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
                <Flex vertical gap={8} style={{ width: "100%", marginTop: 8 }}>
                  <Progress
                    percent={embeddingStatus.pullProgress?.percent ?? 0}
                    status="active"
                    strokeColor={{ from: "#108ee9", to: "#52c41a" }}
                  />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    当前阶段：{embeddingStatus.pullProgress?.status || "正在建立流式数据连接..."}
                  </Text>
                </Flex>
              }
              style={{ borderRadius: 8 }}
            />
          ) : (
            <Alert
              type="warning"
              showIcon
              icon={<WarningFilled style={{ color: "var(--ant-color-warning)", fontSize: 18 }} />}
              title={
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
              style={{ borderRadius: 8 }}
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
          </>
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
                  <VaultTab
                    message={message}
                    documents={documents}
                    filteredDocuments={filteredDocuments}
                    docsLoading={docsLoading}
                    documentColumns={documentColumns}
                    docFilter={docFilter}
                    setDocFilter={setDocFilter}
                    docSourceFilter={docSourceFilter}
                    setDocSourceFilter={setDocSourceFilter}
                    docIngestedFilter={docIngestedFilter}
                    setDocIngestedFilter={setDocIngestedFilter}
                    selectedDocIds={selectedDocIds}
                    setSelectedDocIds={setSelectedDocIds}
                    batchDeleting={batchDeleting}
                    handleBatchAskIM={handleBatchAskIM}
                    handleBatchDelete={handleBatchDelete}
                    obsidianConfig={obsidianConfig}
                    setObsidianModalOpen={setObsidianModalOpen}
                    vaultSync={vaultSync}
                    setVaultSync={setVaultSync}
                    syncingObsidian={syncingObsidian}
                    handleSyncObsidian={handleSyncObsidian}
                    folderInputRef={folderInputRef}
                    handleFolderPicked={handleFolderPicked}
                    inboxFiles={inboxFiles}
                    inboxLoading={inboxLoading}
                    ingestingInbox={ingestingInbox}
                    fetchInbox={fetchInbox}
                    handleIngestInbox={handleIngestInbox}
                    handleOpenDedupModal={handleOpenDedupModal}
                    setCreateNoteModalOpen={setCreateNoteModalOpen}
                    fetchDocuments={fetchDocuments}
                    fetchGraph={fetchGraph}
                  />
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
                  <QueryTab
                    queryInput={queryInput}
                    setQueryInput={setQueryInput}
                    handleRunQuery={handleRunQuery}
                    querying={querying}
                    queryResult={queryResult}
                    documents={documents}
                    handleOpenPreview={handleOpenPreview}
                    copiedSnippetIdx={copiedSnippetIdx}
                    setCopiedSnippetIdx={setCopiedSnippetIdx}
                    message={message}
                    qaCopied={qaCopied}
                    setQaCopied={setQaCopied}
                  />
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
          <StartupPanel
            startupProgress={startupProgress}
            currentStep={currentStep}
            launchingInWeb={launchingInWeb}
            handleLaunchInWeb={handleLaunchInWeb}
            terminalBottomRef={terminalBottomRef}
          />
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
                    background: "var(--ab-primary-soft)",
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
                        <BookOutlined style={{ marginRight: 6, color: "var(--ab-primary)" }} />
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
                        <AimOutlined style={{ marginRight: 6, color: "var(--ab-brand)" }} />
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

      <ObsidianConfigModal
        obsidianModalOpen={obsidianModalOpen}
        handleSaveObsidianConfig={handleSaveObsidianConfig}
        setObsidianModalOpen={setObsidianModalOpen}
        setTestPathResult={setTestPathResult}
        obsidianPathInput={obsidianPathInput}
        setObsidianPathInput={setObsidianPathInput}
        handleTestPath={handleTestPath}
        testingPath={testingPath}
        testPathResult={testPathResult}
      />

      <DocPreviewDrawer
        previewDrawerOpen={previewDrawerOpen}
        setPreviewDrawerOpen={setPreviewDrawerOpen}
        setDocSearchKeyword={setDocSearchKeyword}
        previewLoading={previewLoading}
        previewData={previewData}
        previewDocTags={previewDocTags}
        docSearchKeyword={docSearchKeyword}
        docSearchMatchCount={docSearchMatchCount}
        handleAskButlerAboutDoc={handleAskButlerAboutDoc}
        handleFilterByTag={handleFilterByTag}
        message={message}
      />

      <DedupModals
        dedupModalOpen={dedupModalOpen}
        setDedupModalOpen={setDedupModalOpen}
        dedupScanning={dedupScanning}
        dedupCleaning={dedupCleaning}
        dedupResult={dedupResult}
        selectedRemoveIds={selectedRemoveIds}
        setSelectedRemoveIds={setSelectedRemoveIds}
        handleRequestDedupClean={handleRequestDedupClean}
        dedupConfirmOpen={dedupConfirmOpen}
        dedupConfirmIds={dedupConfirmIds}
        setDedupConfirmOpen={setDedupConfirmOpen}
        handleExecuteClean={handleExecuteClean}
      />

      <CreateNoteModal
        createNoteModalOpen={createNoteModalOpen}
        setCreateNoteModalOpen={setCreateNoteModalOpen}
        creatingNote={creatingNote}
        handleCreateNote={handleCreateNote}
        newNoteTitle={newNoteTitle}
        setNewNoteTitle={setNewNoteTitle}
        newNoteCategory={newNoteCategory}
        setNewNoteCategory={setNewNoteCategory}
        newNoteContent={newNoteContent}
        setNewNoteContent={setNewNoteContent}
      />
    </div>
  );
}
