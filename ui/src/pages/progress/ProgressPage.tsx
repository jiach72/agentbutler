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
import { Alert, Button, Card, Flex, Segmented, Space, Table, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined, SafetyCertificateOutlined, SyncOutlined } from "@ant-design/icons";
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
import { useUrlState } from "../../hooks/useUrlState.js";
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

/** 判定结论映射到品牌 6 档语义色（不用 antd 预设色名，预设色由算法派生、深色下对比不足）。 */
const VERDICT_TONE: Record<Verdict, SemanticTone> = {
  verified: "ok",
  suspect: "error",
  unverifiable: "offline",
};

const VERDICT_NOTE: Record<Verdict, string> = {
  verified: "声明窗口内确实产生了副作用动作",
  suspect: "观测得到该会话，但声明窗口内没有任何实际动作",
  unverifiable: "日志缺少会话归属，或该会话没有任何可观测动作——不猜测",
};

const VERDICT_LABEL: Record<Verdict, string> = {
  verified: "可信",
  suspect: "可疑",
  unverifiable: "无法验证",
};

const pct = (value: number | null): string => (value === null ? "—" : `${Math.round(value * 100)}%`);

export function ProgressPage() {
  const [data, setData] = useState<ProgressPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 筛选同步到 URL（规范 03 §3.12）：刷新/分享能还原同一视图（评审 P1-7）。
  const [filter, setFilter] = useUrlState<string>("verdict", "all");
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
      render: (verdict: Verdict) => (
        <Tooltip title={VERDICT_NOTE[verdict]}>
          <span>
            <StatusBadge tone={VERDICT_TONE[verdict]} label={VERDICT_LABEL[verdict]} />
          </span>
        </Tooltip>
      ),
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
  const suspectNamed = summary?.suspectSessions.length ?? 0;
  const scanMode = summary?.mode;

  /**
   * 页面结论条（规范 03 §2.3 ②「必须有」）。
   * 这一页的存在意义就是回答「它有没有编」，所以结论必须直接给判断（评审 P0-2）。
   */
  const conclusion: PageConclusionView =
    error !== null
      ? {
          tone: "offline",
          title: "进度核实暂时不可用",
          copy: error,
          action: <Button onClick={refresh}>重试</Button>,
        }
      : summary === undefined
        ? { tone: "unknown", title: "正在核实进度声明", copy: "管家在日志里找「已完成 X%」这类声明，再和实际动作对账。" }
        : scanMode === "no-sources"
          ? {
              tone: "unknown",
              title: "没有找到可解析的执行日志",
              copy: "进度核实依赖 Hermes 执行日志。确认实例已产生日志，或用 BUTLER_AUDIT_LOG_PATHS 指定路径。",
              action: (
                <Button type="primary" icon={<SyncOutlined />} loading={busy} onClick={() => void scan()}>
                  立即核实
                </Button>
              ),
            }
          : summary.total === 0
            ? {
                tone: "ok",
                title: "这个窗口内没有进度声明",
                copy: "没有声明就不存在「编进度」的问题；有新的声明后这里会自动出现。",
              }
            : suspectNamed > 0
              ? {
                  tone: "error",
                  title: `有 ${suspectNamed} 个会话反复声称完成却没有动作`,
                  copy: `7 天内共 ${summary.total} 条声明，其中 ${summary.suspect} 条没有实际动作佐证；下面的名单点名了连续 3 次以上的会话。`,
                  action: <Button onClick={refresh}>刷新</Button>,
                }
              : summary.suspect > 0
                ? {
                    tone: "warn",
                    title: `${summary.suspect} 条声明没有实际动作佐证`,
                    copy: `7 天内共 ${summary.total} 条声明，可信度 ${pct(summary.trustRate)}（分母只含可信 + 可疑）。`,
                  }
                : {
                    tone: "ok",
                    title: "这个窗口内的进度声明都有动作佐证",
                    copy: `7 天内共 ${summary.total} 条声明，可信度 ${pct(summary.trustRate)}。`,
                  };

  const progressStats: StatStripItem[] =
    summary === undefined
      ? []
      : [
          {
            key: "trust-rate",
            icon: SafetyCertificateOutlined,
            label: "进度可信度（7 天）",
            value: summary.trustRate === null ? "—" : Math.round(summary.trustRate * 100),
            unit: summary.trustRate === null ? undefined : "%",
            tone: summary.trustRate === null ? undefined : summary.trustRate < 0.8 ? "error" : "ok",
            sub: "分母只含「可信 + 可疑」，无法验证单列",
          },
          {
            key: "verified",
            icon: SafetyCertificateOutlined,
            label: "有动作佐证",
            value: summary.verified,
            unit: "条",
            tone: "ok",
            sub: "声明窗口内确有副作用动作",
          },
          {
            key: "suspect",
            icon: SafetyCertificateOutlined,
            label: "无动作佐证",
            value: summary.suspect,
            unit: "条",
            tone: "error",
            sub: "观测得到会话，但窗口内没有动作",
          },
          {
            key: "unverifiable",
            icon: SafetyCertificateOutlined,
            label: "无法验证",
            value: summary.unverifiable,
            unit: "条",
            sub: "日志缺少会话归属——不猜测",
          },
        ];

  return (
    <section className="progress-page">
      <Flex vertical gap={16}>
        <PageHeader
          title="进度可信度"
          description="对比 agent 声称的进度和它实际做过的动作，看看进度是不是可信。"
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

        {/* §2.3 ② 结论条：直接给「它有没有编」的判断。 */}
        <ConclusionBar
          tone={conclusion.tone}
          title={conclusion.title}
          copy={conclusion.copy}
          action={conclusion.action}
        />

        <StatStrip items={progressStats} />


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
                <Link
                  key={row.sessionId}
                  to={`/sessions/${encodeURIComponent(row.sessionId)}`}
                  style={{ textDecoration: "none" }}
                >
                  <StatusBadge
                    tone="error"
                    label={`${row.sessionId} · 最长连续 ${row.maxSuspectStreak} 次 · 可信度 ${pct(row.trustRate)}`}
                  />
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
              onChange={(value) => setFilter(value as string)}
            />
          }
        >
          {data !== null && data.claims.length === 0 ? (
            <Empty
              title={summary?.mode === "no-sources" ? "没有日志源，暂时无法核实" : "窗口内没有可核实的进度声明"}
              hint={
                summary?.mode === "no-sources"
                  ? "确认实例已产生执行日志，或用 BUTLER_AUDIT_LOG_PATHS 指定日志路径。"
                  : "换个筛选看看，或等 agent 产生新的进度声明。"
              }
              mascotWidth={72}
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
