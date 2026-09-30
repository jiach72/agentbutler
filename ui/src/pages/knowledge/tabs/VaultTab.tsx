/**
 * 原生资料收集箱 Tab（F-3 拆分自 KnowledgePage，JSX 原样搬移）。
 * 文档/收件箱/Obsidian 同步状态与逻辑仍在 KnowledgePage，经 props 注入；
 * prop 名与拆分前的局部标识符保持一致，保证 JSX 零改动。
 */
import type { ChangeEvent, Key, RefObject } from "react";
import {
  Alert,
  Button,
  Card,
  Col,
  Flex,
  Input,
  Popconfirm,
  Progress,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Upload,
} from "antd";
import { Typography } from "antd";
import type { MessageInstance } from "antd/es/message/interface";
import type { ColumnsType } from "antd/es/table";
import {
  BookOutlined,
  ClearOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  FileDoneOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  InboxOutlined,
  MessageOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import { postJson } from "../../../lib/api.js";
import { Empty as ButlerEmpty } from "../../../components/Empty.js";
import type { InboxFile, KnowledgeDocument, ObsidianConfig, VaultSyncProgress } from "../KnowledgePage.js";

const { Text } = Typography;

export interface VaultTabProps {
  message: MessageInstance;
  documents: KnowledgeDocument[];
  filteredDocuments: KnowledgeDocument[];
  docsLoading: boolean;
  documentColumns: ColumnsType<KnowledgeDocument>;
  docFilter: string;
  setDocFilter: (value: string) => void;
  docSourceFilter: string;
  setDocSourceFilter: (value: string) => void;
  docIngestedFilter: string;
  setDocIngestedFilter: (value: string) => void;
  selectedDocIds: Key[];
  setSelectedDocIds: (keys: Key[]) => void;
  batchDeleting: boolean;
  handleBatchAskIM: () => void;
  handleBatchDelete: () => void;
  obsidianConfig: ObsidianConfig | null;
  setObsidianModalOpen: (open: boolean) => void;
  vaultSync: VaultSyncProgress | null;
  setVaultSync: (value: VaultSyncProgress | null) => void;
  syncingObsidian: boolean;
  handleSyncObsidian: () => void;
  folderInputRef: RefObject<HTMLInputElement | null>;
  handleFolderPicked: (event: ChangeEvent<HTMLInputElement>) => void;
  inboxFiles: InboxFile[];
  inboxLoading: boolean;
  ingestingInbox: boolean;
  fetchInbox: () => Promise<void>;
  handleIngestInbox: (ids?: string[]) => void;
  handleOpenDedupModal: () => void;
  setCreateNoteModalOpen: (open: boolean) => void;
  fetchDocuments: () => Promise<void>;
  fetchGraph: () => Promise<void>;
}

export function VaultTab({
  message,
  documents,
  filteredDocuments,
  docsLoading,
  documentColumns,
  docFilter,
  setDocFilter,
  docSourceFilter,
  setDocSourceFilter,
  docIngestedFilter,
  setDocIngestedFilter,
  selectedDocIds,
  setSelectedDocIds,
  batchDeleting,
  handleBatchAskIM,
  handleBatchDelete,
  obsidianConfig,
  setObsidianModalOpen,
  vaultSync,
  setVaultSync,
  syncingObsidian,
  handleSyncObsidian,
  folderInputRef,
  handleFolderPicked,
  inboxFiles,
  inboxLoading,
  ingestingInbox,
  fetchInbox,
  handleIngestInbox,
  handleOpenDedupModal,
  setCreateNoteModalOpen,
  fetchDocuments,
  fetchGraph,
}: VaultTabProps) {
  return (
    <Flex vertical gap={20}>
      {/* A. 直接拖拽上传区 (免跳转闭环) */}
      <Card
        title={
          <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
            <Flex align="center" gap={8}>
              <CloudUploadOutlined style={{ color: "var(--ant-color-primary)" }} />
              <span>极简资料投递与收集（支持 PDF / Word / TXT / Markdown / 表格）</span>
            </Flex>
            <Button
              type="primary"
              size="small"
              icon={<PlusOutlined />}
              onClick={() => setCreateNoteModalOpen(true)}
            >
              新建私有笔记/卡片
            </Button>
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
                  <BookOutlined style={{ color: "var(--ab-primary)" }} />
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
                    background: "var(--ab-primary-soft)",
                    border: "1px solid var(--ab-primary-soft-border)",
                  }}
                >
                  <Flex justify="space-between" align="center" style={{ marginBottom: 6 }}>
                    <Flex align="center" gap={6}>
                      <SyncOutlined spin style={{ color: "var(--ab-primary)" }} />
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
                  title={vaultSync.phaseLabel}
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
                  <MessageOutlined style={{ color: "var(--ab-ok)" }} />
                  <span>微信传输与聊天附件归纳箱 (WeChat / IM)</span>
                </Flex>
                <Flex align="center" gap={6}>
                  <Tag color={inboxFiles.filter(f => !f.ingested).length > 0 ? "warning" : "green"}>
                    {inboxFiles.filter(f => !f.ingested).length} 个待入库
                  </Tag>
                  <Button
                    size="small"
                    type="text"
                    icon={<ReloadOutlined />}
                    loading={inboxLoading}
                    onClick={() => void fetchInbox()}
                    aria-label="刷新微信传输归纳箱"
                  />
                </Flex>
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
                          <FilePdfOutlined style={{ color: "var(--ab-error)" }} />
                        ) : (
                          <FileTextOutlined style={{ color: "var(--ab-ok)" }} />
                        )}
                        <Text
                          ellipsis
                          style={{ maxWidth: 220 }}
                          title={f.filename}
                          copyable={{ text: f.filename, tooltips: ["复制文件名", "已复制"] }}
                        >
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
          <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
            <Flex align="center" gap={8}>
              <FileDoneOutlined style={{ color: "var(--ant-color-primary)" }} />
              <span>已收集资料清单与索引状态</span>
              {documents.length > 0 && (
                <Tag style={{ margin: 0 }}>
                  显示 {filteredDocuments.length} / {documents.length}
                </Tag>
              )}
            </Flex>
            <Flex align="center" gap={8} wrap="wrap">
              {/* 快捷过滤芯片 */}
              <Flex align="center" gap={4} wrap="wrap">
                <Tag.CheckableTag
                  checked={docSourceFilter === "all" && docIngestedFilter === "all" && !docFilter}
                  onChange={() => {
                    setDocSourceFilter("all");
                    setDocIngestedFilter("all");
                    setDocFilter("");
                  }}
                >
                  全部
                </Tag.CheckableTag>
                <Tag.CheckableTag
                  checked={docFilter === "知识卡片"}
                  onChange={(checked) => {
                    setDocFilter(checked ? "知识卡片" : "");
                  }}
                >
                  🔖 知识卡片
                </Tag.CheckableTag>
                <Tag.CheckableTag
                  checked={docFilter === "技术架构"}
                  onChange={(checked) => {
                    setDocFilter(checked ? "技术架构" : "");
                  }}
                >
                  📓 技术架构
                </Tag.CheckableTag>
                <Tag.CheckableTag
                  checked={docFilter === "灵感备忘"}
                  onChange={(checked) => {
                    setDocFilter(checked ? "灵感备忘" : "");
                  }}
                >
                  💡 灵感备忘
                </Tag.CheckableTag>
                <Tag.CheckableTag
                  checked={docFilter === "运维规程"}
                  onChange={(checked) => {
                    setDocFilter(checked ? "运维规程" : "");
                  }}
                >
                  📋 运维规程
                </Tag.CheckableTag>
                <Tag.CheckableTag
                  checked={docSourceFilter === "obsidian"}
                  onChange={(checked) => {
                    setDocSourceFilter(checked ? "obsidian" : "all");
                  }}
                >
                  📓 Obsidian
                </Tag.CheckableTag>
                <Tag.CheckableTag
                  checked={docSourceFilter === "inbox"}
                  onChange={(checked) => {
                    setDocSourceFilter(checked ? "inbox" : "all");
                  }}
                >
                  💬 聊天归档
                </Tag.CheckableTag>
                <Tag.CheckableTag
                  checked={docIngestedFilter === "pending"}
                  onChange={(checked) => {
                    setDocIngestedFilter(checked ? "pending" : "all");
                  }}
                >
                  ⏳ 待切片
                </Tag.CheckableTag>
              </Flex>

              <Input
                placeholder="搜索资料名称..."
                prefix={<SearchOutlined style={{ color: "var(--ab-text-3)" }} />}
                allowClear
                value={docFilter}
                onChange={(e) => setDocFilter(e.target.value)}
                style={{ minWidth: 150, maxWidth: 220, flex: 1 }}
                size="small"
              />
              <Select
                size="small"
                value={docSourceFilter}
                onChange={setDocSourceFilter}
                style={{ width: 120 }}
                options={[
                  { label: "全部来源", value: "all" },
                  { label: "本地上传", value: "upload" },
                  { label: "Obsidian 笔记", value: "obsidian" },
                  { label: "微信/聊天归档", value: "inbox" },
                ]}
              />
              <Select
                size="small"
                value={docIngestedFilter}
                onChange={setDocIngestedFilter}
                style={{ width: 110 }}
                options={[
                  { label: "全部状态", value: "all" },
                  { label: "已向量化", value: "ingested" },
                  { label: "就绪待分段", value: "pending" },
                ]}
              />
              <Button
                size="small"
                icon={<ClearOutlined />}
                onClick={handleOpenDedupModal}
                style={{
                  background: "var(--ab-warn-soft)",
                  borderColor: "color-mix(in srgb, var(--ab-warn) 40%, transparent)",
                  color: "var(--ab-warn)",
                }}
              >
                智能去重
              </Button>
              <Button
                size="small"
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => setCreateNoteModalOpen(true)}
              >
                新建笔记
              </Button>
              <Button size="small" icon={<ReloadOutlined />} onClick={fetchDocuments} />
            </Flex>
          </Flex>
        }
        size="small"
        style={{ borderRadius: 10 }}
      >
        {selectedDocIds.length > 0 && (
          <div
            style={{
              padding: "8px 12px",
              marginBottom: 12,
              borderRadius: 8,
              background: "var(--ab-primary-soft, #e6f4ff)",
              border: "1px solid var(--ab-primary-soft-border, #91caff)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            <Space align="center">
              <Text strong style={{ color: "var(--ab-primary, #0071e3)" }}>
                已选中 {selectedDocIds.length} 篇资料
              </Text>
              <Button size="small" type="link" onClick={() => setSelectedDocIds([])}>
                取消选择
              </Button>
            </Space>
            <Space align="center" wrap>
              <Button
                size="small"
                type="primary"
                ghost
                icon={<MessageOutlined />}
                onClick={handleBatchAskIM}
              >
                在即时通讯中综合提问
              </Button>
              <Popconfirm
                title={`确定批量删除选中的 ${selectedDocIds.length} 篇资料？`}
                description="删除后将从本地知识库收集箱中彻底移除对应文档与向量索引。"
                onConfirm={handleBatchDelete}
                okText="批量删除"
                okButtonProps={{ danger: true }}
                cancelText="取消"
              >
                <Button size="small" danger icon={<DeleteOutlined />} loading={batchDeleting}>
                  批量删除 ({selectedDocIds.length})
                </Button>
              </Popconfirm>
            </Space>
          </div>
        )}
        <Table<KnowledgeDocument>
          rowKey="id"
          rowSelection={{
            selectedRowKeys: selectedDocIds,
            onChange: (keys) => setSelectedDocIds(keys),
          }}
          columns={documentColumns}
          dataSource={filteredDocuments}
          loading={docsLoading}
          pagination={{
            pageSize: 8,
            showSizeChanger: true,
            pageSizeOptions: ["8", "16", "32", "64"],
            showTotal: (total) => `共 ${total} 篇资料`,
          }}
          size="small"
          locale={{
            emptyText: (
              <ButlerEmpty
                mascot={false}
                title={
                  docFilter.trim() || docSourceFilter !== "all" || docIngestedFilter !== "all"
                    ? "未找到符合筛选条件的资料文档"
                    : "尚未收集任何资料文档"
                }
                hint={
                  docFilter.trim() || docSourceFilter !== "all" || docIngestedFilter !== "all"
                    ? "可以尝试更换检索关键词或调整来源/状态过滤条件，或点击下方按钮清空筛选。"
                    : "可直接将 Markdown、PDF、Word 或 TXT 文件拖拽至上方投递框，即可完成入库切片与私有问答。"
                }
                action={
                  docFilter.trim() || docSourceFilter !== "all" || docIngestedFilter !== "all" ? (
                    <Button
                      size="small"
                      onClick={() => {
                        setDocFilter("");
                        setDocSourceFilter("all");
                        setDocIngestedFilter("all");
                      }}
                    >
                      重置全部筛选
                    </Button>
                  ) : undefined
                }
              />
            ),
          }}
        />
      </Card>
    </Flex>
  );
}
