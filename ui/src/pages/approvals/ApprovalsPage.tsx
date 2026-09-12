/**
 * 操作审批列表（Trust Layer M3.1）：
 * - 结论条：一句话说清「有多少待你处理、多少已超时拦截」这两个最关键信号；
 * - 概览：待处理 / 需面板确认 / 已批准 / 已拒绝 / 超时拦截（StatStrip，色走品牌语义）；
 * - 过滤：全部 / 仅待处理 / 仅已升级；
 * - 表格：动作类型 + 目标 + 剩余时限倒计时 + 状态，点击进入 /approvals/:id 确认页。
 *
 * 数据真相原则：卡片里绝不出现对话正文——审批只针对「动作」，不看 agent 说了什么。
 */
import { Alert, Button, Card, Flex, Segmented, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ConclusionBar } from "../../components/ConclusionBar.js";
import type { PageConclusionView } from "../../components/ConclusionBar.js";
import { Empty } from "../../components/Empty.js";
import { PageHeader } from "../../components/PageHeader.js";
import { StatStrip } from "../../components/StatStrip.js";
import type { StatStripItem } from "../../components/StatStrip.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import type { SemanticTone } from "../../components/StatusBadge.js";
import { loadJson } from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";
import { useUrlState } from "../../hooks/useUrlState.js";

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
  attempts: number;
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

/** 状态 → 品牌语义 tone（antd 预设色名 processing/green/red/default 与品牌信号色不是同一值，统一走 StatusBadge）。 */
const STATUS_TONE: Record<string, SemanticTone> = {
  pending: "warn",
  approved: "ok",
  denied: "error",
  expired: "error",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "待处理",
  approved: "已批准",
  denied: "已拒绝",
  expired: "超时拦截",
};

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
  if (item.status !== "pending") return "—";
  if (item.remainingMs <= 0) return "即将超时";
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
  return item.fingerprint.split("|")[1] ?? "—";
};

