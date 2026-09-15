/**
 * 审批确认页（Trust Layer M3.1）：通知卡片降级链接的落地页。
 *
 * 这是「在地铁上点一下就完事」的兜底路径——不支持内联按钮的通道（微信/邮件/Bark）
 * 把用户带到这里；具备内联按钮的通道（Telegram）则可在通知里直接处理。
 *
 * 三条必须在 UI 上说清的规则：
 * 1. 批准一次只对「这一条动作」有效，不是长期授权；
 * 2. gate 单超时按默认拒绝拦截；audit 单（自动发现的事后确认）超时自动关闭；
 * 3. 已升级的单必须在本页确认（通道侧一键放行会被服务端拒绝）。
 *
 * gate/audit 两类确认的文案分流见 ./helpers.ts。
 */
import { Alert, Button, Card, Descriptions, Flex, Result, Space, Statistic, Tag, Typography } from "antd";
import { CheckOutlined, CloseOutlined, ReloadOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ConclusionBar } from "../../components/ConclusionBar.js";
import type { PageConclusionView } from "../../components/ConclusionBar.js";
import { Empty } from "../../components/Empty.js";
import { PageHeader } from "../../components/PageHeader.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { approvalStatusLabel, approvalStatusTone, isAuditApproval } from "./helpers.js";
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

