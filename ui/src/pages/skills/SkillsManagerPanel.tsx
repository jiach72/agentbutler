/** 技能库管理器面板：对齐 skills-manager CLI 的市场、标签、批量与 Git 源能力。 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Drawer,
  Dropdown,
  Empty,
  Flex,
  Input,
  List,
  Modal,
  Select,
  Statistic,
  Table,
  Tag,
  Typography,
} from "antd";
import {
  CloudDownloadOutlined,
  EyeOutlined,
  FolderOpenOutlined,
  LinkOutlined,
  MoreOutlined,
  ReloadOutlined,
  SearchOutlined,
  TagsOutlined,
} from "@ant-design/icons";
import { loadJson, postJson } from "../../lib/api.js";
import type { FetchState } from "../../lib/api.js";

interface SkillsManagerSkill {
  name: string;
  skill_id?: string;
  description?: string;
  source_type?: string;
  source_ref?: string;
  tags?: string[];
  [key: string]: unknown;
}
interface SkillsManagerStatusOk {
  available: true;
  cli: { path: string; version: string };
  repo: Record<string, unknown>;
  skills: SkillsManagerSkill[];
  deployTarget?: { agent: string; dir: string; symlinked: boolean };
  hermesSkillsDir?: string;
}
type SkillsManagerStatus = SkillsManagerStatusOk | { available: false; installHint?: string };
interface UpdateCheckItem {
  name?: string;
  skill_id?: string;
  update_status?: string | null;
  last_check_error?: string | null;
  [key: string]: unknown;
}
interface SearchResult {
  install_ref?: string;
  name?: string;
  source?: string;
  skill_id?: string;
  installs?: number;
  [key: string]: unknown;
}
interface PendingAction {
  title: string;
  op: "deploy" | "undeploy" | "remove";
  payload: Record<string, unknown>;
  preview: unknown;
}
interface SourceDraft {
  name: string;
  gitUrl: string;
  subpath: string;
  branch: string;
  force: boolean;
}

const DEPLOY_AGENT = "claude_code";
const ACTION_TIMEOUT_MS = 120_000;
function deployedToTarget(item: SkillsManagerSkill): boolean {
  const deployedTo = item["deployed_to"];
  if (Array.isArray(deployedTo)) return deployedTo.includes(DEPLOY_AGENT);
  return item["deployed"] === true;
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
function extractError(data: unknown): string {
  if (data !== null && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (typeof record["installHint"] === "string" && record["installHint"] !== "")
      return record["installHint"];
    const code = typeof record["code"] === "string" ? record["code"] : null;
    if (typeof record["message"] === "string" && record["message"] !== "")
      return code === null ? record["message"] : `${code}：${record["message"]}`;
    if (typeof record["error"] === "string" && record["error"] !== "") return record["error"];
  }
  return "操作失败，请稍后重试或查看管家日志。";
}
function previewEntries(preview: unknown): Array<[string, string]> {
  if (preview === null || typeof preview !== "object") return [];
  const labels: Record<string, string> = {
    action: "动作",
    dry_run: "试运行",
    name: "名称",
    skill_count: "技能数",
    pair_count: "部署对数",
    changed_pairs: "将变更",
    message: "说明",
  };
  const record = preview as Record<string, unknown>;
  return Object.entries(labels).flatMap(([key, label]) => {
    const value = record[key];
    return value === undefined || value === null
      ? []
      : [[label, typeof value === "object" ? JSON.stringify(value) : String(value)]];
  });
}
function updateStatusLabel(status: string | null | undefined): {
  text: string;
  color?: "success" | "warning" | "error" | "default";
} {
  if (status === "up_to_date") return { text: "已是最新", color: "success" };
  if (status === "local_only") return { text: "本地来源" };
  if (!status) return { text: "未检查" };
  if (status === "skipped") return { text: "已跳过" };
  return { text: "有可用更新", color: "warning" };
}
function hasAvailableUpdate(item: UpdateCheckItem | undefined): boolean {
  const status = item?.update_status;
  return (
    typeof status === "string" &&
    status !== "" &&
    !["up_to_date", "skipped", "local_only"].includes(status)
  );
}

export function SkillsManagerPanel() {
  const { message } = App.useApp();
  const [state, setState] = useState<FetchState<SkillsManagerStatus>>({ status: "loading" });
  const [updates, setUpdates] = useState<Record<string, UpdateCheckItem>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [installSource, setInstallSource] = useState("");
  const [installName, setInstallName] = useState("");
  const [installBusy, setInstallBusy] = useState(false);
  const [adoptBusy, setAdoptBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const [batchResults, setBatchResults] = useState<Array<{
    name?: string;
    ok?: boolean;
    error?: { message?: string };
  }> | null>(null);
  const [keyword, setKeyword] = useState("");
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [sourceFilter, setSourceFilter] = useState<string | undefined>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [detailName, setDetailName] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ show: unknown; status: unknown } | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [tagBusy, setTagBusy] = useState(false);
  const [sourceDraft, setSourceDraft] = useState<SourceDraft | null>(null);
  const [sourcePreview, setSourcePreview] = useState<unknown>(null);
  const [sourceConfirming, setSourceConfirming] = useState(false);
  const [updateAllBusy, setUpdateAllBusy] = useState(false);

  const loadAll = useCallback(async (options?: { silent?: boolean }) => {
    if (options?.silent !== true) setState({ status: "loading" });
    setRefreshing(true);
    const [statusResult, updatesResult] = await Promise.all([
      loadJson<SkillsManagerStatus>("/api/skills-manager/status", 15_000),
      loadJson<UpdateCheckItem[]>("/api/skills-manager/updates", 15_000),
    ]);
    setRefreshing(false);
    if (!statusResult.ok) {
      setState({ status: "failed", reason: statusResult.reason });
      return;
    }
    setState({ status: "ready", data: statusResult.data });
    const map: Record<string, UpdateCheckItem> = {};
    if (updatesResult.ok && Array.isArray(updatesResult.data))
      for (const item of updatesResult.data) {
        const key = item.name ?? item.skill_id;
        if (typeof key === "string" && key !== "") map[key] = item;
      }
    setUpdates(map);
  }, []);
  useEffect(() => {
    void loadAll();
  }, [loadAll]);
  const skills = state.status === "ready" && state.data.available ? (state.data.skills ?? []) : [];
  const tags = useMemo(
    () => [...new Set(skills.flatMap((item) => stringArray(item.tags ?? item["tags"])))].sort(),
    [skills],
  );
  const filteredSkills = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    return skills.filter((item) => {
      const itemTags = stringArray(item.tags ?? item["tags"]);
      const text =
        `${item.name} ${typeof item.description === "string" ? item.description : ""}`.toLowerCase();
      return (
        (!q || text.includes(q)) &&
        (!sourceFilter || item.source_type === sourceFilter) &&
        tagFilter.every((tag) => itemTags.includes(tag))
      );
    });
  }, [keyword, skills, sourceFilter, tagFilter]);
  const beginAction = async (
    op: PendingAction["op"],
    title: string,
    payload: Record<string, unknown>,
  ) => {
    const result = await postJson(`/api/skills-manager/${op}`, payload, ACTION_TIMEOUT_MS);
    if (!result.ok) {
      message.error(extractError(result.data));
      return;
    }
    setPending({ title, op, payload, preview: result.data });
  };
  const confirmPending = async () => {
    if (!pending || confirming) return;
    setConfirming(true);
    const result = await postJson(
      `/api/skills-manager/${pending.op}`,
      { ...pending.payload, confirmed: true },
      ACTION_TIMEOUT_MS,
    );
    setConfirming(false);
    if (!result.ok) {
      message.error(extractError(result.data));
      return;
    }
    const body = result.data as {
      batch?: boolean;
      results?: Array<{ name?: string; ok?: boolean; error?: { message?: string } }>;
    };
    if (body.batch && Array.isArray(body.results)) {
      setBatchResults(body.results);
      const failed = body.results.filter((item) => item.ok !== true).length;
      if (failed > 0)
        message.warning(`批量完成：${body.results.length - failed} 成功，${failed} 失败。`);
      else message.success("批量操作完成。");
    } else message.success("操作已完成。");
    setPending(null);
    setSelectedNames([]);
    void loadAll({ silent: true });
  };
  const beginInstall = async (
    source = installSource,
    name = installName,
    sourceType?: "skills" | "git" | "local",
  ) => {
    const cleanSource = source.trim();
    if (!cleanSource) {
      message.warning("请填写技能来源。");
      return;
    }
    setInstallBusy(true);
    const result = await postJson(
      "/api/skills-manager/install",
      {
        source: cleanSource,
        confirmed: true,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(sourceType ? { sourceType } : {}),
      },
      ACTION_TIMEOUT_MS,
    );
    setInstallBusy(false);
    if (!result.ok) {
      message.error(extractError(result.data));
      return;
    }
    message.success("技能已安装到中央库。");
    setInstallSource("");
    setInstallName("");
    setSearchOpen(false);
    void loadAll({ silent: true });
  };
  const searchMarket = async () => {
    const query = searchQuery.trim();
    if (!query) {
      message.warning("请输入市场搜索关键词。");
      return;
    }
    setSearchBusy(true);
    const result = await loadJson<SearchResult[]>(
      `/api/skills-manager/search?query=${encodeURIComponent(query)}`,
      120_000,
    );
    setSearchBusy(false);
    if (!result.ok) {
      message.error(result.reason);
      return;
    }
    setSearchResults(Array.isArray(result.data) ? result.data : []);
  };
  const openDetail = async (name: string) => {
    setDetailName(name);
    setDetail(null);
    setDetailBusy(true);
    const result = await loadJson<{ show: unknown; status: unknown }>(
      `/api/skills-manager/skills/${encodeURIComponent(name)}`,
      30_000,
    );
    setDetailBusy(false);
    if (!result.ok) {
      message.error(result.reason);
      return;
    }
    setDetail(result.data);
  };
  const updateTags = async (action: "add" | "remove" | "set") => {
    if (!detailName) return;
    const next = tagDraft
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (next.length === 0) {
      message.warning("请填写至少一个标签，多个标签用逗号分隔。");
      return;
    }
    setTagBusy(true);
    const result = await postJson(
      "/api/skills-manager/tags",
      { action, name: detailName, tags: next },
      30_000,
    );
    setTagBusy(false);
    if (!result.ok) {
      message.error(extractError(result.data));
      return;
    }
    message.success("标签已更新。");
    setTagDraft("");
    const refreshed = await loadJson<{ show: unknown; status: unknown }>(
      `/api/skills-manager/skills/${encodeURIComponent(detailName)}`,
      30_000,
    );
    if (refreshed.ok) setDetail(refreshed.data);
    void loadAll({ silent: true });
  };
  const previewSource = async () => {
    if (!sourceDraft) return;
    if (!sourceDraft.gitUrl.trim()) {
      message.warning("Git 地址不能为空。");
      return;
    }
    const payload = {
      name: sourceDraft.name,
      gitUrl: sourceDraft.gitUrl.trim(),
      ...(sourceDraft.subpath.trim() ? { subpath: sourceDraft.subpath.trim() } : {}),
      ...(sourceDraft.branch.trim() ? { branch: sourceDraft.branch.trim() } : {}),
      ...(sourceDraft.force ? { force: true } : {}),
    };
    const result = await postJson("/api/skills-manager/set-source", payload, ACTION_TIMEOUT_MS);
    if (!result.ok) {
      message.error(extractError(result.data));
      return;
    }
    setSourcePreview(result.data);
  };
  const confirmSource = async () => {
    if (!sourceDraft) return;
    setSourceConfirming(true);
    const result = await postJson(
      "/api/skills-manager/set-source",
      {
        name: sourceDraft.name,
        gitUrl: sourceDraft.gitUrl.trim(),
        ...(sourceDraft.subpath.trim() ? { subpath: sourceDraft.subpath.trim() } : {}),
        ...(sourceDraft.branch.trim() ? { branch: sourceDraft.branch.trim() } : {}),
        ...(sourceDraft.force ? { force: true } : {}),
        confirmed: true,
      },
      ACTION_TIMEOUT_MS,
    );
    setSourceConfirming(false);
    if (!result.ok) {
      message.error(extractError(result.data));
      return;
    }
    message.success("Git 源绑定完成。");
    setSourceDraft(null);
    setSourcePreview(null);
    void loadAll({ silent: true });
  };
  const updateAll = async () => {
    if (updateAllBusy) return;
    setUpdateAllBusy(true);
    const deployed = skills.filter(deployedToTarget).map((item) => item.name);
    const result = await postJson("/api/skills-manager/update", { all: true }, ACTION_TIMEOUT_MS);
    if (!result.ok) {
      setUpdateAllBusy(false);
      message.error(extractError(result.data));
      return;
    }
    let failed = 0;
    for (const name of deployed) {
      const redeploy = await postJson(
        "/api/skills-manager/deploy",
        { name, confirmed: true },
        ACTION_TIMEOUT_MS,
      );
      if (!redeploy.ok) failed += 1;
    }
    setUpdateAllBusy(false);
    if (failed > 0) message.warning(`全部更新完成，但 ${failed} 个已部署技能重新部署失败。`);
    else message.success("已更新全部技能，并同步重新部署原有部署项。");
    void loadAll({ silent: true });
  };
  const adoptLocalSkills = async () => {
    if (adoptBusy || !hermesSkillsDir) return;
    setAdoptBusy(true);
    const preview = await postJson(
      "/api/skills-manager/adopt",
      { dir: hermesSkillsDir },
      ACTION_TIMEOUT_MS,
    );
    if (!preview.ok) {
      setAdoptBusy(false);
      message.error(extractError(preview.data));
      return;
    }
    Modal.confirm({
      title: "确认收编本机技能？",
      content: (
        <pre style={{ maxHeight: 220, overflow: "auto", fontSize: 12 }}>
          {JSON.stringify(preview.data, null, 2)}
        </pre>
      ),
      okText: "确认收编",
      cancelText: "取消",
      onOk: async () => {
        const result = await postJson(
          "/api/skills-manager/adopt",
          { dir: hermesSkillsDir, confirmed: true },
          ACTION_TIMEOUT_MS,
        );
        if (!result.ok) {
          message.error(extractError(result.data));
          return;
        }
        message.success("本机技能已收编到中央库。");
        void loadAll({ silent: true });
      },
    });
    setAdoptBusy(false);
  };

  if (state.status === "failed")
    return (
      <Alert
        type="warning"
        showIcon
        message="技能库管理器暂时连不上"
        description={state.reason}
        action={<Button onClick={() => void loadAll()}>重试</Button>}
      />
    );
  if (state.status === "loading")
    return (
      <Flex justify="center" align="center" style={{ padding: "48px 0" }}>
        <Typography.Text type="secondary">正在读取技能库状态…</Typography.Text>
      </Flex>
    );
  const data = state.data;
  if (!data.available)
    return (
      <Card>
        <Empty description="技能库管理器未安装" style={{ padding: "24px 0" }} />
        <Typography.Paragraph type="secondary" style={{ textAlign: "center" }}>
          {data.installHint ?? "当前 watch 镜像未包含 skills-manager CLI。"}
        </Typography.Paragraph>
      </Card>
    );
  const hermesSkillsDir = data.hermesSkillsDir;
  const isLocalAdopted = (item: SkillsManagerSkill) =>
    item.source_type === "local" &&
    typeof item.source_ref === "string" &&
    typeof hermesSkillsDir === "string" &&
    item.source_ref.startsWith(hermesSkillsDir);
  const deployedCount = skills.filter(deployedToTarget).length;
  const updatableCount = skills.filter((item) => hasAvailableUpdate(updates[item.name])).length;
  const skillCount =
    typeof data.repo["skill_count"] === "number" ? data.repo["skill_count"] : skills.length;
  return (
    <Flex vertical gap={16} className="skills-manager-panel">
      <Flex
        justify="space-between"
        align="flex-start"
        gap={12}
        wrap="wrap"
        className="skills-manager-heading"
      >
        <div>
          <Flex align="center" gap={8} wrap="wrap">
            <Typography.Title level={4} component="h2" style={{ margin: 0 }}>
              技能库管理器
            </Typography.Title>
            <Tag>{data.cli?.version ?? "未知版本"}</Tag>
            {data.deployTarget && (
              <Tag color={data.deployTarget.symlinked ? "success" : "warning"}>
                部署目标 {data.deployTarget.symlinked ? "已就绪" : "未就绪"}
              </Tag>
            )}
          </Flex>
          <Typography.Text type="secondary">
            中央库是唯一管理入口；部署后才会对当前智能体生效。
          </Typography.Text>
        </div>
        <Flex gap={8} wrap="wrap">
          <Button icon={<SearchOutlined />} onClick={() => setSearchOpen(true)}>
            市场搜索
          </Button>
          <Button
            icon={<ReloadOutlined />}
            loading={refreshing}
            onClick={() => void loadAll({ silent: true })}
          >
            刷新
          </Button>
          <Button type="primary" loading={updateAllBusy} onClick={() => void updateAll()}>
            一键更新全部
          </Button>
        </Flex>
      </Flex>
      <Flex gap={12} wrap="wrap" className="skills-manager-stats">
        <Card size="small">
          <Statistic title="中央库技能" value={skillCount} />
        </Card>
        <Card size="small">
          <Statistic title="已部署到 Hermes" value={deployedCount} />
        </Card>
        <Card size="small">
          <Statistic title="有可用更新" value={updatableCount} />
        </Card>
      </Flex>
      <Card
        size="small"
        title="安装技能"
        extra={<Typography.Text type="secondary">支持 Git 地址或 owner/repo</Typography.Text>}
      >
        <Flex gap={8} wrap="wrap">
          <Input
            className="skills-install-source"
            placeholder="Git 地址或 owner/repo"
            value={installSource}
            onChange={(event) => setInstallSource(event.target.value)}
            onPressEnter={() => void beginInstall()}
          />
          <Input
            className="skills-install-name"
            placeholder="技能名称（可选）"
            value={installName}
            onChange={(event) => setInstallName(event.target.value)}
            onPressEnter={() => void beginInstall()}
          />
          <Button
            type="primary"
            icon={<CloudDownloadOutlined />}
            loading={installBusy}
            onClick={() => void beginInstall()}
          >
            安装
          </Button>
          <Button
            icon={<FolderOpenOutlined />}
            loading={adoptBusy}
            onClick={() => void adoptLocalSkills()}
          >
            收编本机技能
          </Button>
        </Flex>
      </Card>
      <Card
        size="small"
        title="筛选技能"
        extra={
          <Typography.Text type="secondary">
            {filteredSkills.length} / {skills.length} 项
          </Typography.Text>
        }
      >
        <Flex gap={8} wrap="wrap">
          <Input
            allowClear
            placeholder="按名称或描述筛选"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            className="skills-filter-keyword"
          />
          <Select
            allowClear
            mode="multiple"
            placeholder="标签筛选"
            value={tagFilter}
            onChange={setTagFilter}
            options={tags.map((tag) => ({ value: tag, label: tag }))}
            className="skills-filter-tags"
          />
          <Select
            allowClear
            placeholder="来源筛选"
            value={sourceFilter}
            onChange={setSourceFilter}
            className="skills-filter-source"
            options={[
              { value: "git", label: "git" },
              { value: "local", label: "local" },
            ]}
          />
        </Flex>
      </Card>
      {selectedNames.length > 0 && (
        <Card size="small" style={{ background: "var(--ant-color-primary-bg)" }}>
          <Flex align="center" gap={8} wrap="wrap">
            <Typography.Text strong>已选择 {selectedNames.length} 项</Typography.Text>
            <Button
              size="small"
              type="primary"
              onClick={() =>
                void beginAction("deploy", "批量部署", { names: selectedNames })
              }
            >
              批量部署
            </Button>
            <Button
              size="small"
              danger
              onClick={() =>
                void beginAction(
                  "undeploy",
                  "批量取消部署",
                  { names: selectedNames },
                )
              }
            >
              批量取消部署
            </Button>
            <Button
              size="small"
              danger
              onClick={() =>
                void beginAction("remove", "批量删除", { names: selectedNames })
              }
            >
              批量删除
            </Button>
            <Button size="small" onClick={() => setSelectedNames([])}>
              清除选择
            </Button>
          </Flex>
        </Card>
      )}
      {filteredSkills.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的技能" />
      ) : (
        <Table<SkillsManagerSkill>
          rowKey="name"
          size="small"
          dataSource={filteredSkills}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          rowSelection={{
            selectedRowKeys: selectedNames,
            onChange: (keys) => setSelectedNames(keys.map(String)),
          }}
          scroll={{ x: 680 }}
          columns={[
            {
              title: "技能",
              dataIndex: "name",
              render: (name: string, item: SkillsManagerSkill) => (
                <Flex vertical gap={2} className="skill-table-name">
                  <Flex align="center" gap={6} wrap="wrap">
                    <Typography.Text strong>{name}</Typography.Text>
                    {item.source_type && <Tag>{item.source_type}</Tag>}
                    {stringArray(item.tags ?? item["tags"]).map((tag) => (
                      <Tag key={tag} color="blue">
                        {tag}
                      </Tag>
                    ))}
                  </Flex>
                  <Typography.Text type="secondary" ellipsis>
                    {typeof item.description === "string"
                      ? item.description
                      : item.skill_id
                        ? `ID ${item.skill_id}`
                        : "中央库技能"}
                  </Typography.Text>
                </Flex>
              ),
            },
            {
              title: "状态",
              width: 112,
              render: (_: unknown, item: SkillsManagerSkill) =>
                isLocalAdopted(item) ? (
                  <Tag color="blue">本机运行中</Tag>
                ) : (
                  <Tag color={deployedToTarget(item) ? "success" : "default"}>
                    {deployedToTarget(item) ? "已部署" : "未部署"}
                  </Tag>
                ),
            },
            {
              title: "更新",
              width: 104,
              render: (_: unknown, item: SkillsManagerSkill) => {
                const label = updateStatusLabel(updates[item.name]?.update_status);
                return <Tag color={label.color}>{label.text}</Tag>;
              },
            },
            {
              title: "操作",
              width: 220,
              render: (_: unknown, item: SkillsManagerSkill) => {
                const updateAvailable = hasAvailableUpdate(updates[item.name]);
                const primaryAction = isLocalAdopted(item) ? (
                  <Button
                    size="small"
                    icon={<LinkOutlined />}
                    onClick={() =>
                      setSourceDraft({
                        name: item.name,
                        gitUrl: "",
                        subpath: "",
                        branch: "",
                        force: false,
                      })
                    }
                  >
                    绑定源
                  </Button>
                ) : deployedToTarget(item) ? (
                  <Button
                    size="small"
                    danger
                    onClick={() =>
                      void beginAction(
                        "undeploy",
                        `取消部署 ${item.name}`,
                        { name: item.name },
                      )
                    }
                  >
                    取消部署
                  </Button>
                ) : (
                  <Button
                    size="small"
                    type="primary"
                    ghost
                    onClick={() =>
                      void beginAction(
                        "deploy",
                        `部署 ${item.name}`,
                        { name: item.name },
                      )
                    }
                  >
                    部署
                  </Button>
                );
                const menuItems = [
                  ...(updateAvailable
                    ? [
                        {
                          key: "update",
                          label: "更新技能",
                          icon: <ReloadOutlined />,
                          onClick: async () => {
                            const result = await postJson(
                              "/api/skills-manager/update",
                              { name: item.name, confirmed: true },
                              ACTION_TIMEOUT_MS,
                            );
                            if (result.ok && deployedToTarget(item))
                              await postJson(
                                "/api/skills-manager/deploy",
                                { name: item.name, confirmed: true },
                                ACTION_TIMEOUT_MS,
                              );
                            if (!result.ok) message.error(extractError(result.data));
                            else {
                              message.success("技能已更新");
                              void loadAll({ silent: true });
                            }
                          },
                        },
                      ]
                    : []),
                  {
                    key: "remove",
                    label: "删除技能",
                    danger: true,
                    onClick: () =>
                      void beginAction(
                        "remove",
                        `删除 ${item.name}`,
                        { name: item.name },
                      ),
                  },
                ];
                return (
                  <Flex gap={6} align="center">
                    <Button
                      size="small"
                      icon={<EyeOutlined />}
                      onClick={() => void openDetail(item.name)}
                    >
                      详情
                    </Button>
                    {primaryAction}
                    <Dropdown menu={{ items: menuItems }} trigger={["click"]}>
                      <Button
                        size="small"
                        aria-label={`更多操作：${item.name}`}
                        icon={<MoreOutlined />}
                      />
                    </Dropdown>
                  </Flex>
                );
              },
            },
          ]}
        />
      )}
      <Modal
        open={pending !== null}
        title={pending ? `${pending.title}（先试运行）` : null}
        okText={pending?.op === "remove" ? "确认删除" : "确认执行"}
        okButtonProps={pending?.op === "remove" ? { danger: true } : undefined}
        cancelText="取消"
        confirmLoading={confirming}
        onOk={() => void confirmPending()}
        onCancel={() => {
          if (!confirming) setPending(null);
        }}
      >
        {pending && (
          <>
            <Typography.Paragraph type="secondary">
              以下是试运行预览；确认后才会真正执行。
            </Typography.Paragraph>
            {previewEntries(pending.preview).length > 0 && (
              <Descriptions size="small" column={1} bordered>
                {previewEntries(pending.preview).map(([label, value]) => (
                  <Descriptions.Item key={label} label={label}>
                    {value}
                  </Descriptions.Item>
                ))}
              </Descriptions>
            )}
            <pre style={{ maxHeight: 220, overflow: "auto", fontSize: 12 }}>
              {JSON.stringify(pending.preview, null, 2)}
            </pre>
          </>
        )}
      </Modal>
      <Modal
        open={batchResults !== null}
        title="批量操作结果"
        footer={
          <Button type="primary" onClick={() => setBatchResults(null)}>
            关闭
          </Button>
        }
        onCancel={() => setBatchResults(null)}
      >
        {batchResults && (
          <List
            size="small"
            dataSource={batchResults}
            renderItem={(item) => (
              <List.Item>
                <Flex justify="space-between" style={{ width: "100%" }}>
                  <Typography.Text>{item.name ?? "未命名技能"}</Typography.Text>
                  {item.ok === true ? (
                    <Tag color="success">成功</Tag>
                  ) : (
                    <Typography.Text type="danger">
                      失败：{item.error?.message ?? "未知错误"}
                    </Typography.Text>
                  )}
                </Flex>
              </List.Item>
            )}
          />
        )}
      </Modal>
      <Modal
        open={searchOpen}
        title="技能市场搜索"
        width={760}
        footer={null}
        onCancel={() => setSearchOpen(false)}
      >
        <Flex gap={8}>
          <Input
            autoFocus
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onPressEnter={() => void searchMarket()}
            placeholder="搜索 skills.sh"
          />
          <Button
            type="primary"
            icon={<SearchOutlined />}
            loading={searchBusy}
            onClick={() => void searchMarket()}
          >
            搜索
          </Button>
        </Flex>
        <List
          style={{ marginTop: 16 }}
          dataSource={searchResults}
          locale={{ emptyText: "输入关键词开始搜索" }}
          renderItem={(item) => (
            <List.Item
              actions={[
                <Button
                  key="install"
                  type="primary"
                  size="small"
                  loading={installBusy}
                  onClick={() =>
                    void beginInstall(
                      item.install_ref ?? item.source ?? "",
                      item.name ?? "",
                      "skills",
                    )
                  }
                >
                  安装
                </Button>,
              ]}
            >
              <List.Item.Meta
                title={item.name ?? item.skill_id ?? "未命名技能"}
                description={`${item.source ?? ""}${typeof item.installs === "number" ? ` · ${item.installs} installs` : ""}`}
              />
            </List.Item>
          )}
        />
      </Modal>
      <Drawer
        title={detailName ? `技能详情：${detailName}` : "技能详情"}
        width={560}
        open={detailName !== null}
        onClose={() => setDetailName(null)}
      >
        {detailBusy && <Typography.Text type="secondary">正在读取详情…</Typography.Text>}
        {detail && (
          <>
            <Descriptions bordered size="small" column={1}>
              {(() => {
                const show =
                  detail.show && typeof detail.show === "object"
                    ? (detail.show as Record<string, unknown>)
                    : {};
                return (
                  <>
                    <Descriptions.Item label="名称">
                      {String(show["name"] ?? detailName)}
                    </Descriptions.Item>
                    <Descriptions.Item label="描述">
                      {String(show["description"] ?? "")}
                    </Descriptions.Item>
                    <Descriptions.Item label="来源">
                      {String(show["source_type"] ?? "")} {String(show["source_ref"] ?? "")}
                    </Descriptions.Item>
                    <Descriptions.Item label="部署目标">
                      {stringArray(show["deployed_to"]).join(", ") || "未部署"}
                    </Descriptions.Item>
                    <Descriptions.Item label="文件">
                      {stringArray(show["files"]).join(", ") || "-"}
                    </Descriptions.Item>
                  </>
                );
              })()}
            </Descriptions>
            <Card
              size="small"
              title={
                <Flex align="center" gap={6}>
                  <TagsOutlined />
                  标签
                </Flex>
              }
              style={{ marginTop: 16 }}
            >
              <Flex gap={8} wrap="wrap">
                <Input
                  placeholder="标签，多个用逗号分隔"
                  value={tagDraft}
                  onChange={(event) => setTagDraft(event.target.value)}
                />
                <Button loading={tagBusy} onClick={() => void updateTags("add")}>
                  添加
                </Button>
                <Button loading={tagBusy} onClick={() => void updateTags("remove")}>
                  移除
                </Button>
                <Button loading={tagBusy} onClick={() => void updateTags("set")}>
                  覆盖
                </Button>
              </Flex>
              <Flex gap={6} wrap="wrap" style={{ marginTop: 10 }}>
                {(() => {
                  const show =
                    detail.show && typeof detail.show === "object"
                      ? (detail.show as Record<string, unknown>)
                      : {};
                  return stringArray(show["tags"]).map((tag) => (
                    <Tag key={tag} color="blue">
                      {tag}
                    </Tag>
                  ));
                })()}
              </Flex>
            </Card>
          </>
        )}
      </Drawer>
      <Modal
        open={sourceDraft !== null && sourcePreview === null}
        title="绑定 Git 源"
        okText="预览变更"
        cancelText="取消"
        onCancel={() => setSourceDraft(null)}
        onOk={() => void previewSource()}
      >
        {sourceDraft && (
          <Flex vertical gap={10}>
            <Input
              required
              placeholder="Git 地址"
              value={sourceDraft.gitUrl}
              onChange={(event) => setSourceDraft({ ...sourceDraft, gitUrl: event.target.value })}
            />
            <Input
              placeholder="子目录（可选）"
              value={sourceDraft.subpath}
              onChange={(event) => setSourceDraft({ ...sourceDraft, subpath: event.target.value })}
            />
            <Input
              placeholder="分支（可选）"
              value={sourceDraft.branch}
              onChange={(event) => setSourceDraft({ ...sourceDraft, branch: event.target.value })}
            />
            <Checkbox
              checked={sourceDraft.force}
              onChange={(event) => setSourceDraft({ ...sourceDraft, force: event.target.checked })}
            >
              内容不同时覆盖
            </Checkbox>
          </Flex>
        )}
      </Modal>
      <Modal
        open={sourcePreview !== null}
        title="确认绑定 Git 源"
        okText="确认绑定"
        cancelText="返回修改"
        confirmLoading={sourceConfirming}
        onCancel={() => setSourcePreview(null)}
        onOk={() => void confirmSource()}
      >
        <Typography.Paragraph type="secondary">
          以下为试运行结果，确认后才会改变技能来源。
        </Typography.Paragraph>
        <pre style={{ maxHeight: 260, overflow: "auto", fontSize: 12 }}>
          {JSON.stringify(sourcePreview, null, 2)}
        </pre>
      </Modal>
    </Flex>
  );
}
