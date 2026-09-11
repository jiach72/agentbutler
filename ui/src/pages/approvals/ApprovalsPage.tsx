/**
 * 操作审批列表（Trust Layer M3.1）：
 * - 汇总卡：待处理 / 已升级（需面板确认）/ 已批准 / 已拒绝 / 超时拦截；
 * - 过滤：全部 / 仅待处理 / 仅已升级；
 * - 表格：动作类型 + 目标 + 剩余时限倒计时 + 状态，点击进入 /approvals/:id 确认页。
 *
 * 数据真相原则：卡片里绝不出现对话正文——审批只针对「动作」，不看 agent 说了什么。
 */
import { Alert, Button, Card, Empty, Flex, Segmented, Space, Statistic, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../../components/PageHeader.js";
import { loadJson } from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";

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

const STATUS_TAG: Record<string, { color: string; label: string }> = {
  pending: { color: "processing", label: "待处理" },
  approved: { color: "green", label: "已批准" },
  denied: { color: "red", label: "已拒绝" },
  expired: { color: "default", label: "超时拦截" },
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
  const [filter, setFilter] = useState<"all" | "pending" | "escalated">("pending");

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
        const meta = STATUS_TAG[status] ?? { color: "default", label: status };
        return (
          <Space size={4}>
            <Tag color={meta.color}>{meta.label}</Tag>
            {row.escalateRequired && row.status === "pending" && (
              <Tooltip title={`同一动作今日已被请求 ${row.attempts} 次，需在面板确认后才可放行`}>
                <Tag color="orange">需面板确认</Tag>
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
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
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

  return (
    <section className="approvals-page">
      <Flex vertical gap={16}>
        <PageHeader
          eyebrow="信任层"
          title="操作审批"
          description="agent 要删文件、跑命令、对外发消息时，先在这儿点头——15 分钟不处理就按拒绝拦住。"
          extra={
            <Button icon={<ReloadOutlined />} onClick={refresh}>
              刷新
            </Button>
          }
        />

        {error !== null && <Alert type="warning" showIcon message="审批服务不可用" description={error} />}

        {summary !== undefined && (
          <Flex gap={16} wrap="wrap">
            <Card style={{ flex: "1 1 160px" }}>
              <Statistic
                title="待你处理"
                value={summary.pending}
                valueStyle={summary.pending > 0 ? { color: "#d46b08" } : undefined}
              />
            </Card>
            <Card style={{ flex: "1 1 160px" }}>
              <Statistic title="其中需面板确认" value={summary.escalated} />
            </Card>
            <Card style={{ flex: "1 1 160px" }}>
              <Statistic title="已批准" value={summary.approved} valueStyle={{ color: "#389e0d" }} />
            </Card>
            <Card style={{ flex: "1 1 160px" }}>
              <Statistic title="已拒绝" value={summary.denied} />
            </Card>
            <Card style={{ flex: "1 1 160px" }}>
              <Statistic title="超时拦截" value={summary.expired} />
            </Card>
          </Flex>
        )}

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
              onChange={(value) => setFilter(value as "all" | "pending" | "escalated")}
            />
          }
        >
          {data !== null && data.items.length === 0 ? (
            <Empty
              description={
                filter === "pending"
                  ? "当前没有待处理的审批请求——说明 agent 没伸手去碰高危动作"
                  : "窗口内没有审批记录"
              }
              image={Empty.PRESENTED_IMAGE_SIMPLE}
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