/** 决策失败的友好文案：409/410 是「已经晚了」，不是系统故障。 */
const DECIDE_FAILURE: Record<string, string> = {
  "not-found": "该审批单已不存在（可能已被清理）",
  "already-settled": "该审批单已被处理，或已升级为需在面板确认",
  expired: "已超时：放行类单已被系统按拒绝拦截，事后确认类已自动关闭",
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
      // 成功提示按来源分流：audit 单是表态（追认/存疑），gate 单才是放行/拦截。
      const auditNow = item === null ? false : isAuditApproval(item);
      const result = await postJson(`/api/approvals/${encodeURIComponent(id)}/decide`, {
        decision,
        actor: "panel-user",
        channel: "panel",
      }, 30_000);
      setBusy(false);
      if (result.ok) {
        setNotice(
          auditNow
            ? decision === "approve"
              ? "已追认该动作"
              : "已将该动作标记存疑"
            : decision === "approve"
              ? "已批准本次操作"
              : "已拒绝本次操作",
        );
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
        <PageHeader title="操作审批" />
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
        <PageHeader title="操作审批" />
        <Card loading />
      </section>
    );
  }

  const meta = approvalStatusTone(item.status);
  const pending = item.status === "pending";
  const audit = isAuditApproval(item);
  const detail = typeof item.detail === "object" && item.detail !== null
    ? (item.detail as Record<string, unknown>)
    : {};

  /**
   * 页面结论条（规范 03 §2.3 ②「必须有」）：随终态切换，一句话说清「这条单现在什么状态、接下来会发生什么」。
   * gate/audit 分流：audit 单的动作已执行，全程不出现「拦截/放行」字样。
   */
  const conclusion: PageConclusionView =
    item.status === "pending"
      ? audit
        ? {
            tone: "warn",
            title: "该高危动作已执行，等你确认",
            copy: `这是事后确认（不阻塞执行）：追认表示已知悉，存疑标记待核查；15 分钟不处理自动关闭${
              item.escalateRequired ? "；此单已升级，必须在面板确认" : ""
            }。`,
          }
        : {
            tone: "warn",
            title: "等待你处置这条高危动作",
            copy: `批准只对该动作本次生效；15 分钟不处理按拒绝拦截${
              item.escalateRequired ? "；此单已升级，必须在面板确认" : ""
            }。`,
          }
      : item.status === "approved"
        ? audit
          ? { tone: "ok", title: "已追认该动作", copy: "追认表示已知悉这条已执行的动作，不改动后续审批要求。" }
          : { tone: "ok", title: "已批准本次操作", copy: "放行只针对这一条动作，不改动后续审批要求。" }
        : item.status === "denied"
          ? audit
            ? { tone: "error", title: "已将该动作标记存疑", copy: "动作已执行，存疑表示待核查；明细可在审计流查看。" }
            : { tone: "error", title: "已拒绝本次操作", copy: "该动作被拦下，不会执行。" }
          : audit
            ? {
                tone: "error",
                title: "超时未处理，已自动关闭",
                copy: item.reason ?? "15 分钟内没有确认——动作本身已执行，明细可在审计流查看。",
              }
            : {
                tone: "error",
                title: "已超时，系统按默认拒绝拦截",
                copy: item.reason ?? "15 分钟内没有人应答——管家宁可拦住，也不冒险放行。",
              };

  return (
    <section className="approval-detail-page">
      <Flex vertical gap={16}>
        <PageHeader
          title="操作审批"
          extra={
            <Space>
              <Button icon={<ReloadOutlined />} onClick={refresh}>
                刷新
              </Button>
              <Button onClick={() => navigate("/approvals")}>返回列表</Button>
            </Space>
          }
        />

        {/* §2.3 ② 结论条。 */}
        <ConclusionBar tone={conclusion.tone} title={conclusion.title} copy={conclusion.copy} />

        {notice !== null && <Alert type="info" showIcon title={notice} />}

        {pending && item.escalateRequired && (
          <Alert
            type="warning"
            showIcon
            message={`该动作今日已被请求 ${item.windowCount} 次，已升级为需在面板确认`}
            description="同一动作被反复请求时，一键放行会失效。请在本页核对目标后再决定。"
          />
        )}

        <Card>
          <Flex vertical gap={16}>
            <Flex gap={16} wrap="wrap" align="center">
              <StatusBadge tone={meta} label={approvalStatusLabel(item.status, audit)} />
              <Tag>{KIND_LABEL[item.kind] ?? item.kind}</Tag>
              {audit && <StatusBadge tone="unknown" label="事后确认" />}
              {item.escalateRequired && <StatusBadge tone="warn" label="需面板确认" />}
              {item.channel !== null && item.channel !== "" && (
                <Typography.Text type="secondary">来源通道：{item.channel}</Typography.Text>
              )}
            </Flex>

            <Typography.Title level={4} style={{ margin: 0 }}>
              {item.title}
            </Typography.Title>

            {pending && (
              <Statistic
                title={audit ? "剩余处理时限（超时未处理将自动关闭）" : "剩余处理时限（超时按拒绝拦截）"}
                value={Math.max(0, Math.round(item.remainingMs / 1000))}
                suffix="秒"
                valueStyle={item.remainingMs < 120_000 ? { color: "var(--ab-error)" } : undefined}
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
              <Descriptions.Item label="今日请求次数">{item.windowCount}</Descriptions.Item>
              <Descriptions.Item label="应答者">{item.actor ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="关联动作">{item.actionId}</Descriptions.Item>
              <Descriptions.Item label="会话">{item.sessionId ?? "—"}</Descriptions.Item>
            </Descriptions>

            {Object.keys(detail).length > 1 && (
              <details>
                <summary style={{ cursor: "pointer" }}>
                  <Typography.Text type="secondary">查看结构化摘要（已脱敏，不含对话正文）</Typography.Text>
                </summary>
                <pre style={{ marginTop: 8, maxHeight: 240, overflow: "auto", fontSize: "var(--ab-text-size-xs)" }}>
                  {JSON.stringify(detail, null, 2)}
                </pre>
              </details>
            )}

            {pending ? (
              audit ? (
                <Flex gap={12}>
                  <Button
                    type="primary"
                    size="large"
                    icon={<CheckOutlined />}
                    loading={busy}
                    onClick={() => void decide("approve")}
                  >
                    追认
                  </Button>
                  <Button danger size="large" icon={<CloseOutlined />} loading={busy} onClick={() => void decide("deny")}>
                    存疑
                  </Button>
                </Flex>
              ) : (
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
              )
            ) : (
              <Empty
                mascotWidth={72}
                title={item.respondedAt === null ? "该审批单已终结" : `${approvalStatusLabel(item.status, audit)} · ${new Date(item.respondedAt).toLocaleString()}`}
                hint="这不是待处理状态，不能再做决定。"
              />
            )}

            {pending && (
              <Alert
                type="info"
                showIcon
                message={audit ? "「追认 / 存疑」的含义" : "「批准一次」的含义"}
                description={
                  audit
                    ? "动作已由 Hermes 执行，这里的表态只是知悉记录：追认表示已知悉，存疑表示待核查；都不会改变已发生的事，也不给 agent 长期授权。"
                    : "只对当前这一条动作生效，不会给 agent 长期授权，也不改变后续动作的审批要求。"
                }
              />
            )}
          </Flex>
        </Card>
      </Flex>
    </section>
  );
}
