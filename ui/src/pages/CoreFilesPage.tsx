import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from "antd";
import { DownloadOutlined, HistoryOutlined, SaveOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchBlob, loadJson, postJson } from "../lib/api.js";
import { formatBytes, formatTime } from "../lib/format.js";

type Instance = { instanceId: string; frameworkId: string; version: string | null; state: string };
type ManagedFile = {
  fileId: string; instanceId: string; frameworkId: string; key: string; label: string; pathDisplay: string;
  exists: boolean; editable: boolean; readOnlyReason?: string; sizeBytes: number; modifiedAt: string | null;
  sha256: string | null; sensitivity: "normal" | "contains-secret-pattern";
};
type Detail = { file: ManagedFile; content: string };
type Revision = { revisionId: string; createdAt: string; createdBy: string; sha256: string; sizeBytes: number; note?: string };
type Preview = { file: ManagedFile; baseSha256: string; currentSha256: string; changedSinceRead: boolean; diff: string; warnings: string[]; canApply: boolean; blockedReasons: string[] };

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
  useEffect(() => { if (selectedId) void loadDetail(selectedId); }, [selectedId, loadDetail]);
  useEffect(() => {
    if (!detail || draft === detail.content) return;
    try { localStorage.setItem(draftKey(detail.file.instanceId, detail.file.fileId), JSON.stringify({ content: draft, baseSha256: detail.file.sha256 })); } catch { /* no-op */ }
  }, [detail, draft]);

  const selectedInstance = useMemo(() => instances.find((item) => item.instanceId === instanceId), [instances, instanceId]);
  const selectedFile = detail?.file;

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

  return <section className="page core-files-page">
    <header className="core-files-heading">
      <div><Typography.Text type="secondary">智能体与知识</Typography.Text><Typography.Title level={1} className="core-files-title">核心文件</Typography.Title><Typography.Paragraph type="secondary">管理实例声明的 USER、AGENT、SOUL 与 MEMORY Markdown 文件。</Typography.Paragraph></div>
      <Select aria-label="选择实例" className="core-files-instance-select" value={instanceId} placeholder="选择实例" onChange={setInstanceId} options={instances.map((item) => ({ value: item.instanceId, label: `${item.instanceId} · ${item.frameworkId}` }))} />
    </header>
    {selectedInstance && <Alert className="core-files-alert" type="info" showIcon title={`当前实例：${selectedInstance.instanceId}`} description="保存前会先生成版本并校验文件哈希；外部修改会被阻止，避免覆盖 Agent 的最新内容。" />}
    <div className="core-files-layout">
      <Card title="文件清单" styles={{ body: { padding: 0 } }}>
        {loading ? <div className="core-files-loading"><Spin /></div> : files.length === 0 ? <Empty description="没有可管理的核心文件" /> : <ul className="core-files-list">{files.map((file) => <li key={file.fileId} className={`core-files-list-item${file.fileId === selectedId ? " is-selected" : ""}`} onClick={() => setSelectedId(file.fileId)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedId(file.fileId); } }} tabIndex={0} role="button">
          <div className="core-files-list-meta">
            <Space>{file.label}{file.key === "memory" && <Tag>只读</Tag>}{!file.exists && <Tag color="default">不存在</Tag>}</Space>
            <div className="core-files-list-desc"><span>{file.pathDisplay}</span><span>{file.modifiedAt ? formatTime(file.modifiedAt) : "尚未发现"} · {formatBytes(file.sizeBytes)}</span></div>
          </div>
        </li>)}</ul>}
      </Card>
      <Card title={selectedFile?.label ?? "文件详情"} extra={selectedFile && <Space wrap><Button icon={<DownloadOutlined />} onClick={() => void download()} disabled={!selectedFile.exists}>下载</Button><Button icon={<SafetyCertificateOutlined />} onClick={() => void backup()} disabled={!selectedFile.exists}>立即备份</Button><Button icon={<HistoryOutlined />} onClick={() => void openHistory()} disabled={!selectedFile.exists}>历史</Button></Space>}>
        {detailLoading ? <div className="core-files-loading core-files-loading-detail"><Spin /></div> : !selectedFile || !detail ? <Empty description="选择一个文件开始" /> : <>
          {selectedFile.sensitivity === "contains-secret-pattern" && <Alert className="core-files-alert" type="warning" showIcon title="检测到疑似密钥或令牌模式" description="页面不会改写内容；下载前需要再次确认。" />}
          {!selectedFile.editable && <Alert className="core-files-alert" type="info" showIcon title={selectedFile.readOnlyReason ?? "该文件只读"} />}
          <Input.TextArea className="core-files-editor" value={draft} onChange={(event) => setDraft(event.target.value)} autoSize={{ minRows: 18, maxRows: 30 }} readOnly={!selectedFile.editable || !selectedFile.exists} />
          {selectedFile.editable && selectedFile.exists && <div className="core-files-actions"><Button onClick={() => setDraft(detail.content)} disabled={draft === detail.content}>放弃草稿</Button><Button type="primary" icon={<SaveOutlined />} onClick={() => void runPreview()} disabled={draft === detail.content}>预览修改</Button></div>}
          {preview && <Card size="small" title="修改预览" className="core-files-preview"><Space orientation="vertical" className="core-files-preview-space">
            {preview.warnings.map((warning) => <Alert key={warning} type="warning" showIcon title={warning} />)}
            {preview.blockedReasons.map((reason) => <Alert key={reason} type="error" showIcon title={reason} />)}
            <pre className="core-files-diff">{preview.diff}</pre>
            <Button type="primary" onClick={() => Modal.confirm({ title: "确认保存修改？", content: "保存会先备份当前版本，再原子替换源文件。", okText: "确认保存", onOk: apply })} disabled={!preview.canApply}>确认保存</Button>
          </Space></Card>}
        </>}
      </Card>
    </div>
    <Modal title="版本历史" open={historyOpen} onCancel={() => setHistoryOpen(false)} footer={null} width={760}>
      <div className="core-files-history-table"><Table rowKey="revisionId" dataSource={history} pagination={false} scroll={{ x: 620 }} columns={[{ title: "时间", dataIndex: "createdAt", width: 140, render: (value: string) => formatTime(value) }, { title: "来源", dataIndex: "createdBy", width: 120 }, { title: "大小", dataIndex: "sizeBytes", width: 100, align: "right", render: (value: number) => formatBytes(value) }, { title: "备注", dataIndex: "note" }, { title: "操作", width: 88, render: (_: unknown, record: Revision) => <Button danger onClick={() => restore(record)}>恢复</Button> }]} /></div>
    </Modal>
  </section>;
}
