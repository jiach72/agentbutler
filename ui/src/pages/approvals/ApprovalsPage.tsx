/**
 * 操作审批列表（Trust Layer M3.1）：
 * - 结论条：一句话说清「有多少待你处理、多少已超时未处理」这两个最关键信号；
 * - 概览：待处理 / 需面板确认 / 已批准（追认）/ 已拒绝（存疑）/ 超时未处理（StatStrip，色走品牌语义）；
 * - 过滤：全部 / 仅待处理 / 仅已升级；
 * - 表格：动作类型 + 目标 + 剩余时限倒计时 + 状态，点击进入 /approvals/:id 确认页。
 *
 * 高危动作两类确认（文案按来源分流，见 ./helpers.ts）：
 * gate（事前放行）阻塞执行、超时按拒绝拦截；audit（事后确认，detail.origin=auto-detect）
 * 不阻塞已执行的动作，按钮是追认/存疑表态、超时自动关闭。
 *
 * 数据真相原则：卡片里绝不出现对话正文——审批只针对「动作」，不看 agent 说了什么。
 */
import { Alert, App, Button, Card, Drawer, Flex, Popconfirm, Segmented, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  CheckCircleOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  CloseOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AdvancedDetails } from "../../components/AdvancedDetails.js";
import { ConclusionBar } from "../../components/ConclusionBar.js";
import type { PageConclusionView } from "../../components/ConclusionBar.js";
import { Empty } from "../../components/Empty.js";
import { PageHeader } from "../../components/PageHeader.js";
import { StatStrip } from "../../components/StatStrip.js";
import type { StatStripItem } from "../../components/StatStrip.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { approvalStatusLabel, approvalStatusTone, isAuditApproval } from "./helpers.js";
import { runInlineDecision, type ApprovalDecision } from "./decision.js";
import { deleteJson, loadJson, postJson } from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";
import { useUrlState } from "../../hooks/useUrlState.js";

