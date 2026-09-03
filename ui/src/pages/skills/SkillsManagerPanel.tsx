/**
 * 技能库管理器面板（skills-manager CLI 集成）：中央技能库统计、技能列表
 * （部署状态 / 更新状态）、安装技能与部署/取消部署/更新/删除的二段式确认
 * （先 dry-run 预览 Modal，确认后 confirmed:true 真执行；删除的 confirmed 请求
 * 由 watch 服务层先取消部署再移除中央库条目）。更新成功后会为已部署技能
 * 自动重新部署。CLI 未安装时渲染安装指引空态；数据手动刷新 + 操作后刷新。
 */
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Empty,
  Flex,
  Input,
  List,
  Modal,
  Statistic,
  Tag,
  Typography,
} from "antd";
import { CloudDownloadOutlined, FolderOpenOutlined, ReloadOutlined } from "@ant-design/icons";
import { loadJson, postJson } from "../../lib/api.js";
import type { FetchState } from "../../lib/api.js";

/** skills list 条目（CLI 输出宽松解析：只约定 name，其余字段全部防御式读取）。 */
interface SkillsManagerSkill {
  name: string;
  skill_id?: string;
  source_type?: string;
  [key: string]: unknown;
}

interface SkillsManagerStatusOk {
  available: true;
  cli: { path: string; version: string };
  repo: Record<string, unknown>;
  skills: SkillsManagerSkill[];
  deployAgent?: Record<string, unknown> | null;
  deployTarget?: { agent: string; dir: string; symlinked: boolean };
  hermesSkillsDir?: string;
}

type SkillsManagerStatus = SkillsManagerStatusOk | { available: false; installHint?: string };

interface UpdateCheckItem {
  name?: string;
  skill_id?: string;
  update_status?: string | null;
  last_check_error?: string | null;
  skipped?: boolean;
  [key: string]: unknown;
}

/** 待确认动作：payload 不含 confirmed（发预览请求用），确认时再补 confirmed:true。 */
interface PendingAction {
  title: string;
  op: "install" | "deploy" | "undeploy" | "update" | "remove";
  payload: Record<string, unknown>;
  preview: unknown;
}

const DEPLOY_AGENT = "claude_code";
/** 安装/更新等 CLI 动作可能拉取远端 git 源，与服务端代理超时对齐放宽到 120s。 */
const ACTION_TIMEOUT_MS = 120_000;

/** 判断技能是否已部署到部署目标（claude_code / Hermes skills symlink）。 */
function deployedToTarget(item: SkillsManagerSkill): boolean {
  // CLI skills list --json 的部署字段是 deployed_to: ["claude_code", ...]。
  const deployedTo = item["deployed_to"];
  if (Array.isArray(deployedTo)) return deployedTo.includes(DEPLOY_AGENT);
  if (typeof item["deployed"] === "boolean") return item["deployed"];
  return false;
}

/** 从错误响应体提取人话文案；503 指引类响应优先展示 installHint。 */
function extractError(data: unknown): string {
  if (data !== null && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (typeof record["installHint"] === "string" && record["installHint"] !== "") return record["installHint"];
    const code = typeof record["code"] === "string" ? record["code"] : null;
    if (typeof record["message"] === "string" && record["message"] !== "") {
      return code === null ? record["message"] : `${code}：${record["message"]}`;
    }
  }
  return "操作失败，请稍后重试或查看管家日志。";
}

/** 预览载荷的关键字段（CLI 输出形状按命令不同，抽得到多少展示多少）。 */
function previewEntries(preview: unknown): Array<[string, string]> {
  if (preview === null || typeof preview !== "object") return [];
  const labels: Record<string, string> = {
    action: "动作",
    dry_run: "试运行",
    skill_id: "技能 ID",
    name: "名称",
    central_path: "中央库路径",
    skill_count: "技能数",
    pair_count: "部署对数",
    changed_pairs: "将变更",
    message: "说明",
    source_type: "来源类型",
  };
  const record = preview as Record<string, unknown>;
  const entries: Array<[string, string]> = [];
  for (const [key, label] of Object.entries(labels)) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    entries.push([label, typeof value === "object" ? JSON.stringify(value) : String(value)]);
  }
  return entries;
}