export function ApprovalsPage() {
  const [data, setData] = useState<ApprovalsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 过滤同步到 URL（规范 03 §3.12）：刷新/分享能还原同一视图（评审 P1-7）。
  const [filter, setFilter] = useUrlState<string>("filter", "pending");

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

  useEffect(() => {
    refresh();
  }, [refresh]);
  // 15s 轮询：与后端超时结算节奏对齐，倒计时不会与真实状态脱节太久。
  usePolling(refresh, 15_000);

  const columns: ColumnsType<ApprovalItem> = [
    {
      title: "动作",
      dataIndex: "title",
      key: "title",
      ellipsis: true,
      render: (title: string, row) => <Link to={`/approvals/${encodeURIComponent(row.id)}`}>{title}</Link>,
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
      width: 260,
      render: (_: unknown, row) => <Typography.Text code>{detailTarget(row)}</Typography.Text>,
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 150,
      render: (status: string, row) => {
        const tone = STATUS_TONE[status] ?? "unknown";
        const label = STATUS_LABEL[status] ?? status;
        return (
          <Space size={4}>
            <StatusBadge tone={tone} label={label} />
            {row.escalateRequired && row.status === "pending" && (
              <Tooltip title={`同一动作今日已被请求 ${row.attempts} 次，需在面板确认后才可放行`}>
                <span>
                  <StatusBadge tone="warn" label="需面板确认" />
                </span>
              </Tooltip>
            )}
          </Space>
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
      title: "应答",
      key: "responded",
      width: 180,
      render: (_: unknown, row) =>
        row.respondedAt === null ? (
          <Typography.Text type="secondary">等待中</Typography.Text>
        ) : (
          <span>
            {new Date(row.respondedAt).toLocaleString()}
            {row.actor !== null && row.actor !== "" && (
              <Typography.Text type="secondary" style={{ fontSize: "var(--ab-text-size-xs)" }}>
                {" "}
                · {row.actor}
              </Typography.Text>
            )}
          </span>
        ),
    },
  ];

  const summary = data?.summary;
  const scan = data?.scan;

  /**
   * 页面结论条（规范 03 §2.3 ②「必须有」）。
   * 审批页最关键两个信号：待审批数量、超时（超时默认拒绝）。pending > 0 走 warn，
   * 并一并点出需面板确认与已超时拦截的条数；无待处理时再陈述已处理分布。
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
        : summary !== undefined && summary.pending > 0
          ? {
              tone: "warn",
              title: `有 ${summary.pending} 条待你处理${
                summary.escalated > 0 ? `，其中 ${summary.escalated} 条需面板确认` : ""
              }`,
              copy: `15 分钟内不处理会按拒绝拦住${
                summary.expired > 0 ? `；另有 ${summary.expired} 条已超时拦截` : ""
              }。点开逐条决定放行还是拦下。`,
            }
          : summary !== undefined && summary.expired > 0
            ? {
                tone: "warn",
                title: `近窗口有 ${summary.expired} 条超时拦截`,
                copy: "这些动作因你（或系统）超时未应答，已被默认拒绝；可在审计流查看明细。",
              }
            : {
                tone: "ok",
                title: "当前没有待处理的审批",
                copy:
                  summary !== undefined && summary.total > 0
                    ? `近窗口共 ${summary.total} 条均已处理（批准 ${summary.approved} / 拒绝 ${summary.denied}）。`
                    : "近期没有高危动作需要你点头。",
              };

  const stats: StatStripItem[] =
    summary === undefined
      ? []
      : [
          {
            key: "pending",
            icon: ClockCircleOutlined,
            label: "待你处理",
            value: summary.pending,
            tone: summary.pending > 0 ? "warn" : undefined,
            sub: "需点头或拒绝",
          },
          {
            key: "escalated",
            icon: SafetyCertificateOutlined,
            label: "其中需面板确认",
            value: summary.escalated,
            tone: summary.escalated > 0 ? "warn" : undefined,
            sub: "一键放行不生效",
          },
          {
            key: "approved",
            icon: CheckCircleOutlined,
            label: "已批准",
            value: summary.approved,
            tone: "ok",
            sub: "本次动作已放行",
          },
          {
            key: "denied",
            icon: CloseCircleOutlined,
            label: "已拒绝",
            value: summary.denied,
            sub: "动作被拦下",
          },
          {
            key: "expired",
            icon: StopOutlined,
            label: "超时拦截",
            value: summary.expired,
            tone: summary.expired > 0 ? "warn" : undefined,
            sub: "默认按拒绝处理",
          },
        ];

  return (
    <section className="approvals-page">
      <Flex vertical gap={16}>
        <PageHeader
          title="操作审批"
          description="agent 要删文件、跑命令或对外发消息时，先在这里确认。15 分钟不处理会按拒绝拦截。"
          extra={
            <Button icon={<ReloadOutlined />} onClick={refresh}>
              刷新
            </Button>
          }
        />

        {/* §2.3 ② 结论条。原「审批服务不可用」Alert 与离线结论同一件事，已并入此条。 */}
        <ConclusionBar tone={conclusion.tone} title={conclusion.title} copy={conclusion.copy} action={conclusion.action} />

        <StatStrip items={stats} />

        {scan !== undefined && (
          <Alert
            type="info"
            showIcon
            icon={<SafetyCertificateOutlined />}
            message={`保护已就绪：超时 ${Math.round(scan.ttlMs / 60_000)} 分钟默认拒绝，同一动作第 ${scan.escalationThreshold} 次自动升级为面板确认`}
            description={
              <Flex vertical gap={4}>
                <span>
                  自动侦测：{scan.enabled ? "开启" : "关闭"}（侦测到高危动作即自动开单）
                  {scan.lastScanAt !== null && ` · 上次扫描 ${new Date(scan.lastScanAt).toLocaleTimeString()}`}
                </span>
                <span>
                  审批单保留 {scan.retentionDays} 天；批准/拒绝/超时全部进审计流与事件中心。
                </span>
              </Flex>
            }
          />
        )}

        <Card
          title="审批单"
          extra={
            <Segmented
              options={[
                { label: "待处理", value: "pending" },
                { label: "需面板确认", value: "escalated" },
                { label: "全部", value: "all" },
              ]}
              value={filter}
              onChange={(value) => setFilter(value as string)}
            />
          }
        >
          {data !== null && data.items.length === 0 ? (
            <Empty
              title={
                filter === "pending"
                  ? "当前没有待处理的审批请求——说明 agent 没伸手去碰高危动作"
                  : "窗口内没有审批记录"
              }
              hint="换一个筛选看看，或等 agent 发起新的高危动作。"
              mascotWidth={72}
            />
          ) : (
            <Table<ApprovalItem>
              rowKey="id"
              columns={columns}
              dataSource={data?.items ?? []}
              loading={data === null}
              pagination={{ pageSize: 20, showSizeChanger: false }}
              scroll={{ x: 1150 }}
            />
          )}
        </Card>
      </Flex>
    </section>
  );
}