export interface ActionFingerprintRule {
  fingerprint: string;
  kind: string;
  target: string;
  rule: "block" | "trust";
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalItem {
  id: string;
  actionId: string;
  fingerprint: string;
  instance: string;
  sessionId: string | null;
  kind: string;
  title: string;
  detail: unknown;
  status: string;
  channel: string | null;
  /** 本单吸收的请求次数；对外展示用 windowCount，别用它。 */
  attempts: number;
  /** 升级窗口内该动作被请求的真实次数（客户可见数字一律取这个）。 */
  windowCount: number;
  escalateRequired: boolean;
  expiresAt: string;
  respondedAt: string | null;
  actor: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  remainingMs: number;
  confirmUrl: string;
}

interface ApprovalsPayload {
  items: ApprovalItem[];
  summary: {
    total: number;
    pending: number;
    escalated: number;
    expired: number;
    approved: number;
    denied: number;
    lastRequestAt: string | null;
  };
  scan: {
    enabled: boolean;
    scannedActions: number;
    created: number;
    lastScanAt: string | null;
    watermark: number;
    ttlMs: number;
    escalationThreshold: number;
    retentionDays: number;
  };
}

const KIND_LABEL: Record<string, string> = {
  "file-delete": "删除文件",
  "file-write": "写入文件",
  "shell-exec": "执行命令",
  "message-send": "外发消息",
  "api-call": "调用接口",
  "web-fetch": "抓取页面",
  raw: "未归类动作",
};

/** 剩余时限：仅对 pending 有意义（服务端已按状态归零）。 */
const remainingText = (item: ApprovalItem): string => {
  if (item.status !== "pending") return "-";
  if (item.remainingMs <= 0) return isAuditApproval(item) ? "已过窗口" : "即将拦截";
  const totalSec = Math.round(item.remainingMs / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min} 分 ${String(sec).padStart(2, "0")} 秒` : `${sec} 秒`;
};

const detailTarget = (item: ApprovalItem): string => {
  const detail = item.detail;
  if (typeof detail === "object" && detail !== null) {
    const record = detail as Record<string, unknown>;
    const value = record["target"] ?? record["path"] ?? record["command"];
    if (typeof value === "string" && value !== "") return value;
  }
  return item.fingerprint.split("|")[1] ?? "-";
};

export function ApprovalsPage() {
  const { message } = App.useApp();
  const [data, setData] = useState<ApprovalsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  // 动作指纹规则库抽屉与数据
  const [rulesOpen, setRulesOpen] = useState(false);
  const [rules, setRules] = useState<ActionFingerprintRule[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);

  // 过滤同步到 URL
  const [category, setCategory] = useUrlState<string>("category", "all");
  const [filter, setFilter] = useUrlState<string>("filter", "pending");
  const [timeWindow, setTimeWindow] = useUrlState<string>("time", "24h");

  const refresh = useCallback(() => {
    const params = new URLSearchParams({ limit: "200" });
    if (filter === "pending") params.set("status", "pending");
    if (filter === "escalated") {
      params.set("status", "pending");
      params.set("escalateOnly", "1");
    }
    void loadJson<ApprovalsPayload>(`/api/approvals?${params.toString()}`, 20_000).then((result) => {
      if (result.ok) {
        setData(result.data);
        setError(null);
      } else {
        setError(result.reason);
      }
    });
  }, [filter]);

  const loadRules = useCallback(() => {
    setRulesLoading(true);
    void loadJson<{ rules: ActionFingerprintRule[] }>("/api/approvals/rules", 10_000).then((result) => {
      setRulesLoading(false);
      if (result.ok && Array.isArray(result.data.rules)) {
        setRules(result.data.rules);
      }
    });
  }, []);

  const removeRule = async (fingerprint: string) => {
    const result = await deleteJson(`/api/approvals/rules/${encodeURIComponent(fingerprint)}`, 10_000);
    if (result.ok) {
      message.success("已解除该指纹规则");
      loadRules();
    } else {
      message.error("解除规则失败");
    }
  };

  useEffect(() => {
    refresh();
  }, [refresh]);
  // 15s 轮询：与后端超时结算节奏对齐，倒计时不会与真实状态脱节太久。
  usePolling(refresh, 15_000);

  useEffect(() => {
    loadRules();
  }, [loadRules]);

  /**
   * 列表行内快捷决策（与确认页同一 API）；升级单仍引导进详情页核对目标。
   */
  const decide = useCallback(
    async (
      item: ApprovalItem,
      decision: ApprovalDecision,
      options?: { blockFingerprint?: boolean; trustFingerprint?: boolean },
    ) => {
      setBusyId(item.id);
      await runInlineDecision(
        {
          postJson,
          onToast: (level, text) => message[level](text),
          onSettled: () => {
            refresh();
            loadRules();
          },
        },
        item.id,
        decision,
        {
          isAudit: isAuditApproval(item),
          blockFingerprint: options?.blockFingerprint,
          trustFingerprint: options?.trustFingerprint,
        },
      );
      setBusyId(null);
    },
    [loadRules, message, refresh],
  );

  // 列表过滤与折叠
  const allItems = data?.items ?? [];
  const now = Date.now();
  const filteredByCategory = allItems.filter((item) => {
    if (category === "gate") return !isAuditApproval(item);
    if (category === "audit") return isAuditApproval(item);
    return true;
  });

  const filteredItems = filteredByCategory.filter((item) => {
    if (timeWindow === "24h") {
      return now - new Date(item.createdAt).getTime() <= 24 * 3600 * 1000;
    }
    if (timeWindow === "3d") {
      return now - new Date(item.createdAt).getTime() <= 72 * 3600 * 1000;
    }
    return true;
  });

  const hiddenByTimeCount = filteredByCategory.length - filteredItems.length;
  const pendingInView = filteredItems.filter((i) => i.status === "pending");
  const hasGateInPending = pendingInView.some((i) => !isAuditApproval(i));

  const handleBulkDecide = async (decision: "approve" | "deny") => {
    if (pendingInView.length === 0) return;
    setBulkBusy(true);
    const result = await postJson(
      "/api/approvals/bulk-decide",
      { ids: pendingInView.map((i) => i.id), decision },
      20_000,
    );
    setBulkBusy(false);
    if (result.ok) {
      if (decision === "approve") {
        message.success(
          hasGateInPending
            ? `已批量放行 ${pendingInView.length} 条动作`
            : `已批量确认 ${pendingInView.length} 条异动为已知`,
        );
      } else {
        message.success(
          hasGateInPending
            ? `已批量拦截 ${pendingInView.length} 条高危动作`
            : `已批量标记 ${pendingInView.length} 条异动存疑`,
        );
      }
      refresh();
    } else {
      message.error("批量处理失败，请重试");
    }
  };

  const columns: ColumnsType<ApprovalItem> = [
    {
      title: "动作",
      dataIndex: "title",
      key: "title",
      ellipsis: true,
      render: (title: string, row) => <Link to={`/approvals/${encodeURIComponent(row.id)}`}>{title}</Link>,
    },
    {
      title: "类别",
      key: "category",
      width: 110,
      render: (_: unknown, row) => {
        const audit = isAuditApproval(row);
        return audit ? (
          <Tooltip title="事后核验：动作已由 Hermes 执行完毕，不阻塞后续流程。可确认已知或存疑拉黑。">
            <Tag color="default">事后核验</Tag>
          </Tooltip>
        ) : (
          <Tooltip title="事前放行：动作在落地前被管家拦截，等待您批准放行。超时将自动拒绝。">
            <Tag color="processing">事前放行</Tag>
          </Tooltip>
        );
      },
    },
    {
      title: "类型",
      dataIndex: "kind",
      key: "kind",
      width: 110,
      render: (kind: string) => <Tag>{KIND_LABEL[kind] ?? kind}</Tag>,
    },
    {
      title: "目标",
      key: "target",
      ellipsis: true,
      width: 250,
      render: (_: unknown, row) => <Typography.Text code>{detailTarget(row)}</Typography.Text>,
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 190,
      render: (status: string, row) => {
        const tone = approvalStatusTone(status, isAuditApproval(row));
        const label = approvalStatusLabel(status, isAuditApproval(row));
        return (
          <Flex gap={4} wrap="wrap">
            <StatusBadge tone={tone} label={label} />
            {row.escalateRequired && row.status === "pending" && (
              <Tooltip title={`同一动作今日已被请求 ${row.windowCount} 次，需在面板确认后才可处理`}>
                <span>
                  <StatusBadge tone="warn" label="需面板确认" />
                </span>
              </Tooltip>
            )}
          </Flex>
        );
      },
    },
    { title: "剩余时限", key: "remaining", width: 120, render: (_: unknown, row) => remainingText(row) },
    {
      title: "请求时间",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 165,
      render: (value: string) => new Date(value).toLocaleString(),
    },
    {
      title: "快捷处理",
      key: "quick",
      width: 160,
      fixed: "right",
      render: (_: unknown, row) => {
        if (row.status !== "pending") {
          return (
            <Link to={`/approvals/${encodeURIComponent(row.id)}`}>
              <Typography.Text type="secondary">查看详情</Typography.Text>
            </Link>
          );
        }
        if (row.escalateRequired) {
          return (
            <Tooltip title="该单已升级：请点开详情核对目标后确认，不支持快捷操作">
              <span>
                <Link to={`/approvals/${encodeURIComponent(row.id)}`}>
                  <Button size="small" type="primary">
                    去确认
                  </Button>
                </Link>
              </span>
            </Tooltip>
          );
        }
        const audit = isAuditApproval(row);
        return audit ? (
          <Space size={6}>
            <Button
              size="small"
              type="primary"
              icon={<CheckOutlined />}
              loading={busyId === row.id}
              onClick={() => void decide(row, "approve")}
            >
              已知
            </Button>
            <Popconfirm
              title="标记存疑？"
              description="动作已执行，存疑将标记待核查并记入审计。如需阻断未来同类操作，请在详情页选择「存疑并阻断」。"
              okText="标记存疑"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => void decide(row, "deny")}
            >
              <Button size="small" danger icon={<CloseOutlined />} disabled={busyId === row.id}>
                存疑
              </Button>
            </Popconfirm>
          </Space>
        ) : (
          <Space size={6}>
            <Button
              size="small"
              type="primary"
              icon={<CheckOutlined />}
              loading={busyId === row.id}
              onClick={() => void decide(row, "approve")}
            >
              放行
            </Button>
            <Popconfirm
              title="拦截这条动作？"
              description="拦截后该高危动作不会执行，并记入审计流。"
              okText="拦截"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => void decide(row, "deny")}
            >
              <Button size="small" danger icon={<CloseOutlined />} disabled={busyId === row.id}>
                拦截
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  const summary = data?.summary;
  const scan = data?.scan;

  const gatePendingCount = allItems.filter((i) => i.status === "pending" && !isAuditApproval(i)).length;
  const auditPendingCount = allItems.filter((i) => i.status === "pending" && isAuditApproval(i)).length;

  /**
   * 页面结论条：真实说清待放行与待核验的分别
   */
  const conclusion: PageConclusionView =
    error !== null
      ? {
          tone: "offline",
          title: "审批服务暂时读不到",
          copy: error,
          action: <Button onClick={refresh}>重试</Button>,
        }
      : data === null
        ? { tone: "unknown", title: "正在读取审批单", copy: "刚打开页面，稍等片刻。" }
        : gatePendingCount > 0 && auditPendingCount > 0
          ? {
              tone: "warn",
              title: `有 ${gatePendingCount} 条动作等待放行，另有 ${auditPendingCount} 条高危异动待核验`,
              copy: "待放行单正阻塞执行，超时将自动拦截；事后核验单已由 Hermes 执行，可确认已知或设为拉黑阻断。",
            }
          : gatePendingCount > 0
            ? {
                tone: "warn",
                title: `有 ${gatePendingCount} 条动作正在等待你批准放行（阻塞执行中）`,
                copy: "管家已拦截此高危动作，15 分钟内不处理将按拒绝拦截。",
              }
            : auditPendingCount > 0
              ? {
                  tone: "warn",
                  title: `有 ${auditPendingCount} 条高危异动待核验（动作已由 Hermes 执行）`,
                  copy: "这是事后发现的高危行为留痕。点击「已知」确认归档，或选择「存疑并阻断」将指纹永久拉黑。",
                }
              : summary !== undefined && summary.expired > 0
                ? {
                    tone: "unknown",
                    title: `近窗口有 ${summary.expired} 条超时已关闭`,
                    copy: "超时条目已自动归档结案；事前放行类已被系统拦截，事后核验类已归档可查审计流。",
                  }
                : {
                    tone: "ok",
                    title: "当前没有待处理的审批或异动",
                    copy:
                      summary !== undefined && summary.total > 0
                        ? `近窗口共 ${summary.total} 条均已处理（已放行/已知 ${summary.approved} / 已拦截/存疑 ${summary.denied}）。`
                        : "近期没有高危动作需要你点头。",
                  };

  const stats: StatStripItem[] =
    summary === undefined
      ? []
      : [
          {
            key: "pending",
            icon: ClockCircleOutlined,
            label: "待处理",
            value: summary.pending,
            tone: summary.pending > 0 ? "warn" : undefined,
            sub: gatePendingCount > 0 ? `${gatePendingCount} 待放行 / ${auditPendingCount} 待核验` : "需确认或拦截",
          },
          {
            key: "escalated",
            icon: SafetyCertificateOutlined,
            label: "需面板确认",
            value: summary.escalated,
            tone: summary.escalated > 0 ? "warn" : undefined,
            sub: "一键放行不生效",
          },
          {
            key: "approved",
            icon: CheckCircleOutlined,
            label: "已放行 / 已知",
            value: summary.approved,
            tone: "ok",
            sub: "已批准执行或确认已知",
          },
          {
            key: "denied",
            icon: CloseCircleOutlined,
            label: "已拦截 / 存疑",
            value: summary.denied,
            sub: "已拒绝或存疑留痕",
          },
          {
            key: "expired",
            icon: StopOutlined,
            label: "超时关闭",
            value: summary.expired,
            tone: summary.expired > 0 ? "warn" : undefined,
            sub: "放行类拦截 / 异动自动关闭",
          },
        ];

  return (
    <section className="approvals-page">
      <Flex vertical gap={16}>
        <PageHeader
          title="操作审批"
          description="区分事前放行与事后核验：gate 类动作阻塞等待放行；audit 类动作为 Hermes 已执行的高危异动，供核验与处置。15 分钟未处理自动关闭。"
          extra={
            <Space>
              <Button
                icon={<SafetyCertificateOutlined />}
                onClick={() => {
                  setRulesOpen(true);
                  loadRules();
                }}
              >
                指纹规则库 {rules.length > 0 ? `(${rules.length})` : ""}
              </Button>
              <Button icon={<ReloadOutlined />} onClick={refresh}>
                刷新
              </Button>
            </Space>
          }
        />

        {/* 结论条 */}
        <ConclusionBar tone={conclusion.tone} title={conclusion.title} copy={conclusion.copy} action={conclusion.action} />

        <StatStrip items={stats} />

        {scan !== undefined && (
          <AdvancedDetails
            summary="高危保护机制与异动侦测规则"
            storageKey="approvals.protection-policy"
          >
            <Flex vertical gap={6} className="text-xs md:text-sm text-on-surface-variant">
              <div>
                <strong>时限与升级：</strong>15 分钟未应答自动结案，同一动作第 {scan.escalationThreshold} 次触发强制面板确认。
              </div>
              <div>
                <strong>异动自动侦测：</strong>{scan.enabled ? "开启" : "关闭"}（侦测到高危动作即自动开单）
                {scan.lastScanAt !== null && ` · 上次扫描 ${new Date(scan.lastScanAt).toLocaleTimeString()}`}
              </div>
              <div>
                <strong>审计留存：</strong>记录保留 {scan.retentionDays} 天；放行、拦截、核验与规则变动全部记入审计流与信任事件。
              </div>
            </Flex>
          </AdvancedDetails>
        )}

        <Card
          title="审批与核验列表"
          extra={
            <Flex gap={10} wrap="wrap" align="center">
              <Segmented
                options={[
                  { label: "全部类别", value: "all" },
                  { label: "待放行", value: "gate" },
                  { label: "异动核验", value: "audit" },
                ]}
                value={category}
                onChange={(value: unknown) => setCategory(String(value))}
              />
              <Segmented
                options={[
                  { label: "待处理", value: "pending" },
                  { label: "需面板确认", value: "escalated" },
                  { label: "全部状态", value: "all" },
                ]}
                value={filter}
                onChange={(value: unknown) => setFilter(String(value))}
              />
              <Segmented
                options={[
                  { label: "近 24 小时", value: "24h" },
                  { label: "近 3 天", value: "3d" },
                  { label: "全部时间", value: "all" },
                ]}
                value={timeWindow}
                onChange={(value: unknown) => setTimeWindow(String(value))}
              />
              {pendingInView.length > 0 && (
                <Space size={8}>
                  <Popconfirm
                    title={
                      hasGateInPending
                        ? `确认全部放行当前 ${pendingInView.length} 条动作？`
                        : `确认将当前 ${pendingInView.length} 条异动全部标记为已知？`
                    }
                    description={
                      hasGateInPending
                        ? "列表中含有阻塞等待中的动作，批准后将通知执行器放行。"
                        : "动作已由 Hermes 执行，点击全部已知将这些异动确认归档并记入审计。"
                    }
                    okText={hasGateInPending ? "全部放行" : "全部已知"}
                    cancelText="取消"
                    onConfirm={() => void handleBulkDecide("approve")}
                  >
                    <Button size="small" type="primary" loading={bulkBusy}>
                      {hasGateInPending ? `全部放行 (${pendingInView.length})` : `全部已知 (${pendingInView.length})`}
                    </Button>
                  </Popconfirm>
                  <Popconfirm
                    title={
                      hasGateInPending
                        ? `确认全部拦截当前 ${pendingInView.length} 条动作？`
                        : `确认将当前 ${pendingInView.length} 条异动全部标记为存疑？`
                    }
                    description={
                      hasGateInPending
                        ? "拦截后这些高危动作不会被执行，并将作为拦截事件记入审计流。"
                        : "标记存疑后将保留警示记录，便于后续追溯与核查。"
                    }
                    okText={hasGateInPending ? "全部拦截" : "全部存疑"}
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => void handleBulkDecide("deny")}
                  >
                    <Button size="small" danger loading={bulkBusy}>
                      {hasGateInPending ? `全部拦截 (${pendingInView.length})` : `全部存疑 (${pendingInView.length})`}
                    </Button>
                  </Popconfirm>
                </Space>
              )}
            </Flex>
          }
        >
          {hiddenByTimeCount > 0 && (
            <Alert
              type="info"
              showIcon
              message={
                <span>
                  当前视图已折叠近 {timeWindow === "24h" ? "24 小时" : "3 天"} 之前的 <strong>{hiddenByTimeCount}</strong> 条历史记录。{" "}
                  <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setTimeWindow("all")}>
                    查看全部时间
                  </Button>
                </span>
              }
              style={{ marginBottom: 12 }}
            />
          )}

          {data !== null && filteredItems.length === 0 ? (
            <Empty
              title={
                filter === "pending"
                  ? "当前筛选下没有待处理项"
                  : "当前窗口内没有匹配的记录"
              }
              hint="可尝试切换类别、状态或时间窗口查看更多。"
              mascotWidth={72}
            />
          ) : (
            <Table<ApprovalItem>
              rowKey="id"
              columns={columns}
              dataSource={filteredItems}
              loading={data === null}
              pagination={{ pageSize: 20, showSizeChanger: false }}
              scroll={{ x: 1300 }}
            />
          )}
        </Card>

        {/* 动作指纹规则库抽屉 */}
        <Drawer
          title="动作指纹规则库"
          placement="right"
          width={700}
          open={rulesOpen}
          onClose={() => setRulesOpen(false)}
          extra={
            <Button icon={<ReloadOutlined />} onClick={loadRules} size="small" loading={rulesLoading}>
              刷新
            </Button>
          }
        >
          <Flex vertical gap={16}>
            <Alert
              type="info"
              showIcon
              message="指纹规则闭环"
              description="在审批详情中选择「存疑并拉黑」或「信任免核验」时，动作指纹将自动沉淀为规则。被阻断的指纹未来触发时直接拦截；被信任的指纹事后自动放行归档，不再产生待核验卡片打扰。"
            />
            <Table<ActionFingerprintRule>
              rowKey="fingerprint"
              dataSource={rules}
              loading={rulesLoading}
              pagination={{ pageSize: 10 }}
              columns={[
                {
                  title: "规则类型",
                  dataIndex: "rule",
                  key: "rule",
                  width: 120,
                  render: (r: string) =>
                    r === "block" ? (
                      <Tag color="error">阻断拦截</Tag>
                    ) : (
                      <Tag color="success">信任免核验</Tag>
                    ),
                },
                {
                  title: "动作类型",
                  dataIndex: "kind",
                  key: "kind",
                  width: 100,
                  render: (kind: string) => KIND_LABEL[kind] ?? kind,
                },
                {
                  title: "目标",
                  dataIndex: "target",
                  key: "target",
                  ellipsis: true,
                  render: (t: string) => <Typography.Text code>{t}</Typography.Text>,
                },
                {
                  title: "生效原因",
                  dataIndex: "reason",
                  key: "reason",
                  ellipsis: true,
                  render: (r: string | undefined) => r || "—",
                },
                {
                  title: "操作",
                  key: "action",
                  width: 90,
                  render: (_: unknown, ruleRow) => (
                    <Popconfirm
                      title="确定解除该规则？"
                      description="解除后该动作将恢复默认的审批核验流程。"
                      okText="解除"
                      cancelText="取消"
                      onConfirm={() => void removeRule(ruleRow.fingerprint)}
                    >
                      <Button size="small" type="link" danger>
                        解除
                      </Button>
                    </Popconfirm>
                  ),
                },
              ]}
            />
          </Flex>
        </Drawer>
      </Flex>
    </section>
  );
}