function updateStatusLabel(status: string | null | undefined): { text: string; color?: "success" | "warning" | "error" | "default" } {
  if (status === "up_to_date") return { text: "已是最新", color: "success" };
  if (status === "local_only")
    return { text: "本地来源", color: "default" }; // 收编的本机技能无远端可更新
  if (status === undefined || status === null || status === "") return { text: "未检查" };
  if (status === "skipped") return { text: "已跳过" };
  return { text: "有可用更新", color: "warning" };
}

/** update_status 是明确的“有新版”时才展示更新按钮；local_only 不是更新。 */
function hasAvailableUpdate(item: UpdateCheckItem | undefined): boolean {
  if (item === undefined) return false;
  const status = item.update_status ?? null;
  return status !== null && status !== "" && status !== "up_to_date" && status !== "skipped" && status !== "local_only";
}

function opDoneText(op: PendingAction["op"]): string {
  if (op === "install") return "技能已安装到中央库。";
  if (op === "deploy") return "已部署到 Hermes skills 目录。";
  if (op === "undeploy") return "已从 Hermes skills 目录移除部署。";
  if (op === "remove") return "已从中央技能库删除该技能。";
  return "技能已更新。";
}

export function SkillsManagerPanel() {
  const { message, modal } = App.useApp();
  const [state, setState] = useState<FetchState<SkillsManagerStatus>>({ status: "loading" });
  const [updates, setUpdates] = useState<Record<string, UpdateCheckItem>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [installSource, setInstallSource] = useState("");
  const [installName, setInstallName] = useState("");
  const [installBusy, setInstallBusy] = useState(false);
  const [busySkill, setBusySkill] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [confirming, setConfirming] = useState(false);

  /** 拉取库状态 + 更新检查；updates 失败不阻塞列表（仅更新按钮不显示）。 */
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
    if (updatesResult.ok && Array.isArray(updatesResult.data)) {
      const map: Record<string, UpdateCheckItem> = {};
      for (const item of updatesResult.data) {
        const key = item.name ?? item.skill_id;
        if (typeof key === "string" && key !== "") map[key] = item;
      }
      setUpdates(map);
    } else {
      setUpdates({});
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const adoptCandidates = useCallback(async (): Promise<
    Array<{ path: string; name: string; reason: string }>
  > => {
    // 早退分支之后不能再调用 hooks；目录改为在回调内从 state 安全读取。
    if (state.status !== "ready") return [];
    if (state.status !== "ready" || state.data.available !== true) return [];
    const dir = state.data.hermesSkillsDir;
    if (dir === undefined || dir === "") return [];
    const result = await postJson(
      "/api/skills-manager/adopt",
      { dir },
      ACTION_TIMEOUT_MS,
    );
    if (!result.ok) {
      message.error(extractError(result.data));
      return [];
    }
    return (result.data as { candidates?: Array<{ path: string; name: string; reason: string }> })
      .candidates ?? [];
  }, []);

  /** 发起动作：先不带 confirmed 拿 dry-run 预览，弹出确认 Modal。 */
  const beginAction = async (
    op: PendingAction["op"],
    title: string,
    payload: Record<string, unknown>,
    busyKey: string,
  ): Promise<void> => {
    setBusySkill(busyKey);
    const result = await postJson(`/api/skills-manager/${op}`, payload, ACTION_TIMEOUT_MS);
    setBusySkill(null);
    if (!result.ok) {
      message.error(extractError(result.data));
      return;
    }
    setPending({ title, op, payload, preview: result.data });
  };

  const confirmPending = async (): Promise<void> => {
    if (pending === null || confirming) return;
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
    message.success(opDoneText(pending.op));
    setPending(null);
    void loadAll({ silent: true });
  };

  const [adoptBusy, setAdoptBusy] = useState(false);
  const beginInstall = async (): Promise<void> => {
    const source = installSource.trim();
    if (source === "") {
      message.warning("请先填写技能的 Git 地址（或 owner/repo）。");
      return;
    }
    if (installBusy) return;
    setInstallBusy(true);
    const name = installName.trim();
    // CLI 的 install 不支持 dry-run（向中央库新增，重名自动拒绝），单段直接安装。
    const result = await postJson(
      "/api/skills-manager/install",
      { source, confirmed: true, ...(name === "" ? {} : { name }) },
      ACTION_TIMEOUT_MS,
    );
    setInstallBusy(false);
    if (!result.ok) {
      message.error(extractError(result.data));
      return;
    }
    message.success(`技能已安装到中央库：${name === "" ? source : name}`);
    setInstallSource("");
    setInstallName("");
    void loadAll({ silent: true });
  };

  const runUpdate = async (item: SkillsManagerSkill): Promise<void> => {
    const name = item.name;
    // CLI 的 update 不支持 dry-run（只更新中央库、不动已部署副本），单段直接执行。
    setBusySkill(`update:${name}`);
    const result = await postJson("/api/skills-manager/update", { name, confirmed: true }, ACTION_TIMEOUT_MS);
    if (!result.ok) {
      setBusySkill(null);
      message.error(extractError(result.data));
      return;
    }
    // 更新前已部署的技能：中央库更新后自动重新部署，让部署副本与库保持同步。
    if (deployedToTarget(item)) {
      const redeploy = await postJson("/api/skills-manager/deploy", { name, confirmed: true }, ACTION_TIMEOUT_MS);
      setBusySkill(null);
      if (!redeploy.ok) {
        message.warning(`已更新 ${name}，但重新部署失败：${extractError(redeploy.data)}`);
      } else {
        message.success(`已更新并重新部署 ${name}`);
      }
    } else {
      setBusySkill(null);
      message.success(`已更新 ${name}`);
    }
    void loadAll({ silent: true });
  };

  if (state.status === "failed") {
    return (
      <Alert
        type="warning"
        showIcon
        message="技能库管理器暂时连不上"
        description={state.reason}
        action={<Button onClick={() => void loadAll()}>重试</Button>}
      />
    );
  }

  if (state.status === "loading") {
    return (
      <Flex justify="center" align="center" gap={8} style={{ padding: "48px 0" }}>
        <Typography.Text type="secondary">正在读取技能库状态…</Typography.Text>
      </Flex>
    );
  }

  const data = state.data;
  if (!data.available) {
    return (
      <Card>
        <Empty description="技能库管理器未安装" style={{ padding: "24px 0" }} />
        <Typography.Paragraph type="secondary" style={{ textAlign: "center" }}>
          {data.installHint ?? "当前 watch 镜像未包含 skills-manager CLI，无法管理中央技能库。"}
        </Typography.Paragraph>
      </Card>
    );
  }

  const skills = data.skills ?? [];
  const hermesSkillsDir = data.hermesSkillsDir;
  const deployedCount = skills.filter(deployedToTarget).length;
  const updatableCount = skills.filter((item) => hasAvailableUpdate(updates[item.name])).length;
  const skillCount = typeof data.repo["skill_count"] === "number" ? data.repo["skill_count"] : skills.length;
  const preview = pending === null ? [] : previewEntries(pending.preview);

  const adoptLocalSkills = async (): Promise<void> => {
    if (adoptBusy) return;
    const dir = data !== null && data.available === true ? data.hermesSkillsDir : undefined;
    if (dir === undefined || dir === "") return;
    setAdoptBusy(true);
    const result = await postJson(
      "/api/skills-manager/adopt",
      { dir, confirmed: true },
      ACTION_TIMEOUT_MS,
    );
    setAdoptBusy(false);
    if (!result.ok) {
      message.error(extractError(result.data));
      return;
    }
    const adopted = (result.data as { adopted?: Array<{ name?: string }> }).adopted ?? [];
    message.success(`已收编 ${adopted.length} 个本机技能到中央库`);
    void loadAll({ silent: true });
  };

  const previewAdopt = async (): Promise<void> => {
    if (adoptBusy) return;
    setAdoptBusy(true);
    const candidates = await adoptCandidates();
    setAdoptBusy(false);
    if (candidates.length === 0) {
      message.info("本机技能目录里没有可收编的新技能。");
      return;
    }
    modal.info({
      title: `发现 ${candidates.length} 个本机技能可收编`,
      content: (
        <ul style={{ maxHeight: 260, overflow: "auto", paddingLeft: 20, margin: 0 }}>
          {candidates.map((c) => (
            <li key={c.path}>{c.name}</li>
          ))}
        </ul>
      ),
      okText: "收编到中央库",
      onOk: () => void adoptLocalSkills(),
    });
  };


  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center" gap={12} wrap="wrap">
        <Flex align="center" gap={8} wrap="wrap">
          <Typography.Title level={4} component="h2" style={{ margin: 0 }}>
            技能库管理器
          </Typography.Title>
          <Tag>{data.cli?.version ?? "未知版本"}</Tag>
          {data.deployTarget !== undefined && (
            <Tag color={data.deployTarget.symlinked ? "success" : "warning"} title={data.deployTarget.dir}>
              部署目标 {data.deployTarget.symlinked ? "已就绪" : "未就绪"}
            </Tag>
          )}
        </Flex>
        <Button icon={<ReloadOutlined />} loading={refreshing} onClick={() => void loadAll({ silent: true })}>
          刷新
        </Button>
      </Flex>

      <Flex gap={16} wrap="wrap">
        <Card size="small" style={{ flex: "1 1 160px" }}>
          <Statistic title="中央库技能" value={skillCount} />
        </Card>
        <Card size="small" style={{ flex: "1 1 160px" }}>
          <Statistic title="已部署到 Hermes" value={deployedCount} />
        </Card>
        <Card size="small" style={{ flex: "1 1 160px" }}>
          <Statistic title="有可用更新" value={updatableCount} />
        </Card>
      </Flex>

      <Card size="small" title="安装技能">
        <Flex gap={8} wrap="wrap">
          <Input
            style={{ flex: "1 1 320px", minWidth: 240 }}
            placeholder="Git 地址或 owner/repo，例如 xingkongliang/skills-manager"
            value={installSource}
            onChange={(event) => setInstallSource(event.target.value)}
            onPressEnter={() => void beginInstall()}
          />
          <Input
            style={{ flex: "0 1 200px", minWidth: 160 }}
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
            onClick={() => void previewAdopt()}
            title="把本机已安装、尚未纳入中央库的技能收编进来统一管理"
          >
            收编本机技能
          </Button>
        </Flex>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 8, fontSize: 12 }}>
          安装会直接拉取到中央技能库（同名技能会被拒绝）；「收编本机技能」会把
          Hermes 已安装、但还不在中央库里的技能纳入统一管理，原目录保持不变。
        </Typography.Paragraph>
      </Card>

      {skills.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="中央技能库还没有技能；先用上方表单安装一个吧。" />
      ) : (
        <Card size="small" styles={{ body: { padding: "4px 16px" } }}>
          <List
            dataSource={skills}
            renderItem={(item: SkillsManagerSkill) => {
              const deployed = deployedToTarget(item);
              const check = updates[item.name];
              const statusLabel = updateStatusLabel(check?.update_status);
              // 收编自 Hermes skills 目录的本地技能：本体仍在原目录运行，
              // 中央库只是登记；对它们隐藏「部署/更新」，避免 TARGET_CONFLICT。
              const isLocalAdopted =
                item.source_type === "local" &&
                typeof item["source_ref"] === "string" &&
                typeof hermesSkillsDir === "string" &&
                (item["source_ref"] as string).startsWith(hermesSkillsDir);
              return (
                <List.Item
                  actions={[
                    hasAvailableUpdate(check) ? (
                      <Button
                        key="update"
                        size="small"
                        type="primary"
                        loading={busySkill === `update:${item.name}`}
                        onClick={() => void runUpdate(item)}
                      >
                        更新
                      </Button>
                    ) : null,
                    isLocalAdopted ? (
                      <Tag key="local" color="blue">
                        无需部署
                      </Tag>
                    ) : deployed ? (
                      <Button
                        key="undeploy"
                        size="small"
                        danger
                        loading={busySkill === `undeploy:${item.name}`}
                        onClick={() =>
                          void beginAction(
                            "undeploy",
                            `取消部署 ${item.name}`,
                            { name: item.name },
                            `undeploy:${item.name}`,
                          )
                        }
                      >
                        取消部署
                      </Button>
                    ) : (
                      <Button
                        key="deploy"
                        size="small"
                        type="primary"
                        ghost
                        loading={busySkill === `deploy:${item.name}`}
                        onClick={() =>
                          void beginAction(
                            "deploy",
                            `部署 ${item.name}`,
                            { name: item.name },
                            `deploy:${item.name}`,
                          )
                        }
                      >
                        部署
                      </Button>
                    ),
                    <Button
                      key="remove"
                      size="small"
                      danger
                      loading={busySkill === `remove:${item.name}`}
                      onClick={() =>
                        void beginAction(
                          "remove",
                          `删除 ${item.name}`,
                          { name: item.name },
                          `remove:${item.name}`,
                        )
                      }
                    >
                      删除
                    </Button>,
                  ].filter((node) => node !== null)}
                >
                  <List.Item.Meta
                    title={
                      <Flex align="center" gap={8} wrap="wrap">
                        <Typography.Text strong>{item.name}</Typography.Text>
                        {item.source_type !== undefined && <Tag>{item.source_type}</Tag>}
                        {isLocalAdopted && (
                          <Tag color="blue" style={{ marginRight: 0 }}>
                            本机已有
                          </Tag>
                        )}
                        {isLocalAdopted ? (
                          <Tag color="success" style={{ marginRight: 0 }}>
                            本机运行中
                          </Tag>
                        ) : (
                          <Tag color={deployed ? "success" : "default"} style={{ marginRight: 0 }}>
                            {deployed ? "已部署到 Hermes" : "未部署"}
                          </Tag>
                        )}
                        <Tag color={statusLabel.color}>{statusLabel.text}</Tag>
                      </Flex>
                    }
                    description={
                      check?.last_check_error ? (
                        <Typography.Text type="warning" style={{ fontSize: 12 }}>
                          最近检查出错：{check.last_check_error}
                        </Typography.Text>
                      ) : (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {isLocalAdopted
                            ? "已收编自本机技能目录（原件保持不动）"
                            : typeof item.skill_id === "string"
                              ? `ID ${item.skill_id}`
                              : "中央库技能"}
                        </Typography.Text>
                      )
                    }
                  />
                </List.Item>
              );
            }}
          />
        </Card>
      )}

      <Modal
        open={pending !== null}
        title={pending === null ? null : `${pending.title}（先试运行）`}
        okText={pending?.op === "remove" ? "确认删除" : "确认执行"}
        okButtonProps={pending?.op === "remove" ? { danger: true } : undefined}
        cancelText="再想想"
        confirmLoading={confirming}
        onOk={() => void confirmPending()}
        onCancel={() => {
          if (!confirming) setPending(null);
        }}
      >
        <Typography.Paragraph type="secondary">
          以下是试运行预览；确认后才会真正执行。
        </Typography.Paragraph>
        {pending?.op === "remove" && (
          <Typography.Paragraph type="danger" style={{ marginBottom: 12 }}>
            本次变更：移除该技能在 Hermes 的部署 + 从中央技能库删除（不可撤销）。
          </Typography.Paragraph>
        )}
        {preview.length > 0 && (
          <Descriptions size="small" column={1} bordered style={{ marginBottom: 12 }}>
            {preview.map(([label, value]) => (
              <Descriptions.Item key={label} label={label}>
                <Typography.Text code style={{ wordBreak: "break-all" }}>
                  {value}
                </Typography.Text>
              </Descriptions.Item>
            ))}
          </Descriptions>
        )}
        {pending !== null && (
          <pre
            style={{
              maxHeight: 200,
              overflow: "auto",
              fontSize: 12,
              background: "rgba(128,128,128,0.08)",
              padding: 8,
              borderRadius: 6,
            }}
          >
            {JSON.stringify(pending.preview, null, 2)}
          </pre>
        )}
      </Modal>
    </Flex>
  );
}
