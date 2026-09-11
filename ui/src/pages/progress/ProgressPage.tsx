/**
 * 进度可信度页（Trust Layer M3.3）——差异化王牌的门面。
 *
 * 用户故事：agent 说「已完成 65%」时，我想知道它是真的在做还是编的。
 *
 * 三条呈现原则：
 * 1. 三态分立：✓ 有实际动作佐证 / ？无动作佐证（可疑）/ 「无法验证」（观测不到，单列）；
 * 2. 可信度分母**只含** verified + suspect——把「无法验证」塞进分母等于把「不知道」
 *    算成「不诚实」，那本身就是在制造新的信任问题；
 * 3. 每一条判定都给出理由与副作用明细，用户可以自己复核，不用信我们。
 */
import { Alert, Button, Card, Empty, Flex, Segmented, Space, Statistic, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined, SafetyCertificateOutlined, SyncOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../../components/PageHeader.js";
import { loadJson, postJson } from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";

type Verdict = "verified" | "suspect" | "unverifiable";

interface Claim {
  id: number;
  sessionId: string;
  ts: string;
  claimedPct: number | null;
  claimText: string;
  sideEffectCount: number;
  sideEffectKinds: string[];
  verdict: Verdict;
  reason: string | null;
}

interface SuspectSession {
  sessionId: string;
  total: number;
  verified: number;
  suspect: number;
  unverifiable: number;
  maxSuspectStreak: number;
  lastClaimAt: string;
  trustRate: number | null;
}

interface ProgressPayload {
  summary: {
    windowDays: number;
    total: number;
    verified: number;
    suspect: number;
    unverifiable: number;
    trustRate: number | null;
    suspectSessions: SuspectSession[];
    lastScanAt: string | null;
    sources: Array<{ path: string; parsedBytes: number; lastParsedAt: string | null }>;
    mode: "scanning" | "no-sources";
  };
  claims: Claim[];
}

const VERDICT_META: Record<Verdict, { color: string; mark: string; label: string; note: string }> = {
  verified: { color: "green", mark: "✓", label: "可信", note: "声明窗口内确实产生了副作用动作" },
  suspect: { color: "red", mark: "？", label: "可疑", note: "观测得到该会话，但声明窗口内没有任何实际动作" },
  unverifiable: {
    color: "default",
    mark: "—",
    label: "无法验证",
    note: "日志缺少会话归属，或该会话没有任何可观测动作——不猜测",
  },
};

const pct = (value: number | null): string => (value === null ? "—" : `${Math.round(value * 100)}%`);

export function ProgressPage() {
  const [data, setData] = useState<ProgressPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | Verdict>("all");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    const params = new URLSearchParams({ windowDays: "7", limit: "300" });
    if (filter !== "all") params.set("verdict", filter);
    void loadJson<ProgressPayload>(`/api/progress?${params.toString()}`, 20_000).then((result) => {
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
  usePolling(refresh, 30_000);

  const scan = useCallback(async () => {
    setBusy(true);
    await postJson("/api/progress/scan", {}, 60_000);
    setBusy(false);
    refresh();
  }, [refresh]);

  const columns: ColumnsType<Claim> = [
    {
      title: "结论",
      dataIndex: "verdict",
      key: "verdict",
      width: 110,
      render: (verdict: Verdict) => {
        const meta = VERDICT_META[verdict];
        return (
          <Tooltip title={meta.note}>
            <Tag color={meta.color}>
              {meta.mark} {meta.label}
            </Tag>
          </Tooltip>
        );
      },
    },
    {
      title: "会话",
      dataIndex: "sessionId",
      key: "sessionId",
      width: 170,
      ellipsis: true,
      render: (sessionId: string) =>
        sessionId === "(unattributed)" ? (
          <Typography.Text type="secondary">（未归属）</Typography.Text>
        ) : (
          <Link to={`/sessions/${encodeURIComponent(sessionId)}`}>{sessionId}</Link>
        ),
    },
    {
      title: "声称进度",
      dataIndex: "claimedPct",
      key: "claimedPct",
      width: 100,
      render: (value: number | null) => (value === null ? "已完成" : `${value}%`),
    },
    {
      title: "实际动作佐证",
      key: "effects",
      width: 200,
      render: (_: unknown, row) =>
        row.sideEffectCount === 0 ? (
          <Typography.Text type="danger">无</Typography.Text>
        ) : (
          <Tooltip title={row.sideEffectKinds.join(" / ")}>
            <span>{row.sideEffectCount} 个副作用动作</span>
          </Tooltip>
        ),
    },
    {
      title: "判定理由",
      dataIndex: "reason",
      key: "reason",
      ellipsis: true,
      render: (reason: string | null) => reason ?? "—",
    },
    {
      title: "时间",
      dataIndex: "ts",
      key: "ts",
      width: 165,
      render: (value: string) => new Date(value).toLocaleString(),
    },
  ];

  const summary = data?.summary;

  return (
    <section className="progress-page">
      <Flex vertical gap={16}>
        <PageHeader
          eyebrow="信任层"
          title="进度可信度"
          description="它说「已完成 65%」的时候，是真的在做，还是只是嘴上说说——这里给你答案。"
          extra={
            <Space>
              <Button icon={<ReloadOutlined />} onClick={refresh}>
                刷新
              </Button>
              <Tooltip title="立即增量采集日志中的进度声明并与实际动作对账">
                <Button type="primary" icon={<SyncOutlined />} loading={busy} onClick={() => void scan()}>
                  立即核实
                </Button>
              </Tooltip>
            </Space>
          }
        />

        {error !== null && <Alert type="warning" showIcon message="进度检测不可用" description={error} />}

        {summary !== undefined && summary.mode === "no-sources" && (
          <Alert
            type="info"
            showIcon
            message="没有找到可解析的执行日志"
            description="进度核实依赖 Hermes 执行日志。请确认实例已产生日志，或用 BUTLER_AUDIT_LOG_PATHS 显式指定路径。"
          />
        )}

        {summary !== undefined && (
          <Flex gap={16} wrap="wrap">
            <Card style={{ flex: "1 1 200px" }}>
              <Statistic
                title="进度可信度（7 天）"
                value={summary.trustRate === null ? "—" : Math.round(summary.trustRate * 100)}
                suffix={summary.trustRate === null ? "" : "%"}
                valueStyle={
                  summary.trustRate !== null && summary.trustRate < 0.8 ? { color: "#cf1322" } : { color: "#389e0d" }
                }
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                分母只含「可信 + 可疑」，无法验证单列
              </Typography.Text>
            </Card>
            <Card style={{ flex: "1 1 140px" }}>
              <Statistic title="✓ 有动作佐证" value={summary.verified} valueStyle={{ color: "#389e0d" }} />
            </Card>
            <Card style={{ flex: "1 1 140px" }}>
              <Statistic title="？ 无动作佐证" value={summary.suspect} valueStyle={{ color: "#cf1322" }} />
            </Card>
            <Card style={{ flex: "1 1 140px" }}>
              <Statistic title="— 无法验证" value={summary.unverifiable} />
            </Card>
          </Flex>
        )}

        {summary !== undefined && summary.suspectSessions.length > 0 && (
          <Card
            size="small"
            title={
              <Space>
                <SafetyCertificateOutlined />
                <span>需要点名的会话（连续 3 次以上声明进度但无实际动作）</span>
              </Space>
            }
          >
            <Flex gap={8} wrap="wrap">
              {summary.suspectSessions.map((row) => (
                <Link key={row.sessionId} to={`/sessions/${encodeURIComponent(row.sessionId)}`}>
                  <Tag color="red">
                    {row.sessionId} · 最长连续 {row.maxSuspectStreak} 次 · 可信度 {pct(row.trustRate)}
                  </Tag>
                </Link>
              ))}
            </Flex>
          </Card>
        )}

        <Card
          title="进度声明核实明细"
          extra={
            <Segmented
              options={[
                { label: "全部", value: "all" },
                { label: "可疑", value: "suspect" },
                { label: "可信", value: "verified" },
                { label: "无法验证", value: "unverifiable" },
              ]}
              value={filter}
              onChange={(value) => setFilter(value as "all" | Verdict)}
            />
          }
        >
          {data !== null && data.claims.length === 0 ? (
            <Empty
              description={
                summary?.mode === "no-sources"
                  ? "没有日志源，暂时无法核实"
                  : "窗口内没有可核实的进度声明"
              }
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          ) : (
            <Table<Claim>
              rowKey="id"
              columns={columns}
              dataSource={data?.claims ?? []}
              loading={data === null}
              pagination={{ pageSize: 20, showSizeChanger: false }}
              scroll={{ x: 1000 }}
            />
          )}
        </Card>

        {summary !== undefined && (
          <Alert
            type="info"
            showIcon
            message="判定口径（可自行复核）"
            description={
              <Flex vertical gap={2}>
                <span>✓ 可信：声明与上一条声明之间，该会话产生了写文件/删文件/执行命令/调接口/发消息/抓页面之一。</span>
                <span>？ 可疑：该会话有动作记录（说明能观测到），但这一段窗口内没有任何副作用动作。</span>
                <span>— 无法验证：日志行没有会话标识，或该会话完全没有动作记录——此时不猜测。</span>
                <span>隐私：只读动作元数据与脱敏片段，绝不采集对话正文。</span>
              </Flex>
            }
          />
        )}
      </Flex>
    </section>
  );
}
