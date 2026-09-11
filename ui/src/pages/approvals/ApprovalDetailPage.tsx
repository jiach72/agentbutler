/**
 * 审批确认页（Trust Layer M3.1）：通知卡片降级链接的落地页。
 *
 * 这是「在地铁上点一下就完事」的兜底路径——不支持内联按钮的通道（微信/邮件/Bark）
 * 把用户带到这里；具备内联按钮的通道（Telegram）则可在通知里直接处理。
 *
 * 三条必须在 UI 上说清的规则：
 * 1. 批准一次只对「这一条动作」有效，不是长期授权；
 * 2. 超时未处理按默认拒绝拦截，绝不因沉默而放行；
 * 3. 已升级的单必须在本页确认（通道侧一键放行会被服务端拒绝）。
 */
import { Alert, Button, Card, Descriptions, Empty, Flex, Result, Space, Statistic, Tag, Typography } from "antd";
import { CheckOutlined, CloseOutlined, ReloadOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../../components/PageHeader.js";
import { loadJson, postJson } from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";
import type { ApprovalItem } from "./ApprovalsPage.js";

const KIND_LABEL: Record<string, string> = {
  "file-delete": "删除文件",
  "file-write": "写入文件",
  "shell-exec": "执行命令",
  "message-send": "外发消息",
  "api-call": "调用接口",
  "web-fetch": "抓取页面",
  raw: "未归类动作",
};

const STATUS_META: Record<string, { color: string; label: string }> = {
  pending: { color: "processing", label: "待处理" },
  approved: { color: "green", label: "已批准" },
  denied: { color: "red", label: "已拒绝" },
  expired: { color: "default", label: "超时拦截" },
};

/** 决策失败的友好文案：409/410 是「已经晚了」，不是系统故障。 */
const DECIDE_FAILURE: Record<string, string> = {
  "not-found": "该审批单已不存在（可能已被清理）",
  "already-settled": "该审批单已被处理，或已升级为需在面板确认",
  expired: "已超时，系统按默认拒绝拦截了该动作",
  "approvals-unavailable": "审批服务未启用",
};

export function ApprovalDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [item, setItem] = useState<ApprovalItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (id === "") return;
    void loadJson<{ item: ApprovalItem }>(`/api/approvals/${encodeURIComponent(id)}`, 20_000).then((result) => {
      if (result.ok) {
        setItem(result.data.item);
        setError(null);
      } else {
        setError(result.reason);
      }
    });
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);
  // 仅待处理时需要轮询：一旦被通道侧抢先应答，本页应立刻反映终态。
  usePolling(() => {
    if (item === null || item.status === "pending") refresh();
  }, 10_000);

  const decide = useCallback(
    async (decision: "approve" | "deny") => {
      setBusy(true);
      setNotice(null);
      const result = await postJson(`/api/approvals/${encodeURIComponent(id)}/decide`, {
        decision,
        actor: "panel-user",
        channel: "panel",
      }, 30_000);
      setBusy(false);
      if (result.ok) {
        setNotice(decision === "approve" ? "已批准本次操作" : "已拒绝本次操作");
        refresh();
        return;
      }
      const key = typeof result.data === "object" && result.data !== null
        ? String((result.data as Record<string, unknown>)["error"] ?? "")
        : "";
      setNotice(DECIDE_FAILURE[key] ?? `操作失败（HTTP ${result.status}）`);
      refresh();
    },
    [id, refresh],
  );

  if (error !== null && item === null) {
    return (
      <section className="approval-detail-page">
        <PageHeader eyebrow="信任层" title="操作审批" description="确认一次高危动作是否放行。" />
        <Result
          status="warning"
          title="找不到这条审批记录"
          subTitle={error}
          extra={
            <Button type="primary" onClick={() => navigate("/approvals")}>
              返回审批列表
            </Button>
          }
        />
      </section>
    );
  }

  if (item === null) {
    return (
      <section className="approval-detail-page">
        <PageHeader eyebrow="信任层" title="操作审批" description="确认一次高危动作是否放行。" />
        <Card loading />
      </section>
    );
  }

  const meta = STATUS_META[item.status] ?? { color: "default", label: item.status };
  const pending = item.status === "pending";
  const detail = typeof item.detail === "object" && item.detail !== null
    ? (item.detail as Record<string, unknown>)
    : {};

  return (
    <section className="approval-detail-page">
      <Flex vertical gap={16}>
        <PageHeader
          eyebrow="信任层"
          title="确认一次高危动作"
          description="看清楚它要做什么，再决定放不放行。"
          extra={
            <Space>
              <Button icon={<ReloadOutlined />} onClick={refresh}>
                刷新
              </Button>
              <Button onClick={() => navigate("/approvals")}>返回列表</Button>
            </Space>
          }
        />

        {notice !== null && <Alert type="info" showIcon message={notice} />}

        {pending && item.escalateRequired && (
          <Alert
            type="warning"
            showIcon
            message={`该动作今日已被请求 ${item.attempts} 次，已升级为需在面板确认`}
            description="反复请求同一动作时，一键放行不再生效——请在本页核对目标后再决定，避免误触。"
          />
        )}

        {item.status === "expired" && (
          <Alert
            type="error"
            showIcon
            message="已超时，系统按默认拒绝拦截了该动作"
            description={item.reason ?? "15 分钟内没有人应答——管家宁可拦住，也不冒险放行。"}
          />
        )}

        <Card>
          <Flex vertical gap={16}>
            <Flex gap={16} wrap="wrap" align="center">
              <Tag color={meta.color} style={{ fontSize: 14, padding: "2px 10px" }}>
                {meta.label}
              </Tag>
              <Tag>{KIND_LABEL[item.kind] ?? item.kind}</Tag>
              {item.escalateRequired && <Tag color="orange">需面板确认</Tag>}
              {item.channel !== null && item.channel !== "" && (
                <Typography.Text type="secondary">来源通道：{item.channel}</Typography.Text>
              )}
            </Flex>

            <Typography.Title level={4} style={{ margin: 0 }}>
              {item.title}
            </Typography.Title>

            {pending && (
              <Statistic
                title="剩余处理时限（超时按拒绝拦截）"
                value={Math.max(0, Math.round(item.remainingMs / 1000))}
                suffix="秒"
                valueStyle={item.remainingMs < 120_000 ? { color: "#cf1322" } : undefined}
              />
            )}

            <Descriptions column={{ xs: 1, sm: 2 }} size="small" bordered>
              <Descriptions.Item label="动作类型">{KIND_LABEL[item.kind] ?? item.kind}</Descriptions.Item>
              <Descriptions.Item label="目标">
                <Typography.Text code>
                  {String(detail["target"] ?? item.fingerprint.split("|")[1] ?? "—")}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="请求时间">{new Date(item.createdAt).toLocaleString()}</Descriptions.Item>
              <Descriptions.Item label="超时时刻">{new Date(item.expiresAt).toLocaleString()}</Descriptions.Item>
              <Descriptions.Item label="今日请求次数">{item.attempts}</Descriptions.Item>
              <Descriptions.Item label="应答者">{item.actor ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="关联动作">{item.actionId}</Descriptions.Item>
              <Descriptions.Item label="会话">{item.sessionId ?? "—"}</Descriptions.Item>
            </Descriptions>

            {Object.keys(detail).length > 1 && (
              <details>
                <summary style={{ cursor: "pointer" }}>
                  <Typography.Text type="secondary">查看结构化摘要（已脱敏，不含对话正文）</Typography.Text>
                </summary>
                <pre style={{ marginTop: 8, maxHeight: 240, overflow: "auto", fontSize: 12 }}>
                  {JSON.stringify(detail, null, 2)}
                </pre>
              </details>
            )}

            {pending ? (
              <Flex gap={12}>
                <Button
                  type="primary"
                  size="large"
                  icon={<CheckOutlined />}
                  loading={busy}
                  onClick={() => void decide("approve")}
                >
                  批准一次
                </Button>
                <Button danger size="large" icon={<CloseOutlined />} loading={busy} onClick={() => void decide("deny")}>
                  拒绝
                </Button>
              </Flex>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  item.respondedAt === null
                    ? "该审批单已终结"
                    : `${meta.label} · ${new Date(item.respondedAt).toLocaleString()}`
                }
              />
            )}

            <Alert
              type="info"
              showIcon
              message="「批准一次」的含义"
              description="只对当前这一条动作生效，不会给 agent 长期授权，也不改变后续动作的审批要求。"
            />
          </Flex>
        </Card>
      </Flex>
    </section>
  );
}
