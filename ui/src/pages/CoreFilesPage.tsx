/**
 * 核心文件页：查看 / 编辑 / 预览 / 版本历史 / 备份 / 下载 / 恢复。
 * 数据流（实例与文件加载、草稿哈希基线、预览校验、原子保存）保持原样；
 * 展示层为「市场风」：PageHeader + 工具带（搜索过滤/刷新/备份/下载）
 * + 左栏分组文件卡 + 右栏编辑器大卡，多条 Alert 收敛为单条。
 */
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Empty,
  Flex,
  Input,
  Modal,
  Row,
  Select,
  Spin,
  Table,
  Tag,
  Typography,
} from "antd";
import {
  DownloadOutlined,
  FileMarkdownOutlined,
  HistoryOutlined,
  InfoCircleOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SaveOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "../components/PageHeader.js";
import { fetchBlob, loadJson, postJson } from "../lib/api.js";
import { formatBytes, formatTime } from "../lib/format.js";
import "./core-files.css";

const { Text } = Typography;

type Instance = { instanceId: string; frameworkId: string; version: string | null; state: string };
type ManagedFile = {
  fileId: string; instanceId: string; frameworkId: string; key: string; label: string; pathDisplay: string;
  exists: boolean; editable: boolean; readOnlyReason?: string; sizeBytes: number; modifiedAt: string | null;
  sha256: string | null; sensitivity: "normal" | "contains-secret-pattern";
};
type Detail = { file: ManagedFile; content: string };
type Revision = { revisionId: string; createdAt: string; createdBy: string; sha256: string; sizeBytes: number; note?: string };
type Preview = { file: ManagedFile; baseSha256: string; currentSha256: string; changedSinceRead: boolean; diff: string; warnings: string[]; canApply: boolean; blockedReasons: string[] };

/** 文件 key（后端 markdown-files 仅声明 user/agent/soul/memory）→ 中文分组名。 */
const FILE_GROUP_META: Array<{ key: string; label: string }> = [
  { key: "user", label: "用户档案" },
  { key: "agent", label: "智能体配置" },
  { key: "soul", label: "灵魂设定" },
  { key: "memory", label: "记忆库" },
];

interface FileGroup {
  key: string;
  label: string;
  items: ManagedFile[];
}

const draftKey = (instanceId: string, fileId: string) => `agent-butler:markdown-draft:${instanceId}:${fileId}`;

export function CoreFilesPage() {
  const { message } = App.useApp();
  const [instances, setInstances] = useState<Instance[]>([]);
  const [instanceId, setInstanceId] = useState<string>();
  const [files, setFiles] = useState<ManagedFile[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<Detail>();
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [history, setHistory] = useState<Revision[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  // 工具带：文件搜索为纯前端过滤；detailNonce 让「刷新」在选中文件不变时也重读详情。
  const [keyword, setKeyword] = useState("");
  const [detailNonce, setDetailNonce] = useState(0);

  const loadInstances = useCallback(async () => {
    const result = await loadJson<{ instances: Instance[] }>("/api/instances", 8_000);
    if (!result.ok) { message.error(result.reason); setLoading(false); return; }
    setInstances(result.data.instances ?? []);
    setInstanceId((current) => current && result.data.instances.some((item) => item.instanceId === current) ? current : result.data.instances[0]?.instanceId);
    setLoading(false);
  }, [message]);
  useEffect(() => { void loadInstances(); }, [loadInstances]);

  const loadFiles = useCallback(async () => {
    if (!instanceId) { setFiles([]); setSelectedId(undefined); return; }
    setLoading(true);
    const result = await loadJson<{ files: ManagedFile[] }>(`/api/markdown/files?instanceId=${encodeURIComponent(instanceId)}`, 10_000);
    if (!result.ok) { message.error(result.reason); setFiles([]); setLoading(false); return; }
    setFiles(result.data.files ?? []);
    setSelectedId((current) => current && result.data.files.some((item) => item.fileId === current) ? current : result.data.files[0]?.fileId);
    setLoading(false);
  }, [instanceId, message]);
  useEffect(() => { void loadFiles(); }, [loadFiles]);

  const loadDetail = useCallback(async (fileId: string) => {
    setDetailLoading(true);
    const result = await loadJson<Detail>(`/api/markdown/files/${encodeURIComponent(fileId)}`, 10_000);
    if (!result.ok) { message.error(result.reason); setDetail(undefined); setDetailLoading(false); return; }
    setDetail(result.data);
    let saved = "";
    try {
      const raw = localStorage.getItem(draftKey(result.data.file.instanceId, fileId));
      if (raw !== null) {
        try {
          const parsed = JSON.parse(raw) as { content?: unknown; baseSha256?: unknown };
          if (typeof parsed.content === "string" && parsed.baseSha256 === result.data.file.sha256) saved = parsed.content;
        } catch {
          // 兼容旧版本只保存纯文本草稿，但不让它绕过新的哈希基线。
        }
      }
    } catch { /* 浏览器隐私模式可能禁用存储 */ }
    setDraft(saved === "" ? result.data.content : saved);
    setPreview(undefined);
    setDetailLoading(false);
  }, [message]);
  useEffect(() => { if (selectedId) void loadDetail(selectedId); }, [selectedId, detailNonce, loadDetail]);
  useEffect(() => {
    if (!detail || draft === detail.content) return;
    try { localStorage.setItem(draftKey(detail.file.instanceId, detail.file.fileId), JSON.stringify({ content: draft, baseSha256: detail.file.sha256 })); } catch { /* no-op */ }
  }, [detail, draft]);

  const selectedFile = detail?.file;

  /** 工具带「刷新」：重读文件清单；选中文件不变时也强制重读详情（detailNonce）。 */
  const refresh = useCallback(() => {
    void loadFiles();
    setDetailNonce((nonce) => nonce + 1);
  }, [loadFiles]);

  /** 前端过滤 + 中文分组：按文件真实 key（user/agent/soul/memory）分组，未知 key 归入「其他文件」。 */
  const { filteredFiles, fileGroups } = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    const filtered = kw === ""
      ? files
      : files.filter((file) =>
          [file.label, file.pathDisplay, file.key].some((field) => field.toLowerCase().includes(kw)));
    const groups: FileGroup[] = [];
    for (const meta of FILE_GROUP_META) {
      const items = filtered.filter((file) => file.key === meta.key);
      if (items.length > 0) groups.push({ key: meta.key, label: meta.label, items });
    }
    const others = filtered.filter((file) => !FILE_GROUP_META.some((meta) => meta.key === file.key));
    if (others.length > 0) groups.push({ key: "other", label: "其他文件", items: others });
    return { filteredFiles: filtered, fileGroups: groups };
  }, [files, keyword]);

  const runPreview = async () => {
    if (!selectedFile || selectedFile.sha256 === null) return;
    const result = await postJson(`/api/markdown/files/${encodeURIComponent(selectedFile.fileId)}/preview`, { content: draft, baseSha256: selectedFile.sha256 }, 15_000);
    if (!result.ok) { message.error((result.data as { detail?: string } | null)?.detail ?? "预览失败"); return; }
    setPreview(result.data as Preview);
  };
  const apply = async () => {
    if (!selectedFile || !preview || !preview.canApply) return;
    const result = await postJson(`/api/markdown/files/${encodeURIComponent(selectedFile.fileId)}/apply`, { content: draft, baseSha256: preview.baseSha256, confirmed: true }, 30_000);
    if (!result.ok) { message.error((result.data as { detail?: string } | null)?.detail ?? "保存失败"); return; }
    message.success("核心文件已保存，并已生成可回滚版本。");
    try { localStorage.removeItem(draftKey(selectedFile.instanceId, selectedFile.fileId)); } catch { /* no-op */ }
    setPreview(undefined); await loadFiles(); await loadDetail(selectedFile.fileId);
  };
  const openHistory = async () => {
    if (!selectedFile) return;
    const result = await loadJson<{ revisions: Revision[] }>(`/api/markdown/files/${encodeURIComponent(selectedFile.fileId)}/revisions`, 10_000);
    if (!result.ok) { message.error(result.reason); return; }
    setHistory(result.data.revisions ?? []); setHistoryOpen(true);
  };
  const backup = async () => {
    if (!selectedFile) return;
    const result = await postJson(`/api/markdown/files/${encodeURIComponent(selectedFile.fileId)}/backup`, { note: "核心文件页面手动备份" }, 15_000);
    if (result.ok) { message.success("当前文件版本已备份。"); await openHistory(); }
    else message.error((result.data as { detail?: string } | null)?.detail ?? "备份失败");
  };
  const download = async () => {
    if (!selectedFile) return;
    if (selectedFile.sensitivity === "contains-secret-pattern" && !window.confirm("文件包含疑似密钥或令牌，仍要下载吗？")) return;
    const result = await fetchBlob(`/api/markdown/files/${encodeURIComponent(selectedFile.fileId)}/download`, 20_000);
    if (!result.ok) { message.error(result.reason); return; }
    const url = URL.createObjectURL(result.blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = selectedFile.label; anchor.click(); URL.revokeObjectURL(url);
  };
  const restore = (revision: Revision) => {
    if (!selectedFile || selectedFile.sha256 === null) return;
    Modal.confirm({ title: "恢复这个版本？", content: "恢复前会自动保存当前内容，恢复后可以继续回滚。", okText: "确认恢复", okButtonProps: { danger: true }, onOk: async () => {
      const result = await postJson(`/api/markdown/files/${encodeURIComponent(selectedFile.fileId)}/revisions/${encodeURIComponent(revision.revisionId)}/restore`, { confirmed: true, baseSha256: selectedFile.sha256 }, 30_000);
      if (!result.ok) { message.error((result.data as { detail?: string } | null)?.detail ?? "恢复失败"); return; }
      message.success("已恢复选定版本。"); setHistoryOpen(false); await loadFiles(); await loadDetail(selectedFile.fileId);
    } });
  };

  return (
    <section className="core-files-page">
      <Flex vertical gap={16}>
        <PageHeader
          eyebrow="控制台"
          title="核心文件"
          description="查看、编辑并回滚实例声明的 USER、AGENT、SOUL 与 MEMORY Markdown 文件；每次保存自动生成版本。"
          extra={
            <Select
              aria-label="选择实例"
              style={{ minWidth: 280 }}
              value={instanceId}
              placeholder="选择实例"
              onChange={setInstanceId}
              options={instances.map((item) => ({ value: item.instanceId, label: `${item.instanceId} · ${item.frameworkId}` }))}
            />
          }
        />

        <div className="core-files-toolbar">
          <Input
            className="core-files-toolbar-search"
            allowClear
            aria-label="搜索核心文件"
            prefix={<SearchOutlined style={{ color: "var(--ant-color-text-quaternary)" }} aria-hidden="true" />}
            placeholder="搜索文件名或路径关键词"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
          />
          <div className="core-files-toolbar-actions">
            <Button icon={<ReloadOutlined />} disabled={loading || instanceId === undefined} onClick={refresh}>
              刷新
            </Button>
            <Button icon={<SafetyCertificateOutlined />} disabled={!selectedFile || !selectedFile.exists} onClick={() => void backup()}>
              立即备份
            </Button>
            <Button icon={<DownloadOutlined />} disabled={!selectedFile || !selectedFile.exists} onClick={() => void download()}>
              下载
            </Button>
          </div>
        </div>

        <Row gutter={[16, 16]}>
          <Col xs={24} lg={9}>
            <Card
              size="small"
              title="文件清单"
              styles={{ body: { padding: 0 } }}
              extra={keyword.trim() !== "" ? <Text type="secondary" style={{ fontSize: 12 }}>{filteredFiles.length}/{files.length}</Text> : undefined}
            >
              {loading ? (
                <Flex justify="center" style={{ padding: 24 }}>
                  <Spin />
                </Flex>
              ) : files.length === 0 ? (
                <Empty description="没有可管理的核心文件" />
              ) : filteredFiles.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的文件" />
              ) : (
                <div>
                  {fileGroups.map((group) => (
                    <div key={group.key} className="core-files-group">
                      <div className="core-files-group-head">
                        <Text strong style={{ fontSize: 13 }}>{group.label}</Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>{group.items.length}</Text>
                      </div>
                      <div className="core-files-cards">
                        {group.items.map((file) => {
                          const selected = file.fileId === selectedId;
                          return (
                            <button
                              key={file.fileId}
                              type="button"
                              className={`core-file-card${selected ? " active" : ""}`}
                              aria-pressed={selected}
                              onClick={() => setSelectedId(file.fileId)}
                            >
                              <Flex align="flex-start" gap={10}>
                                <FileMarkdownOutlined className="core-file-card-icon" aria-hidden="true" />
                                <Flex vertical gap={2} style={{ flex: 1, minWidth: 0 }}>
                                  <span className="core-file-card-title">
                                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                      {file.label}
                                    </span>
                                    {file.key === "memory" && <Tag style={{ marginInlineEnd: 0 }}>只读</Tag>}
                                    {!file.exists && <Tag color="default" style={{ marginInlineEnd: 0 }}>不存在</Tag>}
                                  </span>
                                  <span className="core-file-card-path">{file.pathDisplay}</span>
                                  <span className="core-file-card-meta">
                                    {file.modifiedAt ? formatTime(file.modifiedAt) : "尚未发现"} · {formatBytes(file.sizeBytes)}
                                  </span>
                                </Flex>
                              </Flex>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </Col>
          <Col xs={24} lg={15}>
            <Card
              size="small"
              title={selectedFile?.label ?? "文件详情"}
              extra={selectedFile && (
                <Button icon={<HistoryOutlined />} onClick={() => void openHistory()} disabled={!selectedFile.exists}>历史</Button>
              )}
            >
              {detailLoading ? (
                <Flex justify="center" style={{ padding: 40 }}>
                  <Spin />
                </Flex>
              ) : !selectedFile || !detail ? (
                <Empty description="选择一个文件开始" />
              ) : (
                <Flex vertical gap={16}>
                  {(selectedFile.sensitivity === "contains-secret-pattern" || !selectedFile.editable) && (
                    <Alert
                      type={selectedFile.sensitivity === "contains-secret-pattern" ? "warning" : "info"}
                      showIcon
                      message={
                        selectedFile.sensitivity === "contains-secret-pattern"
                          ? "检测到文件中含有疑似密钥内容，已自动打码；保存前请确认。"
                          : selectedFile.readOnlyReason ?? "该文件只读"
                      }
                      description={
                        selectedFile.sensitivity === "contains-secret-pattern" ? (
                          <Flex vertical gap={4}>
                            <span>页面不会改写内容；下载前需要再次确认。</span>
                            {!selectedFile.editable && <span>{selectedFile.readOnlyReason ?? "该文件只读"}</span>}
                          </Flex>
                        ) : undefined
                      }
                    />
                  )}
                  <Input.TextArea
                    style={{ fontFamily: "var(--ant-font-family-code)" }}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    autoSize={{ minRows: 18, maxRows: 30 }}
                    readOnly={!selectedFile.editable || !selectedFile.exists}
                  />
                  {selectedFile.editable && selectedFile.exists && (
                    <Flex justify="flex-end" gap={8}>
                      <Button onClick={() => setDraft(detail.content)} disabled={draft === detail.content}>放弃草稿</Button>
                      <Button type="primary" icon={<SaveOutlined />} onClick={() => void runPreview()} disabled={draft === detail.content}>预览修改</Button>
                    </Flex>
                  )}
                  {preview && (
                    <Card size="small" title="修改预览">
                      <Flex vertical gap={12}>
                        {preview.warnings.length > 0 && (
                          <Alert
                            type="warning"
                            showIcon
                            message="保存前需要确认"
                            description={
                              <Flex vertical gap={4}>
                                {preview.warnings.map((warning) => <span key={warning}>{warning}</span>)}
                              </Flex>
                            }
                          />
                        )}
                        {preview.blockedReasons.length > 0 && (
                          <Alert
                            type="error"
                            showIcon
                            message="本次修改被阻止，暂不能保存"
                            description={
                              <Flex vertical gap={4}>
                                {preview.blockedReasons.map((reason) => <span key={reason}>{reason}</span>)}
                              </Flex>
                            }
                          />
                        )}
                        <pre style={{ maxHeight: 320, margin: 0, overflow: "auto", whiteSpace: "pre-wrap", fontFamily: "var(--ant-font-family-code)", fontSize: 12, lineHeight: 1.6 }}>{preview.diff}</pre>
                        <Button type="primary" onClick={() => Modal.confirm({ title: "确认保存修改？", content: "保存会先备份当前版本，再原子替换源文件。", okText: "确认保存", onOk: apply })} disabled={!preview.canApply}>确认保存</Button>
                      </Flex>
                    </Card>
                  )}
                </Flex>
              )}
            </Card>
            {selectedFile && (
              <div className="core-files-note" style={{ marginTop: 16 }}>
                <InfoCircleOutlined aria-hidden="true" />
                <span>保存前会先生成版本并校验文件哈希；外部修改会被阻止，避免覆盖 Agent 的最新内容。</span>
              </div>
            )}
          </Col>
        </Row>
        <Modal title="版本历史" open={historyOpen} onCancel={() => setHistoryOpen(false)} footer={null} width={760}>
          <Table rowKey="revisionId" dataSource={history} pagination={false} scroll={{ x: 620 }} columns={[{ title: "时间", dataIndex: "createdAt", width: 140, render: (value: string) => formatTime(value) }, { title: "来源", dataIndex: "createdBy", width: 120 }, { title: "大小", dataIndex: "sizeBytes", width: 100, align: "right", render: (value: number) => formatBytes(value) }, { title: "备注", dataIndex: "note" }, { title: "操作", width: 88, render: (_: unknown, record: Revision) => <Button danger onClick={() => restore(record)}>恢复</Button> }]} />
        </Modal>
      </Flex>
    </section>
  );
}
